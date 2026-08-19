import path from "node:path";
import { appendFile, readdir, rm, writeFile } from "node:fs/promises";
import { ensureDir, exists, readJson, safeFilename, safeSegment, writeJson } from "../shared/utils.js";

export class TaskStore {
  constructor(runtimeRoot) {
    this.runtimeRoot = runtimeRoot;
    this.tasksRoot = path.join(runtimeRoot, "tasks");
    this.writeQueues = new Map();
  }

  taskDir(taskId) {
    return path.join(this.tasksRoot, safeSegment(taskId));
  }

  taskFile(taskId) {
    return path.join(this.taskDir(taskId), "task-state.json");
  }

  async init() {
    await ensureDir(this.tasksRoot);
  }

  async save(task) {
    const taskId = task.id;
    const snapshot = structuredClone(task);
    const previous = this.writeQueues.get(taskId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => writeJson(this.taskFile(taskId), snapshot));
    this.writeQueues.set(taskId, pending);
    try {
      await pending;
    } finally {
      if (this.writeQueues.get(taskId) === pending) this.writeQueues.delete(taskId);
    }
    return task;
  }

  async get(taskId) {
    return readJson(this.taskFile(taskId), null);
  }

  async list() {
    await this.init();
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const task = await readJson(path.join(this.tasksRoot, entry.name, "task-state.json"), null);
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async appendLog(taskId, entry) {
    const file = path.join(this.taskDir(taskId), "events.jsonl");
    await ensureDir(path.dirname(file));
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async saveText(taskId, filename, text) {
    const target = path.join(this.taskDir(taskId), safeSegment(filename, "result.txt"));
    await ensureDir(path.dirname(target));
    await writeFile(target, String(text || ""), "utf8");
    return target;
  }

  async saveEvidence(taskId, payload) {
    const dir = this.taskDir(taskId);
    const evidenceDir = path.join(dir, "evidence");
    await ensureDir(evidenceDir);
    const screenshots = Array.isArray(payload.screenshots) ? payload.screenshots : [];
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const savedScreenshots = await this.#writeBinaryEntries(evidenceDir, "screenshots", screenshots);
    const savedAttachments = await this.#writeBinaryEntries(evidenceDir, "attachments", attachments);
    const stripped = { ...payload, screenshots: savedScreenshots, attachments: savedAttachments };
    await writeJson(path.join(evidenceDir, "delivery.json"), stripped);
    return {
      deliveryFile: path.join(evidenceDir, "delivery.json"),
      stepCount: Array.isArray(payload.steps) ? payload.steps.length : 0,
      networkCount: Array.isArray(payload.network) ? payload.network.length : 0,
      requirementPointCount: Array.isArray(payload.requirementPoints) ? payload.requirementPoints.length : 0,
      screenshotCount: screenshots.length,
      attachmentCount: attachments.length
    };
  }

  async #writeBinaryEntries(evidenceDir, folder, entries) {
    const targetDir = path.join(evidenceDir, folder);
    await ensureDir(targetDir);
    const manifest = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] || {};
      const originalName = safeFilename(entry.filename || entry.name || "file.bin");
      const filename = `${String(index + 1).padStart(3, "0")}_${originalName}`;
      const target = path.join(targetDir, filename);
      const bytes = Buffer.from(String(entry.base64 || ""), "base64");
      await writeFile(target, bytes);
      manifest.push({ ...entry, base64: undefined, filename, path: target, size: bytes.length });
    }
    await writeJson(path.join(targetDir, "manifest.json"), manifest);
    return manifest;
  }

  async remove(taskId) {
    const target = this.taskDir(taskId);
    if (await exists(target)) await rm(target, { recursive: true, force: true });
  }
}
