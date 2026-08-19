import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { apply } from "../harness-plugin/runtime/index.js";

test("业务 Harness 插件同时提供现场摘要、证据文件和 Network 定向检索", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aca-business-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "delivery.json"), JSON.stringify({
    steps: [{ type: "click" }],
    network: [{ id: "req-1", method: "POST", url: "https://example.test/orders", response: { status: 200, body: "created" } }],
    screenshots: [{ path: "screenshots/001.png" }],
    requirementPoints: [{ text: "创建订单" }]
  }));
  const tools = [];
  const prompts = [];
  apply({ tools: { register(tool) { tools.push(tool); } }, systemPrompt: { section(value) { prompts.push(value); } } }, { evidenceRoot: root, sourceMode: "developer" });
  assert.deepEqual(tools.map((tool) => tool.name), [
    "api_capture_evidence_summary",
    "api_capture_evidence_files",
    "api_capture_evidence_read",
    "api_capture_network_find"
  ]);
  assert.match(prompts[0].text, /developer/);
  assert.deepEqual(await tools[0].execute({}), { sourceMode: "developer", goal: "", requestNote: "", steps: 1, network: 1, screenshots: 1, requirementPoints: 1, topLevelFields: ["network", "requirementPoints", "screenshots", "steps"] });
  const found = await tools[3].execute({ query: "orders" });
  assert.equal(found.returned, 1);
  await assert.rejects(() => tools[2].execute({ relative_path: "../task-state.json" }), /inside the task evidence directory/);
});
