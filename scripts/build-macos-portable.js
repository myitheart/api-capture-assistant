import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(root, "dist");
const harnessSource = path.resolve(process.env.API_CAPTURE_HARNESS_DIST || path.join(root, "..", "api-capture-harness", "dist", "api-capture-harness-darwin-arm64"));
const output = path.join(distRoot, "api-capture-companion-macos-arm64");
const archive = `${output}.zip`;
const checksumFile = `${archive}.sha256`;
const app = path.join(output, "接口现场助手.app");
const contents = path.join(app, "Contents");
const macos = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");
const temporary = path.join(distRoot, ".api-capture-macos-build");

function assertMacBuildHost() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`macOS 便携包必须在 Apple Silicon Mac 上构建，当前为 ${process.platform}-${process.arch}。`);
  }
}

function assertInsideDist(target) {
  const relative = path.relative(distRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === "..") {
    throw new Error(`拒绝操作 dist 目录之外的路径：${target}`);
  }
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, { cwd: root, maxBuffer: 32 * 1024 * 1024, ...options });
  return String(result.stdout || "").trim();
}

async function copyRuntime(manifest) {
  await mkdir(path.join(resources, "companion", "src", "native-harness"), { recursive: true });
  await mkdir(path.join(resources, "companion", "src", "diagnostics"), { recursive: true });
  await mkdir(path.join(resources, "licenses"), { recursive: true });
  for (const filename of ["launcher.js", "platform.js"]) {
    await cp(path.join(root, "companion", "src", "native-harness", filename), path.join(resources, "companion", "src", "native-harness", filename));
  }
  await cp(path.join(root, "companion", "src", "diagnostics", "stop-companion.js"), path.join(resources, "companion", "src", "diagnostics", "stop-companion.js"));
  for (const directory of ["harness", "runtime"]) {
    // npm's portable runtime contains relative node_modules/.bin symlinks. The
    // default fs.cp behaviour resolves those links against the build checkout,
    // which leaves absolute Runner paths inside the app and makes codesign
    // reject the bundle. Preserve the link text so every destination remains
    // inside Contents/Resources after the distribution is copied.
    await cp(path.join(harnessSource, directory), path.join(resources, directory), {
      recursive: true,
      verbatimSymlinks: true
    });
  }
  await cp(path.join(harnessSource, "harness-build.json"), path.join(resources, "harness-build.json"));
  await cp(path.join(root, "LICENSE"), path.join(resources, "licenses", "COMPANION_LICENSE"));
  await cp(path.join(harnessSource, "LICENSE"), path.join(resources, "licenses", "HARNESS_LICENSE"));
  await cp(path.join(harnessSource, "THIRD_PARTY_NOTICES.md"), path.join(resources, "licenses", "THIRD_PARTY_NOTICES.md"));
  const entry = path.resolve(resources, manifest.entry);
  await readFile(entry);
}

async function buildIcon() {
  const source = path.join(temporary, "AppIcon-1024.png");
  const iconset = path.join(temporary, "AppIcon.iconset");
  await mkdir(iconset, { recursive: true });
  await run("xcrun", ["swift", path.join(root, "packaging", "macos", "GenerateIcon.swift"), source]);
  const sizes = [
    [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"], [1024, "icon_512x512@2x.png"]
  ];
  for (const [size, filename] of sizes) {
    await run("sips", ["-z", String(size), String(size), source, "--out", path.join(iconset, filename)]);
  }
  await run("iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "AppIcon.icns")]);
}

async function buildLauncher() {
  const executable = path.join(macos, "ApiCaptureLauncher");
  await run("xcrun", [
    "swiftc",
    "-swift-version", "5",
    "-target", "arm64-apple-macos13.5",
    "-framework", "AppKit",
    "-o", executable,
    path.join(root, "packaging", "macos", "ApiCaptureLauncher.swift")
  ]);
  await chmod(executable, 0o755);
}

async function writeInfoPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>接口现场助手</string>
  <key>CFBundleExecutable</key><string>ApiCaptureLauncher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.myitheart.apicaptureassistant.companion</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>接口现场助手</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.4.0</string>
  <key>CFBundleVersion</key><string>0.4.0</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
  await writeFile(path.join(contents, "Info.plist"), plist, "utf8");
  await run("plutil", ["-lint", path.join(contents, "Info.plist")]);
}

async function writeOuterFiles(manifest) {
  for (const filename of ["诊断并启动.command", "停止全部服务.command", "首次使用说明.html"]) {
    await cp(path.join(root, "packaging", "macos", filename), path.join(output, filename));
  }
  await Promise.all([
    chmod(path.join(output, "诊断并启动.command"), 0o755),
    chmod(path.join(output, "停止全部服务.command"), 0o755),
    chmod(path.join(resources, "runtime", "node"), 0o755)
  ]);
  await cp(path.join(root, "README.md"), path.join(output, "README.md"));
  await writeFile(path.join(output, "release.json"), `${JSON.stringify({
    product: "api-capture-companion-macos-arm64",
    companionVersion: "0.4.0",
    protocolVersion: "1.0",
    evidenceProtocolVersion: "1.0",
    chatDraftProtocolVersion: "1.0",
    minimumMacOSVersion: "13.5",
    signing: "ad-hoc",
    notarized: false,
    harness: Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "checksums")),
    harnessManifestFileCount: Object.keys(manifest.checksums || {}).length,
    builtAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

async function main() {
  assertMacBuildHost();
  for (const target of [output, archive, checksumFile, temporary]) assertInsideDist(target);
  const lock = JSON.parse(await readFile(path.join(root, "companion", "harness.lock.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(harnessSource, "harness-build.json"), "utf8"));
  const targetSupported = lock.targets?.some((target) => target.platform === "darwin" && target.arch === "arm64");
  if (manifest.bridgeProtocolVersion !== lock.bridgeProtocolVersion
    || manifest.evidenceProtocolVersion !== lock.evidenceProtocolVersion
    || manifest.chatDraftProtocolVersion !== lock.chatDraftProtocolVersion
    || manifest.harnessVersion !== lock.harnessVersion
    || manifest.upstreamCommit !== lock.upstreamCommit
    || manifest.forkCommit !== lock.forkCommit
    || manifest.platform !== "darwin"
    || manifest.arch !== "arm64"
    || !targetSupported) {
    throw new Error("Harness 构建与 Companion macOS arm64 协议不兼容。");
  }
  await Promise.all([
    rm(output, { recursive: true, force: true }),
    rm(archive, { force: true }),
    rm(checksumFile, { force: true }),
    rm(temporary, { recursive: true, force: true })
  ]);
  await Promise.all([mkdir(macos, { recursive: true }), mkdir(resources, { recursive: true }), mkdir(temporary, { recursive: true })]);
  await copyRuntime(manifest);
  await buildLauncher();
  await writeInfoPlist();
  await buildIcon();
  await writeOuterFiles(manifest);
  await run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", app]);
  await run("codesign", ["--verify", "--deep", "--strict", app]);
  const architecture = await run("file", [path.join(macos, "ApiCaptureLauncher")]);
  if (!/arm64/.test(architecture)) throw new Error(`启动器架构错误：${architecture}`);
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", output, archive]);
  const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(checksumFile, `${checksum}  ${path.basename(archive)}\n`, "utf8");
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ directory: output, archive, checksumFile }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
