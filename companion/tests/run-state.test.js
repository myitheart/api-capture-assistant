import test from "node:test";
import assert from "node:assert/strict";
import { createRun, finishRun, normalizeRun, updateRun } from "../src/runs/state.js";

test("运行状态包含稳定时间字段并兼容旧任务", () => {
  assert.equal(normalizeRun(undefined), null);
  const now = new Date("2026-08-17T08:00:00.000Z");
  const run = createRun({ kind: "analyze", timeoutMs: 30 * 60000, now });
  assert.equal(run.phase, "preparing");
  assert.equal(run.timeoutAt, "2026-08-17T08:30:00.000Z");
  const active = updateRun(run, { phase: "running_harness", activity: true }, new Date("2026-08-17T08:00:03.000Z"));
  assert.equal(active.lastActivityAt, "2026-08-17T08:00:03.000Z");
  const finished = finishRun(active, "completed", new Date("2026-08-17T08:05:00.000Z"));
  assert.equal(finished.phase, "finished");
  assert.equal(finished.finishReason, "completed");
});
