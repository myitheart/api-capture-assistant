import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runProcess } from "../src/runs/process.js";
import { TaskStore } from "../src/tasks/store.js";
import { TaskService } from "../src/tasks/service.js";
import { ProcessCancelledError, ProcessTimeoutError } from "../src/runs/process.js";

async function waitFor(service, id, states, timeout = 15000) {
  const expected = new Set(states);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const task = await service.get(id);
    if (expected.has(task.status) && (!task.run || task.run.phase === "finished")) return task;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`等待状态 ${states.join(",")} 超时`);
}

async function createRepo(root) {
  await runProcess("git", ["init", "-b", "main", root]);
  await runProcess("git", ["-C", root, "config", "user.name", "Companion Test"]);
  await runProcess("git", ["-C", root, "config", "user.email", "companion@example.test"]);
  await writeFile(path.join(root, "feature.txt"), "old\n", "utf8");
  await runProcess("git", ["-C", root, "add", "."]);
  await runProcess("git", ["-C", root, "commit", "-m", "initial"]);
}

function delivery(repo, protocolVersion = "1.0") {
  return {
    protocolVersion,
    source: { product: "test-extension", extensionVersion: "0.8.1" },
    task: { id: "source-1", name: "修改功能", goal: "把 old 改成 new" },
    target: { projectPath: repo, targetBranch: "main", requestNote: "保持最小改动", testCommand: "" },
    evidence: { steps: [{ id: "step-1", type: "click" }], network: [], screenshots: [{ filename: "shot.jpg", base64: Buffer.from("image").toString("base64") }], attachments: [] }
  };
}

test("任务必须先只读分析，再授权 Worktree 修改、提交和合并", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aca-service-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const runtime = path.join(temp, "runtime");
  await createRepo(repo);
  const calls = [];
  const harness = {
    async run(options) {
      calls.push({ cwd: options.cwd, permissionMode: options.permissionMode, prompt: options.prompt });
      if (options.permissionMode === "workspace-write") await writeFile(path.join(options.cwd, "feature.txt"), "new\n", "utf8");
      options.onOutput?.("stdout", `${options.permissionMode} complete`);
      return { code: 0, stdout: options.permissionMode === "read-only" ? "# 分析\n建议修改 feature.txt" : "已修改 feature.txt", stderr: "" };
    }
  };
  const service = new TaskService({ store: new TaskStore(runtime), harness, runtimeRoot: runtime });
  await service.init();
  const created = await service.create(delivery(repo));
  assert.equal(created.status, "received");
  const savedEvidence = JSON.parse(await readFile(created.evidence.deliveryFile, "utf8"));
  assert.equal(savedEvidence.screenshots.length, 1);
  assert.match(savedEvidence.screenshots[0].path, /screenshots/);
  assert.equal(Object.prototype.hasOwnProperty.call(savedEvidence.screenshots[0], "base64"), false);
  await assert.rejects(() => service.modify(created.id), /只读分析/);
  await service.analyze(created.id);
  const analyzed = await waitFor(service, created.id, ["awaiting_approval", "failed"]);
  assert.equal(analyzed.status, "awaiting_approval", analyzed.failure || "分析状态异常");
  assert.equal(calls[0].permissionMode, "read-only");
  assert.equal(path.resolve(calls[0].cwd), path.resolve(repo));
  assert.equal(await readFile(path.join(repo, "feature.txt"), "utf8"), "old\n");
  await service.modify(created.id);
  const modified = await waitFor(service, created.id, ["ready_to_commit", "failed"]);
  assert.equal(modified.status, "ready_to_commit", modified.failure || "修改状态异常");
  assert.equal(calls[1].permissionMode, "workspace-write");
  assert.notEqual(path.resolve(calls[1].cwd), path.resolve(repo));
  assert.equal(await readFile(path.join(repo, "feature.txt"), "utf8"), "old\n");
  const committed = await service.commit(created.id, "feat: implement evidence");
  assert.equal(committed.status, "committed");
  const merged = await service.merge(created.id);
  assert.equal(merged.status, "merged");
  assert.equal((await readFile(path.join(repo, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"), "new\n");
});

test("协议不兼容会拒绝，脏工作区只允许只读分析", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aca-service-guard-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const runtime = path.join(temp, "runtime");
  await createRepo(repo);
  const harness = { async run() { return { code: 0, stdout: "只读结论", stderr: "" }; } };
  const service = new TaskService({ store: new TaskStore(runtime), harness, runtimeRoot: runtime });
  await service.init();
  await assert.rejects(() => service.create(delivery(repo, "9.9")), /协议不兼容/);
  await writeFile(path.join(repo, "dirty.txt"), "dirty", "utf8");
  const created = await service.create(delivery(repo));
  const repeated = await service.create(delivery(repo));
  assert.notEqual(repeated.id, created.id, "重复发送应成为两个可独立审核的本地任务");
  assert.equal(created.repository.clean, false);
  await service.analyze(created.id);
  const analyzed = await waitFor(service, created.id, ["awaiting_approval", "failed"]);
  assert.equal(analyzed.status, "awaiting_approval", analyzed.failure || "脏工作区只读分析失败");
  await assert.rejects(() => service.modify(created.id), /未提交修改/);
});

test("同一任务的只读会话支持携带现场需求进行多轮追问", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aca-service-chat-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const runtime = path.join(temp, "runtime");
  await createRepo(repo);
  const calls = [];
  const harness = {
    async run(options) {
      calls.push(options);
      return { code: 0, stdout: calls.length === 1 ? "第一轮：定位 feature.txt" : "第二轮：只检查该文件的调用方", stderr: "" };
    }
  };
  const service = new TaskService({ store: new TaskStore(runtime), harness, runtimeRoot: runtime });
  await service.init();
  const created = await service.create(delivery(repo));
  await service.analyze(created.id, "先根据录制证据定位与 old 字段有关的代码，不要全量分析项目。");
  await waitFor(service, created.id, ["awaiting_approval", "failed"]);
  await service.analyze(created.id, "继续确认这个文件有哪些直接调用方。");
  const followed = await waitFor(service, created.id, ["awaiting_approval", "failed"]);
  assert.equal(followed.status, "awaiting_approval", followed.failure);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionKind, "analysis");
  assert.equal(calls[1].sessionKind, "analysis");
  assert.match(calls[0].prompt, /录制证据|现场|old/);
  assert.match(calls[1].prompt, /直接调用方/);
  assert.doesNotMatch(calls[1].prompt, /完整扫描|全量分析/);
  assert.deepEqual(followed.conversation.map((entry) => entry.role), ["user", "assistant", "user", "assistant"]);
});

test("Headless 无输出时仍持续心跳且不会刷屏日志", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aca-service-heartbeat-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const runtime = path.join(temp, "runtime");
  await createRepo(repo);
  let finishHarness;
  let emitHarnessOutput;
  const harness = {
    run(options) {
      return new Promise((resolve) => {
        emitHarnessOutput = () => options.onOutput?.("stderr", "正在检索相关代码");
        finishHarness = () => resolve({ code: 0, stdout: "分析完成", stderr: "" });
      });
    }
  };
  const service = new TaskService({
    store: new TaskStore(runtime),
    harness,
    runtimeRoot: runtime,
    heartbeatMs: 30,
    getTimeouts: () => ({ analyze: 10000, modify: 10000, test: 10000 })
  });
  await service.init();
  const created = await service.create(delivery(repo));
  await service.analyze(created.id);
  await new Promise((resolve) => setTimeout(resolve, 140));
  const running = await service.get(created.id);
  assert.equal(running.status, "analyzing");
  assert.equal(running.run.phase, "running_harness");
  assert.ok(new Date(running.run.heartbeatAt) > new Date(running.run.startedAt));
  assert.equal(running.logs.filter((entry) => /心跳/.test(entry.message)).length, 0);
  const activityBefore = running.run.lastActivityAt;
  emitHarnessOutput();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const afterOutput = await service.get(created.id);
  assert.ok(new Date(afterOutput.run.lastActivityAt) > new Date(activityBefore));
  assert.match(afterOutput.logs.at(-1).message, /正在检索相关代码/);
  const logCount = afterOutput.logs.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await service.get(created.id)).logs.length, logCount);
  finishHarness();
  const completed = await waitFor(service, created.id, ["awaiting_approval", "failed"]);
  assert.equal(completed.status, "awaiting_approval", completed.failure);
  assert.equal(completed.run.finishReason, "completed");
});

test("分析超时与用户取消使用不同结束原因", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aca-service-stop-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  await createRepo(repo);

  const timeoutRuntime = path.join(temp, "timeout-runtime");
  const timeoutHarness = {
    async run(options) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new ProcessTimeoutError("dsh", options.timeoutMs);
    }
  };
  const timeoutService = new TaskService({
    store: new TaskStore(timeoutRuntime),
    harness: timeoutHarness,
    runtimeRoot: timeoutRuntime,
    heartbeatMs: 20,
    getTimeouts: () => ({ analyze: 120, modify: 120, test: 120 })
  });
  await timeoutService.init();
  const timed = await timeoutService.create(delivery(repo));
  await timeoutService.analyze(timed.id);
  const failed = await waitFor(timeoutService, timed.id, ["failed"]);
  assert.equal(failed.run.finishReason, "timeout");
  assert.match(failed.failure, /自动停止/);

  const cancelRuntime = path.join(temp, "cancel-runtime");
  const cancelHarness = {
    run(options) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new ProcessCancelledError("dsh")), { once: true });
      });
    }
  };
  const cancelService = new TaskService({
    store: new TaskStore(cancelRuntime),
    harness: cancelHarness,
    runtimeRoot: cancelRuntime,
    heartbeatMs: 20,
    getTimeouts: () => ({ analyze: 10000, modify: 10000, test: 10000 })
  });
  await cancelService.init();
  const cancellable = await cancelService.create(delivery(repo));
  await cancelService.analyze(cancellable.id);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const stopping = await cancelService.cancel(cancellable.id);
  assert.equal(stopping.run.phase, "stopping");
  const cancelled = await waitFor(cancelService, cancellable.id, ["cancelled"]);
  assert.equal(cancelled.run.finishReason, "cancelled");
  assert.match(cancelled.failure, /用户已取消/);
});

test("服务重启会恢复旧任务结构并标记遗留运行为中断", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aca-service-restart-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const store = new TaskStore(temp);
  await store.init();
  await store.save({
    id: "legacy-running",
    status: "analyzing",
    createdAt: "2026-08-17T08:00:00.000Z",
    updatedAt: "2026-08-17T08:01:00.000Z",
    logs: [],
    failure: ""
  });
  await store.save({
    id: "legacy-complete",
    status: "awaiting_approval",
    createdAt: "2026-08-17T07:00:00.000Z",
    updatedAt: "2026-08-17T07:05:00.000Z",
    logs: [],
    failure: ""
  });
  const service = new TaskService({ store, harness: {}, runtimeRoot: temp });
  await service.init();
  const interrupted = await service.get("legacy-running");
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.run.finishReason, "service_restarted");
  assert.match(interrupted.failure, /运行期间重启/);
  const legacy = await service.get("legacy-complete");
  assert.equal(legacy.status, "awaiting_approval");
  assert.equal(legacy.run, null);
  assert.equal((await store.get("legacy-complete")).run, null, "旧任务只补运行字段，不修改证据内容");
});
