import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

export const name = "api-capture-evidence";
export const inject = ["tools", "systemPrompt"];

function confined(root, relativePath) {
  const base = path.resolve(String(root || ""));
  if (!base || base === path.parse(base).root) throw new Error("Evidence root is not configured safely.");
  const requested = String(relativePath || "").replaceAll("\\", "/");
  if (!requested || path.isAbsolute(requested) || requested.split("/").includes("..")) throw new Error("relative_path must stay inside the task evidence directory.");
  const target = path.resolve(base, requested);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Evidence path escapes the task directory.");
  return target;
}

async function readDelivery(root) {
  return JSON.parse(await readFile(confined(root, "delivery.json"), "utf8"));
}

function textResult(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function jsonTool({ name, description, parameters, execute }) {
  return {
    name,
    description,
    parameters: { type: "object", additionalProperties: false, properties: parameters.properties || {}, required: parameters.required || [] },
    output: { schema: { description: "JSON evidence result." }, render: (_args, value) => textResult(value) },
    isConcurrencySafe: () => true,
    execute
  };
}

export function apply(ctx, config = {}) {
  const evidenceRoot = String(config.evidenceRoot || process.env.DSH_EVIDENCE_ROOT || "");
  const sourceMode = String(config.sourceMode || process.env.DSH_TASK_MODE || "product");
  ctx.systemPrompt.section({
    name: "api-capture-evidence",
    order: 108,
    text: `This task comes from API Capture Assistant ${sourceMode} mode. Use api_capture_evidence_summary first, then load only evidence relevant to the current question. Do not enumerate or repeat secrets.`
  });
  ctx.tools.register(jsonTool({
    name: "api_capture_evidence_summary",
    description: "Summarize the current API Capture task evidence without scanning the source repository.",
    parameters: { properties: {} },
    async execute() {
      const delivery = await readDelivery(evidenceRoot);
      return {
        sourceMode,
        goal: delivery.goal || delivery.task?.goal || "",
        requestNote: delivery.requestNote || delivery.task?.requestNote || "",
        steps: Array.isArray(delivery.steps) ? delivery.steps.length : 0,
        network: Array.isArray(delivery.network) ? delivery.network.length : 0,
        screenshots: Array.isArray(delivery.screenshots) ? delivery.screenshots.length : 0,
        requirementPoints: Array.isArray(delivery.requirementPoints) ? delivery.requirementPoints.length : 0,
        topLevelFields: Object.keys(delivery).sort()
      };
    }
  }));
  ctx.tools.register(jsonTool({
    name: "api_capture_evidence_files",
    description: "List task evidence files and sizes. Use this before opening a screenshot manifest or attachment.",
    parameters: { properties: {} },
    async execute() {
      const files = [];
      async function visit(current, prefix = "") {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(path.join(current, entry.name), relative);
          else if (entry.isFile()) files.push({ path: relative, size: (await stat(path.join(current, entry.name))).size });
          if (files.length >= 500) return;
        }
      }
      await visit(path.resolve(evidenceRoot));
      return { files, truncated: files.length >= 500 };
    }
  }));
  ctx.tools.register(jsonTool({
    name: "api_capture_evidence_read",
    description: "Read one UTF-8 evidence JSON or text file by relative path. Binary screenshots should be opened with the standard image tool using the path from their manifest.",
    parameters: {
      required: ["relative_path"],
      properties: {
        relative_path: { type: "string", description: "Path relative to the task evidence directory." },
        max_chars: { type: "integer", minimum: 1000, maximum: 100000, description: "Maximum returned characters; defaults to 30000." }
      }
    },
    async execute(args) {
      const limit = Math.max(1000, Math.min(100000, Number(args?.max_chars) || 30000));
      const content = await readFile(confined(evidenceRoot, args?.relative_path), "utf8");
      return { path: args.relative_path, content: content.slice(0, limit), truncated: content.length > limit };
    }
  }));
  ctx.tools.register(jsonTool({
    name: "api_capture_network_find",
    description: "Find selected product or developer Network evidence by URL, method, status, request id, or response text. Returns only a small bounded set.",
    parameters: {
      required: ["query"],
      properties: {
        query: { type: "string", description: "Case-insensitive request id, URL, method, status, or text fragment." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Maximum matches; defaults to 5." }
      }
    },
    async execute(args) {
      const delivery = await readDelivery(evidenceRoot);
      const query = String(args?.query || "").toLowerCase();
      const limit = Math.max(1, Math.min(10, Number(args?.limit) || 5));
      const matches = (Array.isArray(delivery.network) ? delivery.network : []).filter((record) => JSON.stringify(record).toLowerCase().includes(query)).slice(0, limit);
      return { query: args.query, matches, returned: matches.length };
    }
  }));
}
