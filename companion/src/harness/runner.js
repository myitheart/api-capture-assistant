import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { ensureDir } from "../shared/utils.js";
import { buildHarnessEnvironment } from "../../../harness-plugin/src/policies/index.js";
import { attachBusinessProfile, resolveHarnessRuntime } from "./runtime.js";

class HarnessStoppedError extends Error {
  constructor(reason, timeoutMs = 0) {
    super(reason === "timeout" ? `Harness 运行超过 ${Math.ceil(timeoutMs / 60000)} 分钟，已自动停止。` : "Harness 已由用户停止。");
    this.code = reason === "timeout" ? "PROCESS_TIMEOUT" : "PROCESS_CANCELLED";
  }
}

class JsonRpcHarnessHost {
  constructor({ runtime, cwd, env, model, sessionRoot, onOutput }) {
    Object.assign(this, { runtime, cwd, env, model, sessionRoot, onOutput });
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.child = null;
    this.closed = false;
  }

  async start() {
    if (this.child) return;
    await ensureDir(this.sessionRoot);
    const child = spawn(this.runtime.command, this.runtime.args, {
      cwd: this.runtime.root,
      env: { ...process.env, ...this.env, DSH_CWD: this.cwd, DSH_SESSION_ROOT: this.sessionRoot },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => this.onOutput?.("stderr", text));
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      this.child = null;
      if (!this.closed) this.#failAll(new Error(`Harness Host 意外退出（code=${code ?? "null"}, signal=${signal || "none"}）。`));
    });
    await this.request("initialize", { cwd: this.cwd, provider: "deepseek-official", model: this.model });
  }

  request(method, params) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Harness Host 尚未启动或已经关闭。"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  async run({ prompt, sessionId, signal, timeoutMs, onOutput }) {
    this.onOutput = onOutput;
    await this.start();
    const notifications = [];
    const assistantMessages = [];
    let runningSeen = false;
    let finish;
    let fail;
    const finished = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const listener = (frame) => {
      const params = frame.params || {};
      if (params.sessionId !== sessionId) return;
      notifications.push(frame);
      if (frame.method === "session.status") {
        if (params.status === "running") runningSeen = true;
        if (params.status === "idle" && runningSeen) finish();
      }
      if (frame.method === "session.event") {
        const event = params.event || {};
        if (event.type === "assistant/message") {
          const text = (event.data?.message?.content || []).filter((item) => item?.type === "text").map((item) => item.text || "").join("");
          if (text) { assistantMessages.push(text); onOutput?.("stdout", text); }
        } else if (/tool|approval|token|usage/i.test(event.type || "")) {
          onOutput?.("event", JSON.stringify({ type: event.type, data: event.data || {} }));
        }
      }
    };
    this.listeners.add(listener);
    let timer;
    const abort = () => fail(new HarnessStoppedError("cancelled"));
    if (signal) signal.addEventListener("abort", abort, { once: true });
    if (timeoutMs) timer = setTimeout(() => fail(new HarnessStoppedError("timeout", timeoutMs)), timeoutMs);
    try {
      await this.request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: prompt }] });
      await finished;
      return { code: 0, stdout: assistantMessages.at(-1) || "", stderr: "", notifications };
    } catch (error) {
      if (error?.code === "PROCESS_CANCELLED" || error?.code === "PROCESS_TIMEOUT") await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      this.listeners.delete(listener);
    }
  }

  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    try { await Promise.race([this.request("shutdown"), new Promise((resolve) => setTimeout(resolve, 1000))]); } catch {}
    if (child.exitCode === null && child.pid) {
      if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
      else child.kill("SIGTERM");
    }
    this.child = null;
    this.#failAll(new Error("Harness Host 已关闭。"));
  }

  #receive(line) {
    let frame;
    try { frame = JSON.parse(line); } catch { this.onOutput?.("stderr", `Harness 协议输出无法解析：${line}`); return; }
    if (frame.id !== undefined) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message || JSON.stringify(frame.error)));
      else pending.resolve(frame.result);
      return;
    }
    for (const listener of this.listeners) listener(frame);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class HarnessRunner {
  constructor(config, runtimeRoot) {
    this.config = config;
    this.runtimeRoot = runtimeRoot;
    this.hosts = new Map();
    this.runtimePromise = null;
  }

  validate() {
    if (!this.config.deepseekApiKey) throw new Error("尚未配置 DeepSeek API Key。请先在 Companion 设置中保存。 ");
    if (!this.config.deepseekModel) throw new Error("尚未配置 DeepSeek 模型名称。 ");
  }

  async run({ cwd, prompt, permissionMode, signal, onOutput, taskId, timeoutMs, sessionKind, evidenceRoot, sourceMode }) {
    this.validate();
    const kind = sessionKind || (permissionMode === "read-only" ? "analysis" : "implementation");
    const key = `${taskId}:${kind}`;
    let host = this.hosts.get(key);
    if (!host) {
      const runtime = await (this.runtimePromise ||= resolveHarnessRuntime().then((resolved) => attachBusinessProfile(resolved, this.runtimeRoot)));
      host = new JsonRpcHarnessHost({
        runtime,
        cwd,
        model: this.config.deepseekModel,
        sessionRoot: path.join(this.runtimeRoot, "harness-sessions", taskId, kind),
        env: { ...buildHarnessEnvironment(this.config, permissionMode), DSH_EVIDENCE_ROOT: evidenceRoot || "", DSH_TASK_MODE: sourceMode || "product" },
        onOutput
      });
      this.hosts.set(key, host);
    }
    try {
      return await host.run({ prompt, sessionId: `${taskId}-${kind}`, signal, timeoutMs, onOutput });
    } catch (error) {
      if (error?.code === "PROCESS_CANCELLED" || error?.code === "PROCESS_TIMEOUT") this.hosts.delete(key);
      throw error;
    }
  }

  async closeTask(taskId) {
    const entries = [...this.hosts.entries()].filter(([key]) => key.startsWith(`${taskId}:`));
    await Promise.allSettled(entries.map(async ([key, host]) => { this.hosts.delete(key); await host.close(); }));
  }

  async close() {
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.allSettled(hosts.map((host) => host.close()));
  }
}
