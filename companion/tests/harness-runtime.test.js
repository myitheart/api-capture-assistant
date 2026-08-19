import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolveHarnessRuntime } from "../src/harness/runtime.js";

const upstreamCommit = "47f943859bef60e4160492346772ded9b24f765a";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

test("显式 Harness 目录必须通过协议和关键文件校验，损坏时不静默回退", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aca-harness-runtime-"));
  const previous = process.env.API_CAPTURE_HARNESS_HOME;
  t.after(async () => {
    if (previous === undefined) delete process.env.API_CAPTURE_HARNESS_HOME;
    else process.env.API_CAPTURE_HARNESS_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const entry = "harness/entry.mjs";
  const config = "resources/cordis.yml";
  const node = "runtime/node.exe";
  const contents = new Map([[entry, "export {};\n"], [config, "plugins: []\n"], [node, "node-runtime"]]);
  for (const [relative, content] of contents) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const lock = JSON.parse(await readFile(new URL("../harness.lock.json", import.meta.url), "utf8"));
  await writeFile(path.join(root, "harness-build.json"), `${JSON.stringify({
    bridgeProtocolVersion: "1.0",
    evidenceProtocolVersion: "1.0",
    chatDraftProtocolVersion: "1.0",
    harnessVersion: "0.3.0",
    upstreamCommit,
    forkCommit: lock.forkCommit,
    buildFingerprint: lock.buildFingerprint,
    platform: "win32",
    arch: "x64",
    entry,
    config,
    checksums: Object.fromEntries([...contents].map(([relative, content]) => [relative, digest(content)]))
  }, null, 2)}\n`);
  process.env.API_CAPTURE_HARNESS_HOME = root;
  const runtime = await resolveHarnessRuntime();
  assert.equal(runtime.kind, "packaged");
  assert.equal(runtime.root, root);
  await writeFile(path.join(root, config), "tampered: true\n");
  await assert.rejects(() => resolveHarnessRuntime(), /文件校验失败/);
});
