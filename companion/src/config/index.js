import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, DEFAULT_PORT } from "../constants.js";
import { readJson, writeJson } from "../shared/utils.js";
import { getApiCaptureHome } from "../native-harness/platform.js";

const companionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function getCompanionRoot() {
  return companionRoot;
}

export function getRuntimeRoot() {
  const userDataRoot = path.join(getApiCaptureHome(), "Companion");
  return path.resolve(process.env.API_CAPTURE_COMPANION_HOME || userDataRoot);
}

export function getConfigPath() {
  return path.resolve(process.env.API_CAPTURE_COMPANION_CONFIG || path.join(getRuntimeRoot(), "config.json"));
}

export function normalizeConfig(input = {}) {
  const host = String(input.host || DEFAULT_HOST).trim();
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error("MVP0 仅允许 Companion 监听本机回环地址。 ");
  }
  const port = Number(input.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口必须是 1024-65535 的整数。 ");
  const baseUrl = String(input.deepseekBaseUrl || "https://api.deepseek.com").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("DeepSeek Base URL 必须以 http:// 或 https:// 开头。 ");
  const timeoutMinutes = (value, fallback, label) => {
    const number = Number(value ?? fallback);
    if (!Number.isFinite(number) || number < 1 || number > 240) throw new Error(`${label}必须是 1-240 分钟。`);
    return Math.round(number);
  };
  return {
    host,
    port,
    deepseekApiKey: String(input.deepseekApiKey || "").trim(),
    deepseekModel: String(input.deepseekModel || "deepseek-v4-flash").trim(),
    deepseekBaseUrl: baseUrl,
    maxRequestBytes: Math.min(512 * 1024 * 1024, Math.max(1024 * 1024, Number(input.maxRequestBytes || 512 * 1024 * 1024))),
    analysisTimeoutMinutes: timeoutMinutes(input.analysisTimeoutMinutes, 30, "只读分析超时"),
    modifyTimeoutMinutes: timeoutMinutes(input.modifyTimeoutMinutes, 60, "代码修改超时"),
    testTimeoutMinutes: timeoutMinutes(input.testTimeoutMinutes, 30, "测试超时")
  };
}

export async function loadConfig() {
  return normalizeConfig(await readJson(getConfigPath(), {}));
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = normalizeConfig({ ...current, ...patch });
  await writeJson(getConfigPath(), next);
  return next;
}

export function redactConfig(config) {
  return {
    ...config,
    deepseekApiKey: "",
    apiKeyConfigured: Boolean(config.deepseekApiKey),
    configPath: getConfigPath(),
    runtimeRoot: getRuntimeRoot()
  };
}
