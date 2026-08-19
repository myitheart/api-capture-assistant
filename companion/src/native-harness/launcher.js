import path from "node:path";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getApiCaptureHome,
  getApiCaptureLogHome,
  isProcessAlive,
  pidFilePath,
  runtimeNodeName
} from "./platform.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const companionRoot = path.resolve(here, "../..");
const assistantRoot = path.resolve(companionRoot, "..");
const port = Number(process.env.API_CAPTURE_PORT || 43110);
const origin = `http://127.0.0.1:${port}`;
const healthUrl = `${origin}/api-capture/health`;
const expectedProtocols = Object.freeze({
  protocolVersion: "1.0",
  evidenceProtocolVersion: "1.0",
  chatDraftProtocolVersion: "1.0"
});

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

function isCompatibleHealth(health) {
  return health?.ok === true
    && health.surface === "native-harness"
    && Object.entries(expectedProtocols).every(([key, value]) => health[key] === value);
}

async function probeHealth(timeoutMs = 1200) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let health = null;
    try { health = JSON.parse(text); } catch {}
    return { reachable: true, response, health };
  } catch {
    return { reachable: false, response: null, health: null };
  }
}

async function waitForHealth(child, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.launchError) throw child.launchError;
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Harness 在健康检查完成前退出（${child.exitCode}）。`);
    }
    const probe = await probeHealth();
    if (isCompatibleHealth(probe.health)) return probe.health;
    if (probe.reachable) throw new Error(`端口 ${port} 已被不兼容的本地服务占用。`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Harness 启动超过 ${Math.round(timeoutMs / 1000)} 秒，请查看日志。`);
}

async function openWorkbench() {
  if (/^(1|true|yes)$/i.test(String(process.env.API_CAPTURE_NO_OPEN || ""))) return;
  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", origin];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [origin];
  } else {
    command = "xdg-open";
    args = [origin];
  }
  const opener = spawn(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
  opener.unref();
}

async function resolveLaunch() {
  const manifestPath = path.join(assistantRoot, "harness-build.json");
  if (await exists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.surface !== "native-web") throw new Error("发行包中的 Harness 不是原生 Web 构建，请重新下载完整版本。");
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw new Error(`Harness 发行包架构不匹配：需要 ${process.platform}-${process.arch}，实际 ${manifest.platform}-${manifest.arch}。`);
    }
    for (const [key, value] of Object.entries(expectedProtocols)) {
      const manifestKey = key === "protocolVersion" ? "bridgeProtocolVersion" : key;
      if (manifest[manifestKey] !== value) throw new Error(`Harness 协议不兼容：${key}。`);
    }
    const node = path.join(assistantRoot, "runtime", runtimeNodeName());
    const entry = path.resolve(assistantRoot, manifest.entry);
    if (!await exists(node) || !await exists(entry)) throw new Error("Harness 发行包不完整，请重新解压 ZIP。");
    return { command: node, args: [entry, "web", "--port", String(port)], cwd: assistantRoot };
  }
  const forkRoot = path.resolve(assistantRoot, "..", "api-capture-harness");
  if (!await exists(path.join(forkRoot, "apps", "cli", "src", "bin.ts"))) {
    throw new Error("未找到相邻的 api-capture-harness 源码 Fork，也未找到内置 Harness 发行包。");
  }
  return {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: ["dsh", "web", "--port", String(port)],
    cwd: forkRoot,
    shell: process.platform === "win32"
  };
}

async function readPidRecord(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function writePidRecord(file, record) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, "utf8");
  await rename(temporary, file);
}

async function removeOwnPid(file) {
  const record = await readPidRecord(file);
  if (Number(record?.pid) === process.pid) await unlink(file).catch(() => {});
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("API_CAPTURE_PORT 必须是有效端口。");
  const root = getApiCaptureHome();
  const logRoot = getApiCaptureLogHome();
  const pidFile = pidFilePath();
  await Promise.all([mkdir(root, { recursive: true }), mkdir(logRoot, { recursive: true })]);
  const logFile = path.join(logRoot, "companion.log");
  const logStream = createWriteStream(logFile, { flags: "a", encoding: "utf8" });
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    logStream.write(line);
    process.stdout.write(line);
  };

  const existingProbe = await probeHealth();
  if (isCompatibleHealth(existingProbe.health)) {
    log(`兼容的 Harness 已在 ${origin} 运行，直接复用。`);
    await openWorkbench();
    logStream.end();
    return;
  }
  if (existingProbe.reachable) throw new Error(`端口 ${port} 已被不兼容的本地服务占用。`);

  const previous = await readPidRecord(pidFile);
  if (isProcessAlive(Number(previous?.pid))) {
    log("检测到另一个 Companion 正在启动，等待其健康状态。");
    await waitForHealth(null, 15000);
    await openWorkbench();
    logStream.end();
    return;
  }
  if (previous) await unlink(pidFile).catch(() => {});

  const launch = await resolveLaunch();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: {
      ...process.env,
      DSH_HOME: path.join(root, "harness"),
      API_CAPTURE_EVIDENCE_HOME: path.join(root, "evidence"),
      API_CAPTURE_ANALYSIS_HOME: path.join(root, "analysis-workspace"),
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED || "1"
    },
    windowsHide: true,
    shell: launch.shell === true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.once("error", (error) => { child.launchError = error; });
  child.stdout?.on("data", (chunk) => { process.stdout.write(chunk); logStream.write(chunk); });
  child.stderr?.on("data", (chunk) => { process.stderr.write(chunk); logStream.write(chunk); });
  await writePidRecord(pidFile, {
    pid: process.pid,
    childPid: child.pid,
    port,
    surface: "native-harness",
    startedAt: new Date().toISOString(),
    logFile
  });
  log(`正在启动 Harness（PID ${child.pid}）。`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("收到停止信号，正在结束 Harness。");
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const health = await waitForHealth(child);
  log(`Harness 已就绪：${healthUrl}`);
  await openWorkbench();
  const code = await new Promise((resolve, reject) => {
    if (child.launchError) reject(child.launchError);
    else child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? (stopping ? 0 : 1)));
  });
  await removeOwnPid(pidFile);
  log(`Harness 已退出（${code}）。`);
  logStream.end();
  process.exitCode = code;
}

main().catch(async (error) => {
  await removeOwnPid(pidFilePath()).catch(() => {});
  console.error(String(error?.stack || error?.message || error));
  process.exitCode = 1;
});
