import path from "node:path";
import { rm } from "node:fs/promises";
import { runProcess } from "../runs/process.js";
import { ensureDir, exists, normalizePath, safeSegment } from "../shared/utils.js";

async function git(cwd, args, options = {}) {
  return runProcess("git", ["-C", cwd, ...args], options);
}

export async function inspectRepository(inputPath, targetBranch = "") {
  const requestedPath = normalizePath(inputPath);
  if (!(await exists(requestedPath))) throw new Error("目标项目路径不存在。 ");
  const rootResult = await git(requestedPath, ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootResult.stdout.trim());
  const [branchResult, headResult, statusResult] = await Promise.all([
    git(root, ["branch", "--show-current"], { allowFailure: true }),
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  const branch = branchResult.stdout.trim();
  const requestedBranch = String(targetBranch || branch).trim();
  if (!requestedBranch) throw new Error("当前仓库处于 detached HEAD，请明确填写目标分支。 ");
  const branchCheck = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${requestedBranch}`], { allowFailure: true });
  if (branchCheck.code !== 0) throw new Error(`目标分支 ${requestedBranch} 不存在。`);
  const baseResult = await git(root, ["rev-parse", requestedBranch]);
  const statusLines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
  return {
    requestedPath,
    root,
    branch,
    targetBranch: requestedBranch,
    head: headResult.stdout.trim(),
    baseCommit: baseResult.stdout.trim(),
    clean: statusLines.length === 0,
    changes: statusLines,
    detached: !branch
  };
}

export async function createTaskWorktree({ repository, taskId, runtimeRoot }) {
  if (!repository.clean) throw new Error("目标项目存在未提交修改，不能创建自动修改 Worktree。 ");
  const stamp = Date.now().toString(36);
  const branch = `codex/mvp0-${safeSegment(taskId, "task").slice(-24)}-${stamp}`;
  const worktreeRoot = path.join(runtimeRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, `${safeSegment(taskId)}-${stamp}`);
  await ensureDir(worktreeRoot);
  if (await exists(worktreePath)) throw new Error("Worktree 目标目录已存在。 ");
  await git(repository.root, ["worktree", "add", "-b", branch, worktreePath, repository.baseCommit]);
  return { branch, path: worktreePath, baseCommit: repository.baseCommit, createdAt: new Date().toISOString() };
}

export async function getWorktreeDiff(worktreePath) {
  const [status, diff, staged] = await Promise.all([
    git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(worktreePath, ["diff", "--no-ext-diff", "--binary"], { allowFailure: true }),
    git(worktreePath, ["diff", "--cached", "--no-ext-diff", "--binary"], { allowFailure: true })
  ]);
  return {
    status: status.stdout.split(/\r?\n/).filter(Boolean),
    diff: [diff.stdout, staged.stdout].filter(Boolean).join("\n"),
    clean: !status.stdout.trim()
  };
}

export async function commitWorktree(worktreePath, message) {
  const before = await getWorktreeDiff(worktreePath);
  if (before.clean) throw new Error("Worktree 中没有可提交的代码修改。 ");
  await git(worktreePath, ["add", "--all"]);
  await git(worktreePath, ["commit", "-m", String(message || "feat: implement captured requirement").slice(0, 200)]);
  const result = await git(worktreePath, ["rev-parse", "HEAD"]);
  return { commit: result.stdout.trim(), ...(await getWorktreeDiff(worktreePath)) };
}

export async function mergeFastForward({ repositoryPath, targetBranch, baseCommit, workBranch }) {
  const current = await inspectRepository(repositoryPath, targetBranch);
  if (!current.clean) throw new Error("目标项目工作区不干净，已停止自动合并。 ");
  if (current.branch !== targetBranch) throw new Error(`目标项目当前位于 ${current.branch || "detached HEAD"}，请先切换到 ${targetBranch}。`);
  if (current.head !== baseCommit) throw new Error("目标分支已发生变化，无法安全地 fast-forward 合并。 ");
  const ffCheck = await git(current.root, ["merge-base", "--is-ancestor", current.head, workBranch], { allowFailure: true });
  if (ffCheck.code !== 0) throw new Error("工作分支不能从目标分支 fast-forward 合并。 ");
  await git(current.root, ["merge", "--ff-only", workBranch]);
  const head = await git(current.root, ["rev-parse", "HEAD"]);
  return { mergedCommit: head.stdout.trim(), mergedAt: new Date().toISOString() };
}

export async function removeTaskWorktree(repositoryPath, worktreePath, { force = false } = {}) {
  const root = (await inspectRepository(repositoryPath)).root;
  const diff = await getWorktreeDiff(worktreePath).catch(() => ({ clean: true }));
  if (!diff.clean && !force) throw new Error("Worktree 仍有未提交修改；确认放弃后才能强制清理。 ");
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  const result = await git(root, args, { allowFailure: true });
  if (result.code !== 0 && (await exists(worktreePath))) throw new Error(result.stderr.trim() || "Worktree 清理失败。 ");
  if (await exists(worktreePath)) await rm(worktreePath, { recursive: true, force: true });
  return { cleaned: true, cleanedAt: new Date().toISOString() };
}

export { git };
