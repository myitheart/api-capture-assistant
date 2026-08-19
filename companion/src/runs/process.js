import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export class ProcessCancelledError extends Error {
  constructor(command) {
    super(`${command} 已由用户停止。`);
    this.name = "ProcessCancelledError";
    this.code = "PROCESS_CANCELLED";
  }
}

export class ProcessTimeoutError extends Error {
  constructor(command, timeoutMs) {
    super(`${command} 运行超过 ${Math.ceil(timeoutMs / 60000)} 分钟，已自动停止。`);
    this.name = "ProcessTimeoutError";
    this.code = "PROCESS_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export class ProcessExecutionError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "ProcessExecutionError";
    this.code = "PROCESS_FAILED";
    this.result = result;
  }
}

function resolveCommand(command, args, shell) {
  if (process.platform !== "win32" || command !== "npx" || shell) return { executable: command, args };
  const pathEntries = String(process.env.Path || process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const cli = path.join(entry.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", "npx-cli.js");
    if (existsSync(cli)) return { executable: process.execPath, args: [cli, ...args] };
  }
  return { executable: "npx.cmd", args };
}

export function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(command, args, Boolean(options.shell));
    const child = spawn(resolved.executable, resolved.args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: Boolean(options.shell),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stopReason = null;
    let settled = false;
    let forceTimer = null;
    const startedAt = new Date().toISOString();
    options.onStart?.({ pid: child.pid || null, startedAt });
    const append = (kind, chunk) => {
      const text = chunk.toString();
      if (kind === "stdout") stdout += text;
      else stderr += text;
      options.onOutput?.(kind, text);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new ProcessExecutionError(String(error?.message || error), { code: -1, signal: null, stdout, stderr }));
    });
    let timeout = null;
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (options.signal) options.signal.removeEventListener("abort", abortHandler);
      const result = { code: Number(code ?? -1), signal: signal || null, stdout, stderr };
      if (stopReason === "timeout") reject(new ProcessTimeoutError(command, options.timeoutMs));
      else if (stopReason === "cancelled") reject(new ProcessCancelledError(command));
      else if (code === 0 || options.allowFailure) resolve(result);
      else reject(new ProcessExecutionError(stderr.trim() || stdout.trim() || `${command} 执行失败（${code}）`, result));
    });
    const stop = (reason) => {
      if (stopReason || child.killed || settled) return;
      stopReason = reason;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
      } else {
        child.kill("SIGTERM");
      }
      forceTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5000);
      forceTimer.unref?.();
    };
    if (options.timeoutMs) timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    const abortHandler = () => stop("cancelled");
    if (options.signal) {
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}
