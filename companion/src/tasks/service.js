import path from "node:path";
import { inspectRepository, createTaskWorktree, getWorktreeDiff, commitWorktree, mergeFastForward, removeTaskWorktree } from "../projects/git.js";
import { runProcess } from "../runs/process.js";
import { PROTOCOL_VERSION, RUNNING_STATES, TASK_STATES } from "../constants.js";
import { assertString, makeId, nowIso, publicError } from "../shared/utils.js";
import { buildAnalysisPrompt, buildAnalysisFollowupPrompt, buildModifyPrompt } from "../../../harness-plugin/src/prompts/index.js";
import { createRun, finishRun, normalizeRun, updateRun } from "../runs/state.js";

function publicTask(task) {
  if (!task) return null;
  const clone = structuredClone(task);
  clone.run = normalizeRun(clone.run);
  if (clone.logs?.length > 300) clone.logs = clone.logs.slice(-300);
  return clone;
}

export class TaskService {
  constructor({ store, harness, runtimeRoot, getTimeouts, heartbeatMs = 3000 }) {
    this.store = store;
    this.harness = harness;
    this.runtimeRoot = runtimeRoot;
    this.getTimeouts = getTimeouts || (() => ({ analyze: 30 * 60000, modify: 60 * 60000, test: 30 * 60000 }));
    this.heartbeatMs = heartbeatMs;
    this.controllers = new Map();
  }

  async init() {
    await this.store.init();
    const tasks = await this.store.list();
    for (const task of tasks) {
      let changed = false;
      if (!Object.prototype.hasOwnProperty.call(task, "run")) {
        task.run = null;
        changed = true;
      }
      if (RUNNING_STATES.has(task.status)) {
        const kind = task.status === "analyzing" ? "analyze" : task.status === "testing" ? "test" : "modify";
        const phase = task.status === "testing" ? "running_tests" : "running_harness";
        const startedAt = new Date(task.run?.startedAt || task.updatedAt || task.createdAt || Date.now());
        const safeStartedAt = Number.isNaN(startedAt.getTime()) ? new Date() : startedAt;
        task.run = task.run || createRun({ kind, phase, timeoutMs: this.#timeout(kind), now: safeStartedAt });
        task.run = finishRun(task.run, "service_restarted");
        task.status = "failed";
        task.failure = "Companion 在任务运行期间重启，原运行已中断；证据、Worktree 和已有修改均被保留，可以重新执行。";
        task.updatedAt = nowIso();
        await this.store.save(task);
        await this.#log(task, "error", task.failure, { activity: true });
        continue;
      }
      if (changed) await this.store.save(task);
    }
  }

  async list() {
    return (await this.store.list()).map(publicTask);
  }

  async get(taskId) {
    return publicTask(await this.#require(taskId));
  }

  async inspect(projectPath, targetBranch = "") {
    return inspectRepository(projectPath, targetBranch);
  }

  async create(payload = {}) {
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`任务协议不兼容：Companion 需要 ${PROTOCOL_VERSION}，收到 ${payload.protocolVersion || "空"}。`);
    }
    const projectPath = assertString(payload.target?.projectPath, "目标项目路径", { required: true, max: 4096 });
    const targetBranch = assertString(payload.target?.targetBranch, "目标分支", { max: 240 });
    const repository = await inspectRepository(projectPath, targetBranch);
    const id = makeId("local");
    const evidence = await this.store.saveEvidence(id, payload.evidence || {});
    const now = nowIso();
    const task = {
      id,
      protocolVersion: PROTOCOL_VERSION,
      status: "received",
      createdAt: now,
      updatedAt: now,
      source: payload.source || {},
      sourceTask: payload.task || {},
      requestNote: assertString(payload.target?.requestNote, "研发补充说明", { max: 8000 }),
      testCommand: assertString(payload.target?.testCommand, "测试命令", { max: 2000 }),
      repository,
      evidence,
      logs: [],
      analysis: "",
      analysisFile: "",
      conversation: [],
      sessions: { analysis: { id: `${id}-analysis`, startedAt: null }, implementation: { id: `${id}-implementation`, startedAt: null } },
      worktree: null,
      diff: null,
      testResult: { status: "not_run", command: "", output: "" },
      commit: null,
      merge: null,
      failure: "",
      run: null
    };
    await this.store.save(task);
    await this.#log(task, "system", repository.clean ? "任务已接收，目标仓库状态干净。" : `任务已接收，但目标仓库有 ${repository.changes.length} 项未提交修改；允许只读分析，禁止自动修改。`);
    return publicTask(task);
  }

  async analyze(taskId, message = "") {
    const task = await this.#require(taskId);
    this.#assertNotRunning(task);
    if (task.worktree) throw new Error("任务已经进入代码修改阶段，不能重新覆盖只读分析。 ");
    if (!new Set(["received", "failed", "cancelled", "awaiting_approval"]).has(task.status)) throw new Error("当前任务状态不能开始只读分析。 ");
    const userMessage = assertString(message, "对话内容", { max: 12000 });
    task.conversation = Array.isArray(task.conversation) ? task.conversation : [];
    task.sessions ||= { analysis: { id: `${task.id}-analysis`, startedAt: null }, implementation: { id: `${task.id}-implementation`, startedAt: null } };
    task.sessions.analysis ||= { id: `${task.id}-analysis`, startedAt: null };
    const firstTurn = !task.sessions.analysis.startedAt;
    const visibleMessage = userMessage || (firstTurn ? "请根据现场需求和证据开始分析，并优先定位最相关的代码。" : "请继续完善当前只读分析结论。");
    task.conversation.push({ id: makeId("msg"), role: "user", content: visibleMessage, createdAt: nowIso() });
    if (firstTurn) task.sessions.analysis.startedAt = nowIso();
    const repository = await inspectRepository(task.repository.root, task.repository.targetBranch);
    const timeoutMs = this.#timeout("analyze");
    task.repository = repository;
    task.status = "analyzing";
    task.failure = "";
    task.run = createRun({ kind: "analyze", phase: "preparing", timeoutMs });
    task.updatedAt = nowIso();
    await this.store.save(task);
    this.#launch(task, async (signal) => {
      await this.#setRunPhase(task, "launching_harness", "正在启动只读 Harness。 ");
      await this.#setRunPhase(task, "running_harness", "开始只读分析，Harness 无项目写权限。 ");
      const result = await this.harness.run({
        cwd: repository.root,
        prompt: firstTurn ? buildAnalysisPrompt(task, userMessage) : buildAnalysisFollowupPrompt(visibleMessage),
        permissionMode: "read-only",
        sessionKind: "analysis",
        evidenceRoot: path.dirname(task.evidence.deliveryFile),
        sourceMode: task.source?.mode || "product",
        signal,
        taskId: task.id,
        timeoutMs,
        onOutput: (kind, text) => this.#log(task, kind, text, { activity: true }).catch(() => {})
      });
      this.#throwIfAborted(signal);
      await this.#setRunPhase(task, "finalizing", "Harness 已返回结果，正在整理只读分析。 ");
      const answer = result.stdout.trim() || "Harness 本轮未返回文本，请查看运行日志和工具事件。";
      task.conversation.push({ id: makeId("msg"), role: "assistant", content: answer, createdAt: nowIso() });
      task.analysis = task.conversation.filter((entry) => entry.role === "assistant").map((entry) => entry.content).join("\n\n---\n\n");
      task.analysisFile = await this.store.saveText(task.id, "analysis.md", task.analysis);
      task.status = "awaiting_approval";
      task.updatedAt = nowIso();
      await this.store.save(task);
      await this.#log(task, "system", "只读分析完成，等待用户审核并授权修改。 ");
    });
    return publicTask(task);
  }

  async modify(taskId) {
    const task = await this.#require(taskId);
    this.#assertNotRunning(task);
    if (!new Set(["awaiting_approval", "failed", "cancelled"]).has(task.status)) throw new Error("请先审核只读分析结果，再授权修改。 ");
    if (!task.analysisFile) throw new Error("请先完成只读分析。 ");
    const repository = await inspectRepository(task.repository.root, task.repository.targetBranch);
    if (!repository.clean) throw new Error("目标项目存在未提交修改；仍可查看分析，但不能启动自动修改。 ");
    if (repository.baseCommit !== task.repository.baseCommit) throw new Error("目标分支在分析后发生变化，请重新创建任务或重新分析。 ");
    const timeoutMs = this.#timeout("modify");
    task.repository = repository;
    task.status = "modifying";
    task.failure = "";
    task.run = createRun({ kind: "modify", phase: "creating_worktree", timeoutMs });
    task.updatedAt = nowIso();
    await this.store.save(task);
    this.#launch(task, async (signal) => {
      if (!task.worktree) task.worktree = await createTaskWorktree({ repository, taskId: task.id, runtimeRoot: this.runtimeRoot });
      this.#throwIfAborted(signal);
      await this.#log(task, "system", `已创建工作分支 ${task.worktree.branch}，所有改动限定在 ${task.worktree.path}。`);
      await this.#setRunPhase(task, "launching_harness", "正在启动 Worktree 修改 Harness。 ");
      await this.#setRunPhase(task, "running_harness", "Harness 正在独立 Worktree 中修改代码。 ");
      const result = await this.harness.run({
        cwd: task.worktree.path,
        prompt: buildModifyPrompt(task),
        permissionMode: "workspace-write",
        sessionKind: "implementation",
        evidenceRoot: path.dirname(task.evidence.deliveryFile),
        sourceMode: task.source?.mode || "product",
        signal,
        taskId: task.id,
        timeoutMs,
        onOutput: (kind, text) => this.#log(task, kind, text, { activity: true }).catch(() => {})
      });
      this.#throwIfAborted(signal);
      task.modificationSummary = result.stdout.trim();
      task.modificationFile = await this.store.saveText(task.id, "modification.md", task.modificationSummary);
      task.diff = await getWorktreeDiff(task.worktree.path);
      if (task.testCommand) {
        task.status = "testing";
        task.run = createRun({ kind: "test", phase: "running_tests", timeoutMs: this.#timeout("test") });
        task.updatedAt = nowIso();
        await this.store.save(task);
        await this.#runTests(task, signal);
      } else {
        task.testResult = { status: "skipped", command: "", output: "未配置测试命令。" };
      }
      this.#throwIfAborted(signal);
      await this.#setRunPhase(task, "finalizing", "修改流程已返回结果，正在整理 diff 与测试结论。 ");
      task.diff = await getWorktreeDiff(task.worktree.path);
      task.status = "ready_to_commit";
      task.updatedAt = nowIso();
      await this.store.save(task);
      await this.#log(task, "system", task.diff.clean ? "Harness 未产生代码修改，请检查分析结论。" : "修改与验证阶段完成，请审核 diff 后决定是否提交。 ");
    });
    return publicTask(task);
  }

  async #runTests(task, signal) {
    await this.#log(task, "system", `执行测试命令：${task.testCommand}`);
    const result = await runProcess(task.testCommand, [], {
      cwd: task.worktree.path,
      shell: true,
      signal,
      timeoutMs: this.#timeout("test"),
      allowFailure: true,
      onOutput: (kind, text) => this.#log(task, kind, text, { activity: true }).catch(() => {})
    });
    task.testResult = {
      status: result.code === 0 ? "passed" : "failed",
      command: task.testCommand,
      code: result.code,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-100000)
    };
    if (result.code !== 0) throw new Error(`测试命令失败（退出码 ${result.code}），已保留 Worktree。`);
  }

  async cancel(taskId) {
    const active = this.controllers.get(taskId);
    const task = active?.task || await this.#require(taskId);
    if (!active && !RUNNING_STATES.has(task.status)) throw new Error("任务当前没有正在运行的操作。 ");
    task.run = task.run ? updateRun(task.run, { phase: "stopping", activity: true }) : null;
    task.failure = "正在停止当前运行…";
    task.updatedAt = nowIso();
    await this.#log(task, "system", "用户请求停止当前运行，正在终止 Harness 子进程树。 ");
    if (active) active.controller.abort();
    else {
      task.status = "cancelled";
      task.failure = "用户已取消当前运行。";
      if (task.run) task.run = finishRun(task.run, "cancelled");
      await this.store.save(task);
    }
    return publicTask(task);
  }

  async commit(taskId, message) {
    const task = await this.#require(taskId);
    this.#assertNotRunning(task);
    if (task.status !== "ready_to_commit") throw new Error("任务尚未完成修改与验证，不能创建提交。 ");
    if (!task.worktree) throw new Error("当前任务没有可提交的 Worktree。 ");
    if (task.testResult?.status === "failed") throw new Error("测试仍处于失败状态，不能创建提交。 ");
    const result = await commitWorktree(task.worktree.path, assertString(message, "提交说明", { required: true, max: 200 }));
    task.commit = { hash: result.commit, message, createdAt: nowIso() };
    task.diff = result;
    task.status = "committed";
    task.updatedAt = nowIso();
    await this.store.save(task);
    await this.#log(task, "system", `已在工作分支创建提交 ${result.commit.slice(0, 12)}，尚未推送或合并。`);
    return publicTask(task);
  }

  async merge(taskId) {
    const task = await this.#require(taskId);
    this.#assertNotRunning(task);
    if (task.status !== "committed") throw new Error("只有已提交的工作分支可以自动合并。 ");
    if (!task.commit || !task.worktree) throw new Error("请先在工作分支创建提交。 ");
    if (task.testResult?.status === "failed") throw new Error("测试失败，不能自动合并。 ");
    task.merge = await mergeFastForward({
      repositoryPath: task.repository.root,
      targetBranch: task.repository.targetBranch,
      baseCommit: task.repository.baseCommit,
      workBranch: task.worktree.branch
    });
    task.status = "merged";
    task.updatedAt = nowIso();
    await this.store.save(task);
    await this.#log(task, "system", `已 fast-forward 合并到 ${task.repository.targetBranch}；未推送远端。`);
    return publicTask(task);
  }

  async cleanup(taskId, options = {}) {
    const task = await this.#require(taskId);
    this.#assertNotRunning(task);
    if (!task.worktree) return publicTask(task);
    const allowedRoot = path.resolve(this.runtimeRoot, "worktrees");
    const worktreePath = path.resolve(task.worktree.path);
    if (!worktreePath.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("Worktree 路径不在 Companion 运行目录内，已拒绝清理。 ");
    task.cleanup = await removeTaskWorktree(task.repository.root, worktreePath, { force: options.discard === true });
    task.worktree.cleaned = true;
    task.updatedAt = nowIso();
    await this.store.save(task);
    await this.#log(task, "system", "Worktree 已清理；工作分支未自动删除。 ");
    return publicTask(task);
  }

  async #require(taskId) {
    const task = await this.store.get(String(taskId || ""));
    if (!task) throw new Error("未找到本地研发任务。 ");
    if (!TASK_STATES.includes(task.status)) throw new Error(`任务状态 ${task.status} 无效。`);
    task.logs = Array.isArray(task.logs) ? task.logs : [];
    task.conversation = Array.isArray(task.conversation) ? task.conversation : [];
    task.sessions ||= { analysis: { id: `${task.id}-analysis`, startedAt: task.analysis ? task.updatedAt : null }, implementation: { id: `${task.id}-implementation`, startedAt: task.worktree ? task.updatedAt : null } };
    return task;
  }

  #assertNotRunning(task) {
    if (RUNNING_STATES.has(task.status) || this.controllers.has(task.id)) throw new Error("任务正在运行，请等待完成或先取消。 ");
  }

  #launch(task, operation) {
    const controller = new AbortController();
    this.controllers.set(task.id, { controller, task });
    let settling = false;
    let heartbeatWrite = Promise.resolve();
    const heartbeat = setInterval(() => {
      if (settling || !task.run || task.run.phase === "finished") return;
      heartbeatWrite = heartbeatWrite.then(async () => {
        if (settling || !task.run || task.run.phase === "finished") return;
        task.run = updateRun(task.run, {});
        await this.store.save(task);
      }).catch(() => {});
    }, this.heartbeatMs);
    heartbeat.unref?.();
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(async () => {
        settling = true;
        clearInterval(heartbeat);
        await heartbeatWrite;
        if (task.run && task.run.phase !== "finished") task.run = finishRun(task.run, "completed");
        await this.store.save(task);
      })
      .catch(async (error) => {
        settling = true;
        clearInterval(heartbeat);
        await heartbeatWrite;
        const latest = await this.store.get(task.id) || task;
        const cancelled = error?.code === "PROCESS_CANCELLED" || latest.run?.phase === "stopping";
        const timedOut = error?.code === "PROCESS_TIMEOUT";
        latest.status = cancelled ? "cancelled" : "failed";
        latest.failure = cancelled
          ? "用户已取消当前运行；已有证据、Worktree 和修改均被保留。"
          : timedOut
            ? this.#timeoutMessage(latest)
            : publicError(error);
        if (latest.run) latest.run = finishRun(latest.run, cancelled ? "cancelled" : timedOut ? "timeout" : "failed");
        latest.updatedAt = nowIso();
        await this.store.save(latest);
        await this.#log(latest, cancelled ? "system" : "error", latest.failure, { activity: true });
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.controllers.delete(task.id);
      });
  }

  async #log(task, kind, message, { activity = true } = {}) {
    const text = String(message || "").trim();
    if (!text) return;
    const entry = { at: nowIso(), kind, message: text.slice(-20000) };
    task.logs = Array.isArray(task.logs) ? task.logs : [];
    task.logs.push(entry);
    if (task.logs.length > 300) task.logs = task.logs.slice(-300);
    if (task.run && task.run.phase !== "finished") task.run = updateRun(task.run, { activity });
    task.updatedAt = entry.at;
    await Promise.all([this.store.appendLog(task.id, entry), this.store.save(task)]);
  }

  async #setRunPhase(task, phase, message) {
    if (task.run) task.run = updateRun(task.run, { phase, activity: true });
    if (message) await this.#log(task, "system", message, { activity: true });
    else await this.store.save(task);
  }

  #timeout(kind) {
    const value = Number(this.getTimeouts()?.[kind]);
    if (!Number.isFinite(value) || value < 100) throw new Error(`${kind} 超时配置无效。`);
    return value;
  }

  #timeoutMessage(task) {
    const label = task.run?.kind === "analyze" ? "只读分析" : task.run?.kind === "test" ? "测试命令" : "代码修改";
    const started = new Date(task.run?.startedAt || 0).getTime();
    const timeout = new Date(task.run?.timeoutAt || 0).getTime();
    const minutes = Math.max(1, Math.round((timeout - started) / 60000));
    return `${label}超过 ${minutes} 分钟，已自动停止；证据、Worktree 和已有修改均被保留。`;
  }

  #throwIfAborted(signal) {
    if (!signal.aborted) return;
    const error = new Error("运行已由用户停止。 ");
    error.code = "PROCESS_CANCELLED";
    throw error;
  }
}
