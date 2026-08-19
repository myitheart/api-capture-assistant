import http from "node:http";
import path from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { COMPANION_VERSION, PROTOCOL_VERSION } from "../constants.js";
import { loadConfig, redactConfig, saveConfig, getRuntimeRoot } from "../config/index.js";
import { TaskStore } from "../tasks/store.js";
import { HarnessRunner } from "../harness/runner.js";
import { TaskService } from "../tasks/service.js";
import { checkEnvironment } from "../diagnostics/check-environment.js";
import { ensureDir, publicError } from "../shared/utils.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, "../../ui");

function allowedOrigin(origin, host, port) {
  if (!origin) return "";
  if (origin.startsWith("chrome-extension://")) return origin;
  if (origin === `http://${host}:${port}` || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`) return origin;
  return null;
}

function setCors(request, response, config) {
  const origin = allowedOrigin(request.headers.origin, config.host, config.port);
  if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  return request.headers.origin ? origin !== null : true;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  response.end(body);
}

async function readJsonBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求体超过 Companion 允许的大小。"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是有效 JSON。"), { statusCode: 400 });
  }
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(publicRoot, requested);
  if (!target.startsWith(`${publicRoot}${path.sep}`) && target !== path.join(publicRoot, "index.html")) return false;
  let bytes;
  try {
    bytes = await readFile(target);
  } catch {
    return false;
  }
  const ext = path.extname(target);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
  response.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-cache" });
  response.end(bytes);
  return true;
}

export async function createCompanionServer(overrides = {}) {
  const config = overrides.config || await loadConfig();
  const runtimeRoot = overrides.runtimeRoot || getRuntimeRoot();
  const store = overrides.store || new TaskStore(runtimeRoot);
  const harness = overrides.harness || new HarnessRunner(config, runtimeRoot);
  const service = overrides.service || new TaskService({
    store,
    harness,
    runtimeRoot,
    getTimeouts: () => ({
      analyze: Number(config.analysisTimeoutMinutes || 30) * 60000,
      modify: Number(config.modifyTimeoutMinutes || 60) * 60000,
      test: Number(config.testTimeoutMinutes || 30) * 60000
    })
  });
  await service.init();

  const server = http.createServer(async (request, response) => {
    try {
      if (!setCors(request, response, config)) {
        sendJson(response, 403, { ok: false, error: "MVP0 仅接受插件和本机控制台请求。" });
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      const url = new URL(request.url || "/", `http://${config.host}:${config.port}`);
      const pathname = url.pathname;
      if (pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true, companionVersion: COMPANION_VERSION, protocolVersion: PROTOCOL_VERSION, apiKeyConfigured: Boolean(config.deepseekApiKey) });
        return;
      }
      if (pathname === "/api/environment" && request.method === "GET") {
        sendJson(response, 200, { ok: true, environment: await checkEnvironment() });
        return;
      }
      if (pathname === "/api/config" && request.method === "GET") {
        sendJson(response, 200, { ok: true, config: redactConfig(config) });
        return;
      }
      if (pathname === "/api/config" && request.method === "PUT") {
        const body = await readJsonBody(request, 1024 * 1024);
        const patch = { ...body };
        if (!String(patch.deepseekApiKey || "").trim()) delete patch.deepseekApiKey;
        const previousPort = config.port;
        const next = await saveConfig(patch);
        Object.assign(config, next);
        sendJson(response, 200, { ok: true, config: redactConfig(config), restartRequired: config.port !== previousPort });
        return;
      }
      if (pathname === "/api/projects/inspect" && request.method === "POST") {
        const body = await readJsonBody(request, 1024 * 1024);
        sendJson(response, 200, { ok: true, repository: await service.inspect(body.projectPath, body.targetBranch) });
        return;
      }
      if (pathname === "/api/tasks" && request.method === "GET") {
        sendJson(response, 200, { ok: true, tasks: await service.list() });
        return;
      }
      if (pathname === "/api/tasks" && request.method === "POST") {
        const body = await readJsonBody(request, config.maxRequestBytes);
        sendJson(response, 201, { ok: true, task: await service.create(body) });
        return;
      }
      const match = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([^/]+))?$/);
      if (match) {
        const taskId = decodeURIComponent(match[1]);
        const action = match[2] || "";
        if (!action && request.method === "GET") {
          sendJson(response, 200, { ok: true, task: await service.get(taskId) });
          return;
        }
        if (request.method === "POST") {
          const body = await readJsonBody(request, 1024 * 1024);
          if (action === "analyze" || action === "chat") sendJson(response, 202, { ok: true, task: await service.analyze(taskId, body.message) });
          else if (action === "modify") sendJson(response, 202, { ok: true, task: await service.modify(taskId) });
          else if (action === "cancel") sendJson(response, 200, { ok: true, task: await service.cancel(taskId) });
          else if (action === "commit") sendJson(response, 200, { ok: true, task: await service.commit(taskId, body.message) });
          else if (action === "merge") sendJson(response, 200, { ok: true, task: await service.merge(taskId) });
          else if (action === "cleanup") sendJson(response, 200, { ok: true, task: await service.cleanup(taskId, body) });
          else sendJson(response, 404, { ok: false, error: "未知任务动作。" });
          return;
        }
      }
      if (request.method === "GET" && !pathname.startsWith("/api/") && await serveStatic(response, pathname)) return;
      sendJson(response, 404, { ok: false, error: "未找到接口。" });
    } catch (error) {
      sendJson(response, Number(error?.statusCode || 400), { ok: false, error: publicError(error) });
    }
  });
  return { server, service, config, harness, runtimeRoot };
}

async function main() {
  const { server, config, harness, runtimeRoot } = await createCompanionServer();
  const pidFile = path.join(runtimeRoot, "companion.pid");
  server.listen(config.port, config.host, async () => {
    await ensureDir(runtimeRoot);
    await writeFile(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), entry: fileURLToPath(import.meta.url) }), "utf8");
    console.log(`接口现场助手 Companion 已启动：http://${config.host}:${config.port}`);
    console.log("数据仅保存在本机；按 Ctrl+C 停止。 ");
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") console.error(`端口 ${config.port} 已被占用，请关闭旧进程或修改 config.local.json。`);
    else console.error(error);
    process.exitCode = 1;
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await harness.close?.();
    await new Promise((resolve) => server.close(resolve));
    await unlink(pidFile).catch(() => {});
  };
  process.once("SIGINT", () => stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => stop().finally(() => process.exit(0)));
  process.once("exit", () => { unlink(pidFile).catch(() => {}); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
