import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  assertSupportedTarget,
  companionDistributionName,
  getApiCaptureHome,
  getApiCaptureLogHome,
  harnessDistributionName,
  isCompanionLauncherCommand,
  isHarnessCommand,
  runtimeNodeName
} from "../src/native-harness/platform.js";

test("Windows 与 macOS 使用各自的数据目录和 Node 文件名", () => {
  assert.equal(runtimeNodeName("win32"), "node.exe");
  assert.equal(runtimeNodeName("darwin"), "node");
  assert.equal(
    getApiCaptureHome({ env: { LOCALAPPDATA: "C:\\Local" }, platform: "win32", homedir: "C:\\Users\\tester" }),
    path.join("C:\\Local", "ApiCaptureAssistant")
  );
  assert.equal(
    getApiCaptureHome({ env: {}, platform: "darwin", homedir: "/Users/tester" }),
    path.join("/Users/tester", "Library", "Application Support", "ApiCaptureAssistant")
  );
  assert.equal(
    getApiCaptureLogHome({ env: {}, platform: "darwin", homedir: "/Users/tester" }),
    path.join("/Users/tester", "Library", "Logs", "ApiCaptureAssistant")
  );
  assert.equal(
    getApiCaptureHome({ env: { API_CAPTURE_HOME: "/tmp/api-capture" }, platform: "darwin", homedir: "/Users/tester" }),
    path.resolve("/tmp/api-capture")
  );
});

test("便携包名称和支持平台矩阵保持稳定", () => {
  assert.deepEqual(assertSupportedTarget("win32", "x64"), { platform: "win32", arch: "x64" });
  assert.deepEqual(assertSupportedTarget("darwin", "arm64"), { platform: "darwin", arch: "arm64" });
  assert.throws(() => assertSupportedTarget("darwin", "x64"), /暂不支持/);
  assert.equal(harnessDistributionName("darwin", "arm64"), "api-capture-harness-darwin-arm64");
  assert.equal(harnessDistributionName("win32", "x64"), "api-capture-harness-win-x64");
  assert.equal(companionDistributionName("darwin", "arm64"), "api-capture-companion-macos-arm64");
});

test("停止流程只识别 Companion 与 Harness 的明确命令行", () => {
  assert.equal(isCompanionLauncherCommand('/bundle/runtime/node /bundle/companion/src/native-harness/launcher.js'), true);
  assert.equal(isCompanionLauncherCommand('/usr/bin/node unrelated.js'), false);
  assert.equal(isHarnessCommand('/bundle/harness/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 43110'), true);
  assert.equal(isHarnessCommand('pnpm dsh web --port 43110'), true);
  assert.equal(isHarnessCommand('/usr/bin/node server.js'), false);
});
