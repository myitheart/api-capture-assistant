export const PROTOCOL_VERSION = "1.0";

export const TASK_STATES = Object.freeze([
  "received",
  "analyzing",
  "awaiting_approval",
  "modifying",
  "testing",
  "ready_to_commit",
  "committed",
  "merged",
  "failed",
  "cancelled"
]);

export const RUNNING_STATES = new Set(["analyzing", "modifying", "testing"]);

export function assertCompatibleProtocol(version) {
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`任务协议不兼容：本地研发助手需要 ${PROTOCOL_VERSION}，收到 ${version || "空"}。`);
  }
}
