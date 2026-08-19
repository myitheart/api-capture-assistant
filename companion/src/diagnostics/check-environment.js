import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "../runs/process.js";
import { runtimeNodeName } from "../native-harness/platform.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const companionRoot = path.resolve(here, "../..");
const assistantRoot = path.resolve(companionRoot, "..");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function check(command, args, options = {}) {
  try {
    const result = await runProcess(command, args, { allowFailure: true, timeoutMs: 60000, ...options });
    return { ok: result.code === 0, output: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || "可用" };
  } catch (error) {
    return { ok: false, output: String(error?.message || error) };
  }
}

async function inspectNativeHarness() {
  const manifestPath = path.join(assistantRoot, "harness-build.json");
  if (await exists(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const nodePath = path.join(assistantRoot, "runtime", runtimeNodeName());
      const entryPath = path.resolve(assistantRoot, manifest.entry || "");
      const valid = manifest.surface === "native-web"
        && manifest.bridgeProtocolVersion === "1.0"
        && manifest.evidenceProtocolVersion === "1.0"
        && manifest.chatDraftProtocolVersion === "1.0"
        && await exists(nodePath)
        && await exists(entryPath);
      return {
        ok: valid,
        kind: "packaged",
        surface: manifest.surface,
        bridgeProtocolVersion: manifest.bridgeProtocolVersion,
        evidenceProtocolVersion: manifest.evidenceProtocolVersion,
        chatDraftProtocolVersion: manifest.chatDraftProtocolVersion,
        upstreamCommit: manifest.upstreamCommit,
        entry: entryPath,
        output: valid ? "内置 DeepSeek Harness 原生 Web 发行版可用" : "Harness 发行包清单或文件不完整"
      };
    } catch (error) {
      return { ok: false, kind: "packaged", output: `无法读取 harness-build.json：${error.message}` };
    }
  }

  const forkRoot = path.resolve(assistantRoot, "..", "api-capture-harness");
  const cliEntry = path.join(forkRoot, "apps", "cli", "src", "bin.ts");
  const draftPackage = path.join(forkRoot, "packages", "client", "api-capture-draft", "package.json");
  const evidencePackage = path.join(forkRoot, "packages", "host", "api-capture-evidence", "package.json");
  if (!await exists(cliEntry) || !await exists(draftPackage) || !await exists(evidencePackage)) {
    return {
      ok: false,
      kind: "source",
      root: forkRoot,
      output: "未找到相邻 api-capture-harness 源码 Fork 或 Prompt 草稿桥"
    };
  }
  const pnpm = await check(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--version"],
    { shell: process.platform === "win32" }
  );
  return {
    ok: pnpm.ok,
    kind: "source",
    surface: "native-web",
    bridgeProtocolVersion: "1.0",
    evidenceProtocolVersion: "1.0",
    chatDraftProtocolVersion: "1.0",
    root: forkRoot,
    output: pnpm.ok ? `相邻源码 Fork 可用（pnpm ${pnpm.output}）` : `源码 Fork 已找到，但 pnpm 不可用：${pnpm.output}`
  };
}

export async function checkEnvironment() {
  let [node, git, harness] = await Promise.all([
    check(process.execPath, ["--version"]),
    check("git", ["--version"]),
    inspectNativeHarness()
  ]);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (node.ok && (major < 22 || (major === 22 && minor < 19))) {
    node = { ok: false, output: `需要 Node.js 22.19+，当前 ${process.version}` };
  }
  return {
    ok: node.ok && git.ok && harness.ok,
    surface: "native-harness",
    promptBridgeProtocolVersion: "1.0",
    evidenceProtocolVersion: "1.0",
    chatDraftProtocolVersion: "1.0",
    node,
    git,
    harness,
    platform: process.platform,
    externalDependencies: harness.kind === "packaged" ? [] : ["Git", "Node.js 22.19+", "pnpm"],
    guidance: harness.ok
      ? `已加载${harness.kind === "packaged" ? "内置发行版" : "相邻源码 Fork"}；插件只会把 Prompt 放入原生 Harness 编辑框。`
      : "未找到可用 Harness。正式用户请重新解压完整 Companion ZIP；开发者请检出相邻 api-capture-harness 并安装 pnpm。"
  };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const result = await checkEnvironment();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
