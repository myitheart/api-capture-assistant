export const PERMISSION_MODES = Object.freeze({
  analyze: "read-only",
  modify: "workspace-write"
});

export function assertPermissionMode(permissionMode) {
  if (!Object.values(PERMISSION_MODES).includes(permissionMode)) {
    throw new Error(`不支持的 Harness 权限模式：${permissionMode || "空"}。`);
  }
}

export function buildHarnessEnvironment(config, permissionMode) {
  assertPermissionMode(permissionMode);
  return {
    DEEPSEEK_API_KEY: config.deepseekApiKey,
    DEEPSEEK_BASE_URL: config.deepseekBaseUrl,
    DSH_PERMISSION_MODE: permissionMode,
    DSH_TELEMETRY_MODE: "DISABLED"
  };
}
