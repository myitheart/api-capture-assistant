import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import {
  isCompanionLauncherCommand,
  isHarnessCommand,
  isProcessAlive,
  pidFilePath,
  processCommandLine
} from "../native-harness/platform.js";

const exec = promisify(execFile);
const pidFile = pidFilePath();

async function waitUntilStopped(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !isProcessAlive(pid);
}

async function verifiedPid(pid, predicate, label) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error(`${label} PID 记录无效，已拒绝停止。`);
  if (!isProcessAlive(pid)) return false;
  const commandLine = await processCommandLine(pid);
  if (!predicate(commandLine)) throw new Error(`${label} PID 已被其他程序占用，未终止任何进程。`);
  return true;
}

async function stopPosixProcess(pid, predicate, label) {
  if (!await verifiedPid(pid, predicate, label)) return;
  process.kill(pid, "SIGTERM");
  if (await waitUntilStopped(pid, 5000)) return;
  const commandLine = await processCommandLine(pid);
  if (!predicate(commandLine)) throw new Error(`${label} 在等待期间发生变化，已拒绝强制终止。`);
  process.kill(pid, "SIGKILL");
  await waitUntilStopped(pid, 2000);
}

async function main() {
  let record;
  try { record = JSON.parse(await readFile(pidFile, "utf8")); } catch {
    console.log("本地研发助手当前没有运行记录。");
    return;
  }
  const pid = Number(record.pid);
  if (process.platform === "win32") {
    if (!await verifiedPid(pid, isCompanionLauncherCommand, "Companion")) {
      await unlink(pidFile).catch(() => {});
      console.log("本地研发助手已经停止。");
      return;
    }
    await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    await stopPosixProcess(pid, isCompanionLauncherCommand, "Companion");
    const childPid = Number(record.childPid);
    if (Number.isSafeInteger(childPid) && childPid > 0 && isProcessAlive(childPid)) {
      await stopPosixProcess(childPid, isHarnessCommand, "Harness");
    }
  }
  await unlink(pidFile).catch(() => {});
  console.log("本地研发助手已停止。");
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});
