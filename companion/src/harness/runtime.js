import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { harnessDistributionName, runtimeNodeName, SUPPORTED_TARGETS } from "../native-harness/platform.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const companionRoot = path.resolve(here, "../..");
const assistantRoot = path.resolve(companionRoot, "..");
const lockPath = path.join(companionRoot, "harness.lock.json");

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function assertCompatibility(lock, manifest) {
  for (const key of ["bridgeProtocolVersion", "evidenceProtocolVersion", "chatDraftProtocolVersion", "harnessVersion", "upstreamCommit", "forkCommit", "buildFingerprint"]) {
    if (lock[key] && manifest[key] !== lock[key]) {
      throw new Error(`Harness 构建不兼容：${key} 需要 ${lock[key]}，实际为 ${manifest[key] || "空"}。`);
    }
  }
  const targets = Array.isArray(lock.targets) ? lock.targets : SUPPORTED_TARGETS;
  if (!targets.some((target) => target.platform === manifest.platform && target.arch === manifest.arch)) {
    throw new Error(`Harness 构建目标未被 Companion 允许：${manifest.platform}-${manifest.arch}。`);
  }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(`Harness 构建与当前系统不匹配：需要 ${process.platform}-${process.arch}，实际为 ${manifest.platform}-${manifest.arch}。`);
  }
}

async function packagedRuntime(root, lock) {
  const manifestPath = path.join(root, "harness-build.json");
  if (!await exists(manifestPath)) return null;
  const manifest = await readJson(manifestPath);
  assertCompatibility(lock, manifest);
  const entry = path.resolve(root, manifest.entry);
  const config = path.resolve(root, manifest.config);
  const node = path.resolve(root, "runtime", runtimeNodeName());
  for (const file of [entry, config, node]) {
    if (!await exists(file)) throw new Error(`Harness 发行包文件缺失：${file}`);
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (manifest.checksums?.[relative] && await sha256(file) !== manifest.checksums[relative]) {
      throw new Error(`Harness 文件校验失败：${relative}。请重新下载发行包。`);
    }
  }
  return { kind: "packaged", root, command: node, args: [entry, config], manifest };
}

async function sourceRuntime(root, lock) {
  const marker = path.join(root, "FORK_NOTES.md");
  const entry = path.join(root, "packages", "examples", "jsonrpc-demo", "src", "bin.ts");
  const config = path.join(root, "apps", "api-capture-companion-host", "cordis.yml");
  if (!await exists(marker) || !await exists(entry) || !await exists(config)) return null;
  return {
    kind: "source",
    root,
    command: process.execPath,
    args: ["--import", "tsx/esm", entry, config],
    manifest: { ...lock, forkCommit: "working-tree", dirty: true }
  };
}

export async function resolveHarnessRuntime() {
  const lock = await readJson(lockPath);
  const explicit = String(process.env.API_CAPTURE_HARNESS_HOME || "").trim();
  const siblingFork = path.resolve(assistantRoot, "..", "api-capture-harness");
  const candidates = [
    assistantRoot,
    path.resolve(companionRoot, "..", "harness"),
    path.resolve(assistantRoot, "harness"),
    path.resolve(assistantRoot, "..", "api-capture-harness", "dist", harnessDistributionName()),
    siblingFork
  ].filter(Boolean);
  if (explicit) {
    try {
      const root = path.resolve(explicit);
      const runtime = await packagedRuntime(root, lock) || await sourceRuntime(root, lock);
      if (!runtime) throw new Error(`目录不是可识别的 Harness 源码或发行包：${root}`);
      return runtime;
    } catch (error) {
      throw new Error(`API_CAPTURE_HARNESS_HOME 指定的 Harness 不可用：${error?.message || error}`);
    }
  }
  const errors = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const root = path.resolve(candidate);
      const runtime = await packagedRuntime(root, lock) || await sourceRuntime(root, lock);
      if (runtime) return runtime;
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  const detail = errors.length ? `\n${errors.join("\n")}` : "";
  throw new Error(`未找到兼容的 API Capture Harness。开发环境请检出相邻的 api-capture-harness，发行环境请保留 harness 目录。${detail}`);
}

export async function inspectHarnessRuntime() {
  try {
    const runtime = await resolveHarnessRuntime();
    const { checksums, ...build } = runtime.manifest;
    return { ok: true, kind: runtime.kind, root: runtime.root, build, manifestFileCount: Object.keys(checksums || {}).length };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export async function attachBusinessProfile(runtime, runtimeRoot) {
  if (runtime.kind !== "packaged") return runtime;
  const pluginEntry = path.join(assistantRoot, "harness-plugin", "runtime", "index.js");
  if (!await exists(pluginEntry)) throw new Error(`Harness 业务证据插件缺失：${pluginEntry}`);
  const sourceConfig = runtime.args[1];
  const source = await readFile(sourceConfig, "utf8");
  const profileRoot = path.join(runtimeRoot, "profiles");
  await mkdir(profileRoot, { recursive: true });
  const profile = path.join(profileRoot, "api-capture-companion.yml");
  const pluginUrl = pathToFileURL(pluginEntry).href;
  const extension = [
    "",
    "# Added by API Capture Companion; the Fork profile above remains upstream-owned.",
    "- id: api-capture-evidence",
    `  name: ${JSON.stringify(pluginUrl)}`,
    "  config:",
    "    evidenceRoot: !!js process.env.DSH_EVIDENCE_ROOT ?? ''",
    "    sourceMode: !!js process.env.DSH_TASK_MODE ?? 'product'",
    ""
  ].join("\n");
  await writeFile(profile, `${source.trimEnd()}${extension}`, "utf8");
  return { ...runtime, args: [runtime.args[0], profile], businessProfile: profile };
}
