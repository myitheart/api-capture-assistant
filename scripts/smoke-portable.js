import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const defaultProduct = process.platform === "darwin" ? "api-capture-companion-macos-arm64" : "api-capture-companion-win-x64";
const bundle = path.resolve(process.env.API_CAPTURE_PORTABLE_ROOT || path.join(root, "dist", defaultProduct));
const runtimeRoot = process.platform === "darwin"
  ? path.join(bundle, "接口现场助手.app", "Contents", "Resources")
  : bundle;
const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "harness-build.json"), "utf8"));
const node = path.join(runtimeRoot, "runtime", process.platform === "win32" ? "node.exe" : "node");
const entry = path.resolve(runtimeRoot, manifest.entry);
const temporary = await mkdtemp(path.join(os.tmpdir(), "aca-native-harness-smoke-"));
const port = 44000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;

async function waitForHealth(child, stderr) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Native Harness exited early (${child.exitCode}).\n${stderr.value}`);
    try {
      const response = await fetch(`${origin}/api-capture/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.ok && health.surface === "native-harness") return health;
    } catch {
      // The native Web host is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Native Harness health check timed out.\n${stderr.value}`);
}

async function stopProcessTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
}

const child = spawn(node, [entry, "web", "--port", String(port)], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    DSH_HOME: path.join(temporary, "harness"),
    API_CAPTURE_EVIDENCE_HOME: path.join(temporary, "evidence"),
    API_CAPTURE_ANALYSIS_HOME: path.join(temporary, "analysis-workspace"),
    DSH_TELEMETRY_DISABLED: "1"
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
const stderr = { value: "" };
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr.value += chunk; });

try {
  const health = await waitForHealth(child, stderr);
  if (health.protocolVersion !== "1.0" || health.evidenceProtocolVersion !== "1.0" || health.chatDraftProtocolVersion !== "1.0") {
    throw new Error(`Portable runtime protocol mismatch: ${JSON.stringify(health)}`);
  }
  const page = await fetch(origin);
  const html = await page.text();
  if (!page.ok || !/DeepSeek Harness/i.test(html)) throw new Error("Portable runtime did not serve the native DeepSeek Harness page.");

  const evidenceFiles = [
    ["index", "index.md", "text/markdown", "# Portable evidence\n"],
    ["task", "task.json", "application/json", '{"id":"portable-smoke"}\n'],
    ["requirement", "requirement.md", "text/markdown", "# Requirement\n"],
    ["steps", "steps.json", "application/json", "[]\n"],
    ["network-index", "network/index.json", "application/json", '{"requests":[]}\n']
  ];
  const evidenceCreated = await fetch(`${origin}/api-capture/evidence-packages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiCaptureEvidenceVersion: "1.0",
      taskId: "portable-smoke",
      mode: "developer",
      title: "Portable smoke evidence",
      source: { extensionVersion: "0.9.0" },
      files: evidenceFiles.map(([fileId, relativePath, mediaType, body]) => ({
        fileId, relativePath, mediaType, bytes: Buffer.byteLength(body)
      }))
    })
  });
  const evidenceTransaction = await evidenceCreated.json();
  if (evidenceCreated.status !== 201 || !evidenceTransaction.packageId) throw new Error(`Evidence creation failed: ${JSON.stringify(evidenceTransaction)}`);
  for (const [fileId, _relativePath, mediaType, body] of evidenceFiles) {
    const uploaded = await fetch(`${origin}/api-capture/evidence-packages/${evidenceTransaction.packageId}/files/${fileId}`, {
      method: "PUT", headers: { "Content-Type": mediaType }, body
    });
    if (!uploaded.ok) throw new Error(`Evidence upload failed: ${await uploaded.text()}`);
  }
  const finalizedResponse = await fetch(`${origin}/api-capture/evidence-packages/${evidenceTransaction.packageId}/finalize`, { method: "POST" });
  const finalized = await finalizedResponse.json();
  if (!finalizedResponse.ok || !finalized.indexPath || await readFile(finalized.indexPath, "utf8") !== "# Portable evidence\n") {
    throw new Error(`Evidence finalization failed: ${JSON.stringify(finalized)}`);
  }

  const created = await fetch(`${origin}/api-capture/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "# Portable smoke Prompt\n\nThis text must remain an editable draft." })
  });
  const draft = await created.json();
  if (created.status !== 201 || !draft.draftId || !draft.openUrl) throw new Error(`Draft creation failed: ${JSON.stringify(draft)}`);
  const consumed = await fetch(`${origin}/api-capture/drafts/${encodeURIComponent(draft.draftId)}`);
  const payload = await consumed.json();
  if (!consumed.ok || payload.prompt !== "# Portable smoke Prompt\n\nThis text must remain an editable draft.") {
    throw new Error(`Draft contents changed: ${JSON.stringify(payload)}`);
  }
  const secondRead = await fetch(`${origin}/api-capture/drafts/${encodeURIComponent(draft.draftId)}`);
  if (secondRead.status !== 404) throw new Error("Draft was not consumed exactly once.");
  const rejected = await fetch(`${origin}/api-capture/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "strict contract", workspacePath: "C:\\must-not-be-accepted" })
  });
  if (rejected.status !== 400) throw new Error("Draft bridge accepted fields other than prompt.");

  const chatCreated = await fetch(`${origin}/api-capture/chat-drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "# Product field analysis\n\nKeep this editable and do not submit it." })
  });
  const chatDraft = await chatCreated.json();
  if (chatCreated.status !== 201 || !chatDraft.draftId || !chatDraft.openUrl) {
    throw new Error(`Chat draft creation failed: ${JSON.stringify(chatDraft)}`);
  }
  await access(path.join(temporary, "analysis-workspace"));
  const firstChatRead = await fetch(`${origin}/api-capture/chat-drafts/${encodeURIComponent(chatDraft.draftId)}`);
  const chatPayload = await firstChatRead.json();
  if (!firstChatRead.ok || chatPayload.prompt !== "# Product field analysis\n\nKeep this editable and do not submit it." || chatPayload.agentPreset !== "api-capture-analysis") {
    throw new Error(`Chat draft contents changed: ${JSON.stringify(chatPayload)}`);
  }
  const retryChatRead = await fetch(`${origin}/api-capture/chat-drafts/${encodeURIComponent(chatDraft.draftId)}`);
  if (!retryChatRead.ok) throw new Error("Chat draft was consumed before the native composer acknowledged it.");
  const chatAcknowledged = await fetch(`${origin}/api-capture/chat-drafts/${encodeURIComponent(chatDraft.draftId)}`, { method: "DELETE" });
  if (!chatAcknowledged.ok) throw new Error(`Chat draft acknowledgement failed: ${await chatAcknowledged.text()}`);
  const afterAcknowledgement = await fetch(`${origin}/api-capture/chat-drafts/${encodeURIComponent(chatDraft.draftId)}`);
  if (afterAcknowledgement.status !== 404) throw new Error("Chat draft remained available after acknowledgement.");
  const rejectedChat = await fetch(`${origin}/api-capture/chat-drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "strict product contract", projectPath: "C:\\must-not-be-accepted" })
  });
  if (rejectedChat.status !== 400) throw new Error("Chat draft bridge accepted fields other than prompt.");

  const deleted = await fetch(`${origin}/api-capture/evidence-packages/${evidenceTransaction.packageId}`, { method: "DELETE" });
  if (!deleted.ok) throw new Error(`Evidence cleanup failed: ${await deleted.text()}`);

  console.log(JSON.stringify({
    ok: true,
    surface: health.surface,
    protocolVersion: health.protocolVersion,
    evidenceProtocolVersion: health.evidenceProtocolVersion,
    chatDraftProtocolVersion: health.chatDraftProtocolVersion
  }, null, 2));
} finally {
  await stopProcessTree(child);
  await rm(temporary, { recursive: true, force: true });
}
