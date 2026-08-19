import path from "node:path";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessSource = path.resolve(process.env.API_CAPTURE_HARNESS_DIST || path.join(root, "..", "api-capture-harness", "dist", "api-capture-harness-win-x64"));
const output = path.join(root, "dist", "api-capture-companion-win-x64");
const archive = `${output}.zip`;

async function main() {
  const lock = JSON.parse(await readFile(path.join(root, "companion", "harness.lock.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(harnessSource, "harness-build.json"), "utf8"));
  const targetSupported = lock.targets?.some((target) => target.platform === "win32" && target.arch === "x64");
  if (manifest.bridgeProtocolVersion !== lock.bridgeProtocolVersion
    || manifest.evidenceProtocolVersion !== lock.evidenceProtocolVersion
    || manifest.chatDraftProtocolVersion !== lock.chatDraftProtocolVersion
    || manifest.harnessVersion !== lock.harnessVersion
    || manifest.upstreamCommit !== lock.upstreamCommit
    || manifest.forkCommit !== lock.forkCommit
    || manifest.platform !== "win32"
    || manifest.arch !== "x64"
    || !targetSupported) {
    throw new Error("Harness 构建与 Companion Windows x64 协议不兼容。 ");
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await mkdir(path.join(output, "companion", "src", "native-harness"), { recursive: true });
  await mkdir(path.join(output, "companion", "src", "diagnostics"), { recursive: true });
  await cp(path.join(root, "companion", "src", "native-harness", "launcher.js"), path.join(output, "companion", "src", "native-harness", "launcher.js"));
  await cp(path.join(root, "companion", "src", "native-harness", "platform.js"), path.join(output, "companion", "src", "native-harness", "platform.js"));
  await cp(path.join(root, "companion", "src", "diagnostics", "stop-companion.js"), path.join(output, "companion", "src", "diagnostics", "stop-companion.js"));
  for (const directory of ["harness", "runtime"]) {
    await cp(path.join(harnessSource, directory), path.join(output, directory), { recursive: true });
  }
  for (const file of ["harness-build.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await cp(path.join(harnessSource, file), path.join(output, file));
  }
  await cp(path.join(root, "LICENSE"), path.join(output, "COMPANION_LICENSE"));
  await cp(path.join(root, "packaging", "启动本地研发助手.cmd"), path.join(output, "启动本地研发助手.cmd"));
  await cp(path.join(root, "packaging", "停止本地研发助手.cmd"), path.join(output, "停止本地研发助手.cmd"));
  await cp(path.join(root, "packaging", "启动本地研发助手.cmd"), path.join(output, "start-companion.cmd"));
  await cp(path.join(root, "packaging", "停止本地研发助手.cmd"), path.join(output, "stop-companion.cmd"));
  await cp(path.join(root, "README.md"), path.join(output, "README.md"));
  await writeFile(path.join(output, "release.json"), `${JSON.stringify({
    product: "api-capture-companion-win-x64",
    companionVersion: "0.4.0",
    protocolVersion: "1.0",
    evidenceProtocolVersion: "1.0",
    chatDraftProtocolVersion: "1.0",
    harness: Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "checksums")),
    harnessManifestFileCount: Object.keys(manifest.checksums || {}).length,
    builtAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  await rm(archive, { force: true });
  await execFileAsync("tar.exe", [
    "-a",
    "-c",
    "-f",
    archive,
    "-C",
    path.dirname(output),
    path.basename(output)
  ], { windowsHide: true });
  console.log(JSON.stringify({ directory: output, archive }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
