import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SUPPORTED_TARGETS = Object.freeze([
  Object.freeze({ platform: "win32", arch: "x64" }),
  Object.freeze({ platform: "darwin", arch: "arm64" })
]);

export function assertSupportedTarget(platform = process.platform, arch = process.arch) {
  const supported = SUPPORTED_TARGETS.some((target) => target.platform === platform && target.arch === arch);
  if (!supported) throw new Error(`接口现场助手暂不支持 ${platform}-${arch}。`);
  return { platform, arch };
}

export function runtimeNodeName(platform = process.platform) {
  return platform === "win32" ? "node.exe" : "node";
}

export function harnessDistributionName(platform = process.platform, arch = process.arch) {
  const label = platform === "win32" ? "win" : platform;
  return `api-capture-harness-${label}-${arch}`;
}

export function companionDistributionName(platform = process.platform, arch = process.arch) {
  const label = platform === "darwin" ? "macos" : platform === "win32" ? "win" : platform;
  return `api-capture-companion-${label}-${arch}`;
}

export function getApiCaptureHome({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (String(env.API_CAPTURE_HOME || "").trim()) return path.resolve(env.API_CAPTURE_HOME);
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
    return path.join(base, "ApiCaptureAssistant");
  }
  if (platform === "darwin") return path.join(homedir, "Library", "Application Support", "ApiCaptureAssistant");
  const base = env.XDG_DATA_HOME || path.join(homedir, ".local", "share");
  return path.join(base, "ApiCaptureAssistant");
}

export function getApiCaptureLogHome({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (String(env.API_CAPTURE_LOG_HOME || "").trim()) return path.resolve(env.API_CAPTURE_LOG_HOME);
  if (platform === "win32") return path.join(getApiCaptureHome({ env, platform, homedir }), "logs");
  if (platform === "darwin") return path.join(homedir, "Library", "Logs", "ApiCaptureAssistant");
  const base = env.XDG_STATE_HOME || path.join(homedir, ".local", "state");
  return path.join(base, "ApiCaptureAssistant", "logs");
}

export function pidFilePath(options = {}) {
  return path.join(getApiCaptureHome(options), "companion.pid");
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function processCommandLine(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "";
  if (platform === "win32") {
    const command = `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`;
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }).catch(() => ({ stdout: "" }));
    return String(result.stdout || "").trim();
  }
  const result = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { windowsHide: true }).catch(() => ({ stdout: "" }));
  return String(result.stdout || "").trim();
}

export function isCompanionLauncherCommand(commandLine) {
  return /companion[\\/]src[\\/]native-harness[\\/]launcher\.js(?:\s|$|["'])/i.test(String(commandLine || ""));
}

export function isHarnessCommand(commandLine) {
  return /(?:@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js|\bdsh(?:\.cmd)?\s+web\b)/i.test(String(commandLine || ""));
}
