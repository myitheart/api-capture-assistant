import test from "node:test";
import assert from "node:assert/strict";
import { runProcess, ProcessCancelledError, ProcessExecutionError, ProcessTimeoutError } from "../src/runs/process.js";

test("进程执行器区分正常完成和异常退出", async () => {
  let started = null;
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {
    onStart: (value) => { started = value; }
  });
  assert.equal(result.stdout, "ok");
  assert.ok(started.pid);
  await assert.rejects(
    () => runProcess(process.execPath, ["-e", "process.stderr.write('bad');process.exit(2)"]),
    (error) => error instanceof ProcessExecutionError && error.result.code === 2
  );
});

test("进程执行器区分自动超时和用户取消", async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 80 }),
    (error) => error instanceof ProcessTimeoutError && error.code === "PROCESS_TIMEOUT"
  );
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(
    () => running,
    (error) => error instanceof ProcessCancelledError && error.code === "PROCESS_CANCELLED"
  );
});
