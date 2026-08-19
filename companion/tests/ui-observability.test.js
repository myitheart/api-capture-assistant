import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Harness 风格控制台保留运行观测、心跳提示和停止确认", async () => {
  const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../ui/app.js", import.meta.url), "utf8");
  ["runCard", "runPhase", "runElapsed", "runRemaining", "runActivity", "runHeartbeat", "cancelBtn"].forEach((id) => {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  });
  assert.match(script, /heartbeatAge >= 15000/);
  assert.match(script, /heartbeatAge >= 10000/);
  assert.match(script, /setInterval\(renderRuntimeClock, 1000\)/);
  assert.match(html, /class="sidebar"/);
  assert.match(html, />新会话</);
  assert.match(html, />工作区</);
  assert.match(html, /data-panel="chat"[^>]*>对话</);
  assert.match(html, /data-panel="trajectory"[^>]*>轨迹</);
  assert.match(html, /Session log/);
  assert.match(html, /id="chatInput"/);
  assert.doesNotMatch(html, /class="hero"|MVP0 · 单人本地闭环|1 需求对话/);
  assert.match(script, /发送第一条消息后才会调用模型/);
  assert.match(script, /action\("chat"/);
  assert.match(script, /confirm\("确认停止当前运行/);
  assert.equal((html.match(/id="cancelBtn"/g) || []).length, 1, "停止按钮必须是全局唯一入口");
  ["analysisTimeout", "modifyTimeout", "testTimeout"].forEach((id) => assert.match(html, new RegExp(`id=["']${id}["']`)));
  assert.match(script, /analysisTimeoutMinutes/);
  assert.match(script, /modifyTimeoutMinutes/);
  assert.match(script, /testTimeoutMinutes/);
});
