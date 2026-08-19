export const RUN_KINDS = Object.freeze(["analyze", "modify", "test"]);
export const RUN_PHASES = Object.freeze([
  "preparing",
  "launching_harness",
  "running_harness",
  "creating_worktree",
  "running_tests",
  "finalizing",
  "stopping",
  "finished"
]);
export const RUN_FINISH_REASONS = Object.freeze([
  "completed",
  "cancelled",
  "timeout",
  "failed",
  "service_restarted"
]);

function validIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createRun({ kind, phase = "preparing", timeoutMs, now = new Date() }) {
  if (!RUN_KINDS.includes(kind)) throw new Error(`运行类型无效：${kind || "空"}。`);
  if (!RUN_PHASES.includes(phase) || phase === "finished") throw new Error(`运行阶段无效：${phase || "空"}。`);
  const startedAt = now.toISOString();
  return {
    kind,
    phase,
    startedAt,
    heartbeatAt: startedAt,
    lastActivityAt: startedAt,
    timeoutAt: new Date(now.getTime() + timeoutMs).toISOString(),
    finishedAt: null,
    finishReason: null
  };
}

export function normalizeRun(run) {
  if (!run || typeof run !== "object") return null;
  const kind = RUN_KINDS.includes(run.kind) ? run.kind : "analyze";
  const phase = RUN_PHASES.includes(run.phase) ? run.phase : "finished";
  const startedAt = validIso(run.startedAt) || new Date(0).toISOString();
  const finishedAt = validIso(run.finishedAt);
  return {
    kind,
    phase,
    startedAt,
    heartbeatAt: validIso(run.heartbeatAt) || startedAt,
    lastActivityAt: validIso(run.lastActivityAt) || startedAt,
    timeoutAt: validIso(run.timeoutAt) || startedAt,
    finishedAt,
    finishReason: RUN_FINISH_REASONS.includes(run.finishReason) ? run.finishReason : null
  };
}

export function updateRun(run, patch, now = new Date()) {
  const normalized = normalizeRun(run);
  if (!normalized) throw new Error("任务没有可更新的运行状态。 ");
  if (patch.phase && !RUN_PHASES.includes(patch.phase)) throw new Error(`运行阶段无效：${patch.phase}。`);
  return {
    ...normalized,
    ...patch,
    heartbeatAt: patch.heartbeatAt || now.toISOString(),
    lastActivityAt: patch.activity === true ? now.toISOString() : (patch.lastActivityAt || normalized.lastActivityAt)
  };
}

export function finishRun(run, finishReason, now = new Date()) {
  if (!RUN_FINISH_REASONS.includes(finishReason)) throw new Error(`运行结束原因无效：${finishReason || "空"}。`);
  return updateRun(run, {
    phase: "finished",
    finishReason,
    finishedAt: now.toISOString(),
    activity: true
  }, now);
}
