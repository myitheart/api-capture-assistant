import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Companion 默认启动 DeepSeek Harness 原生 Web", async () => {
  const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const companionPackage = JSON.parse(await readFile(new URL("../companion/package.json", import.meta.url), "utf8"));
  const launcher = await readFile(new URL("../companion/src/native-harness/launcher.js", import.meta.url), "utf8");
  assert.equal(rootPackage.scripts.start, "node companion/src/native-harness/launcher.js");
  assert.equal(companionPackage.scripts.start, "node src/native-harness/launcher.js");
  assert.match(launcher, /"web", "--port"/);
  assert.match(launcher, /surface: "native-harness"/);
  assert.match(launcher, /API_CAPTURE_EVIDENCE_HOME/);
  assert.match(launcher, /API_CAPTURE_ANALYSIS_HOME/);
  assert.doesNotMatch(launcher, /\/api\/tasks|awaiting_approval|worktree/i);
});

test("便携包只交付原生 Harness 与 Prompt 草稿桥", async () => {
  const builder = await readFile(new URL("../scripts/build-portable.js", import.meta.url), "utf8");
  const smoke = await readFile(new URL("../scripts/smoke-portable.js", import.meta.url), "utf8");
  assert.match(builder, /harness-build\.json/);
  assert.match(builder, /runtime/);
  assert.doesNotMatch(builder, /harness-plugin|delivery-protocol|companion\/src\/server/);
  assert.match(smoke, /\/api-capture\/drafts/);
  assert.match(smoke, /\/api-capture\/chat-drafts/);
  assert.match(smoke, /\/api-capture\/evidence-packages/);
  assert.match(smoke, /native-harness/);
  assert.doesNotMatch(smoke, /\/api\/tasks|只读分析|开始修改/);
});

test("macOS 便携包提供原生应用和 command 诊断入口", async () => {
  const builder = await readFile(new URL("../scripts/build-macos-portable.js", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../packaging/macos/ApiCaptureLauncher.swift", import.meta.url), "utf8");
  const diagnostic = await readFile(new URL("../packaging/macos/诊断并启动.command", import.meta.url), "utf8");
  assert.match(builder, /macos-arm64/);
  assert.match(builder, /arm64-apple-macos13\.5/);
  assert.match(builder, /codesign/);
  assert.match(builder, /ditto/);
  assert.match(launcher, /--smoke-test/);
  assert.match(launcher, /打开工作台/);
  assert.match(launcher, /API_CAPTURE_NO_OPEN/);
  assert.match(diagnostic, /uname -m/);
  assert.doesNotMatch(diagnostic, /sudo|xattr/);
});
