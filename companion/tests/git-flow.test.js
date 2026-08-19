import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runProcess } from "../src/runs/process.js";
import { inspectRepository, createTaskWorktree, commitWorktree, mergeFastForward, removeTaskWorktree } from "../src/projects/git.js";

async function createRepo(root) {
  await runProcess("git", ["init", "-b", "main", root]);
  await runProcess("git", ["-C", root, "config", "user.name", "Companion Test"]);
  await runProcess("git", ["-C", root, "config", "user.email", "companion@example.test"]);
  await writeFile(path.join(root, "app.txt"), "before\n", "utf8");
  await runProcess("git", ["-C", root, "add", "."]);
  await runProcess("git", ["-C", root, "commit", "-m", "initial"]);
}

test("Git 安全流程在独立 Worktree 提交并 fast-forward 合并", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aca-git-flow-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  await createRepo(repo);
  const repository = await inspectRepository(repo, "main");
  assert.equal(repository.clean, true);
  const worktree = await createTaskWorktree({ repository, taskId: "task-1", runtimeRoot: path.join(temp, "runtime") });
  assert.notEqual(path.resolve(worktree.path), path.resolve(repo));
  await writeFile(path.join(worktree.path, "app.txt"), "after\n", "utf8");
  const committed = await commitWorktree(worktree.path, "feat: update app");
  assert.match(committed.commit, /^[0-9a-f]{40}$/);
  assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "before\n");
  const merged = await mergeFastForward({ repositoryPath: repo, targetBranch: "main", baseCommit: repository.baseCommit, workBranch: worktree.branch });
  assert.equal(merged.mergedCommit, committed.commit);
  assert.equal((await readFile(path.join(repo, "app.txt"), "utf8")).replace(/\r\n/g, "\n"), "after\n");
  const cleanup = await removeTaskWorktree(repo, worktree.path);
  assert.equal(cleanup.cleaned, true);
  const branch = await runProcess("git", ["-C", repo, "show-ref", "--verify", `refs/heads/${worktree.branch}`], { allowFailure: true });
  assert.equal(branch.code, 0, "清理 Worktree 不应自动删除工作分支");
});

test("目标仓库未提交修改和分支偏移会阻止危险操作", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aca-git-guard-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  await createRepo(repo);
  const clean = await inspectRepository(repo, "main");
  await writeFile(path.join(repo, "dirty.txt"), "dirty", "utf8");
  const dirty = await inspectRepository(repo, "main");
  assert.equal(dirty.clean, false);
  await assert.rejects(() => createTaskWorktree({ repository: dirty, taskId: "dirty", runtimeRoot: path.join(temp, "runtime") }), /未提交修改/);
  await rm(path.join(repo, "dirty.txt"));
  const worktree = await createTaskWorktree({ repository: clean, taskId: "drift", runtimeRoot: path.join(temp, "runtime") });
  await writeFile(path.join(worktree.path, "app.txt"), "branch\n", "utf8");
  await commitWorktree(worktree.path, "feat: branch change");
  await writeFile(path.join(repo, "main.txt"), "main\n", "utf8");
  await runProcess("git", ["-C", repo, "add", "."]);
  await runProcess("git", ["-C", repo, "commit", "-m", "main moved"]);
  await assert.rejects(() => mergeFastForward({ repositoryPath: repo, targetBranch: "main", baseCommit: clean.baseCommit, workBranch: worktree.branch }), /发生变化/);
});
