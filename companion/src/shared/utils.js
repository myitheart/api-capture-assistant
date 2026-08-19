import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(target) {
  await mkdir(target, { recursive: true });
  return target;
}

export async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(target, value) {
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, target);
        break;
      } catch (error) {
        if (process.platform !== "win32" || !new Set(["EPERM", "EACCES"]).has(error?.code) || attempt >= 7) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix = "task") {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function safeSegment(value, fallback = "task") {
  const safe = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safe || fallback;
}

export function safeFilename(value, fallback = "file.bin") {
  const safe = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 160);
  return safe || fallback;
}

export function publicError(error) {
  return String(error?.message || error || "未知错误");
}

export function assertString(value, name, { required = false, max = 4000 } = {}) {
  const result = String(value ?? "").trim();
  if (required && !result) throw new Error(`${name}不能为空。`);
  if (result.length > max) throw new Error(`${name}最多 ${max} 个字符。`);
  return result;
}

export function normalizePath(value) {
  return path.resolve(assertString(value, "项目路径", { required: true, max: 4096 }));
}
