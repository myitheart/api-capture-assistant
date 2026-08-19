import AppKit
import Darwin
import Foundation

private struct HarnessHealth: Decodable {
    let ok: Bool
    let surface: String
    let protocolVersion: String
    let evidenceProtocolVersion: String
    let chatDraftProtocolVersion: String
}

private struct HealthProbe {
    let reachable: Bool
    let health: HarnessHealth?
}

private enum LauncherFailure: LocalizedError {
    case missingFile(String)
    case incompatiblePort
    case startupTimeout
    case processExited(Int32)

    var errorDescription: String? {
        switch self {
        case .missingFile(let path): return "发行包文件缺失：\(path)。请重新解压完整 ZIP。"
        case .incompatiblePort: return "端口 43110 已被其他本地程序占用。"
        case .startupTimeout: return "Harness 启动超过 60 秒，请查看日志。"
        case .processExited(let code): return "Harness 启动进程已退出（\(code)）。"
        }
    }
}

private final class CompanionController {
    let resources: URL
    let node: URL
    let launcher: URL
    let stopper: URL
    let origin: URL
    let logDirectory: URL
    let logFile: URL
    private(set) var process: Process?

    init() {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        self.resources = Bundle.main.resourceURL
            ?? executable.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources")
        self.node = resources.appendingPathComponent("runtime/node")
        self.launcher = resources.appendingPathComponent("companion/src/native-harness/launcher.js")
        self.stopper = resources.appendingPathComponent("companion/src/diagnostics/stop-companion.js")
        let port = ProcessInfo.processInfo.environment["API_CAPTURE_PORT"] ?? "43110"
        self.origin = URL(string: "http://127.0.0.1:\(port)")!
        let home = FileManager.default.homeDirectoryForCurrentUser
        if let configured = ProcessInfo.processInfo.environment["API_CAPTURE_LOG_HOME"], !configured.isEmpty {
            self.logDirectory = URL(fileURLWithPath: configured, isDirectory: true)
        } else {
            self.logDirectory = home.appendingPathComponent("Library/Logs/ApiCaptureAssistant", isDirectory: true)
        }
        self.logFile = logDirectory.appendingPathComponent("companion.log")
    }

    private func probe(timeout: TimeInterval = 1.5) -> HealthProbe {
        let semaphore = DispatchSemaphore(value: 0)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: configuration)
        var result = HealthProbe(reachable: false, health: nil)
        let task = session.dataTask(with: origin.appendingPathComponent("api-capture/health")) { data, response, _ in
            if response != nil {
                let health = data.flatMap { try? JSONDecoder().decode(HarnessHealth.self, from: $0) }
                result = HealthProbe(reachable: true, health: health)
            }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + timeout + 0.5)
        session.invalidateAndCancel()
        return result
    }

    func isCompatible(_ health: HarnessHealth?) -> Bool {
        return health?.ok == true
            && health?.surface == "native-harness"
            && health?.protocolVersion == "1.0"
            && health?.evidenceProtocolVersion == "1.0"
            && health?.chatDraftProtocolVersion == "1.0"
    }

    func isRunning() -> Bool {
        return isCompatible(probe().health)
    }

    func start(timeout: TimeInterval = 60) throws -> Bool {
        let first = probe()
        if isCompatible(first.health) { return true }
        if first.reachable { throw LauncherFailure.incompatiblePort }
        if !FileManager.default.isExecutableFile(atPath: node.path) { throw LauncherFailure.missingFile(node.path) }
        for required in [launcher, stopper] where !FileManager.default.fileExists(atPath: required.path) {
            throw LauncherFailure.missingFile(required.path)
        }
        try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let child = Process()
        child.executableURL = node
        child.arguments = [launcher.path]
        var environment = ProcessInfo.processInfo.environment
        environment["API_CAPTURE_NO_OPEN"] = "1"
        child.environment = environment
        let null = FileHandle(forWritingAtPath: "/dev/null")
        child.standardOutput = null
        child.standardError = null
        try child.run()
        self.process = child
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !child.isRunning && !isRunning() { throw LauncherFailure.processExited(child.terminationStatus) }
            if isRunning() { return false }
            Thread.sleep(forTimeInterval: 0.35)
        }
        throw LauncherFailure.startupTimeout
    }

    func stop() throws {
        guard FileManager.default.fileExists(atPath: stopper.path) else { throw LauncherFailure.missingFile(stopper.path) }
        let stopProcess = Process()
        stopProcess.executableURL = node
        stopProcess.arguments = [stopper.path]
        stopProcess.environment = ProcessInfo.processInfo.environment
        try stopProcess.run()
        stopProcess.waitUntilExit()
        if stopProcess.terminationStatus != 0 { throw LauncherFailure.processExited(stopProcess.terminationStatus) }
        process = nil
    }

    func openWorkbench() {
        NSWorkspace.shared.open(origin)
    }

    func openLogs() {
        let target = FileManager.default.fileExists(atPath: logFile.path) ? logFile : logDirectory
        NSWorkspace.shared.open(target)
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let controller = CompanionController()
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var detailLabel: NSTextField!
    private var openButton: NSButton!
    private var stopButton: NSButton!
    private var retryButton: NSButton!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startService()
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 280),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "接口现场助手"
        window.center()
        window.delegate = self
        let content = window.contentView!

        let title = NSTextField(labelWithString: "本地 Harness 助手")
        title.frame = NSRect(x: 34, y: 210, width: 430, height: 34)
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        content.addSubview(title)

        statusLabel = NSTextField(labelWithString: "● 正在准备")
        statusLabel.frame = NSRect(x: 36, y: 166, width: 425, height: 28)
        statusLabel.font = .systemFont(ofSize: 16, weight: .medium)
        content.addSubview(statusLabel)

        detailLabel = NSTextField(wrappingLabelWithString: "正在检查本地运行环境……")
        detailLabel.frame = NSRect(x: 36, y: 112, width: 425, height: 48)
        detailLabel.textColor = .secondaryLabelColor
        content.addSubview(detailLabel)

        openButton = NSButton(title: "打开工作台", target: self, action: #selector(openWorkbench))
        openButton.frame = NSRect(x: 36, y: 42, width: 128, height: 36)
        openButton.bezelStyle = .rounded
        openButton.isEnabled = false
        content.addSubview(openButton)

        stopButton = NSButton(title: "停止服务", target: self, action: #selector(stopService))
        stopButton.frame = NSRect(x: 176, y: 42, width: 112, height: 36)
        stopButton.bezelStyle = .rounded
        stopButton.isEnabled = false
        content.addSubview(stopButton)

        retryButton = NSButton(title: "重新尝试", target: self, action: #selector(retry))
        retryButton.frame = NSRect(x: 300, y: 42, width: 112, height: 36)
        retryButton.bezelStyle = .rounded
        retryButton.isHidden = true
        content.addSubview(retryButton)

        let logs = NSButton(title: "查看日志", target: self, action: #selector(openLogs))
        logs.frame = NSRect(x: 414, y: 42, width: 72, height: 36)
        logs.bezelStyle = .inline
        content.addSubview(logs)
    }

    private func setState(title: String, detail: String, color: NSColor, running: Bool, failed: Bool = false) {
        DispatchQueue.main.async {
            self.statusLabel.stringValue = "● \(title)"
            self.statusLabel.textColor = color
            self.detailLabel.stringValue = detail
            self.openButton.isEnabled = running
            self.stopButton.isEnabled = running
            self.retryButton.isHidden = !failed
        }
    }

    private func startService() {
        setState(title: "正在启动", detail: "首次启动可能需要几十秒，请稍候。", color: .systemBlue, running: false)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let reused = try self.controller.start()
                self.setState(
                    title: "运行正常",
                    detail: reused ? "已连接正在运行的本地 Harness。" : "Harness 已启动，插件可以发送现场证据。",
                    color: .systemGreen,
                    running: true
                )
                DispatchQueue.main.async { self.controller.openWorkbench() }
            } catch {
                self.setState(title: "启动失败", detail: error.localizedDescription, color: .systemRed, running: false, failed: true)
            }
        }
    }

    @objc private func openWorkbench() { controller.openWorkbench() }
    @objc private func openLogs() { controller.openLogs() }
    @objc private func retry() { startService() }

    @objc private func stopService() {
        setState(title: "正在停止", detail: "正在安全结束本地进程……", color: .systemOrange, running: false)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.controller.stop()
                self.setState(title: "已停止", detail: "可以关闭应用，或点击重新尝试再次启动。", color: .secondaryLabelColor, running: false, failed: true)
            } catch {
                self.setState(title: "停止失败", detail: error.localizedDescription, color: .systemRed, running: false, failed: true)
            }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if controller.isRunning() {
            let alert = NSAlert()
            alert.messageText = "退出并停止本地助手？"
            alert.informativeText = "退出应用会同时停止 Companion 和 Harness。"
            alert.addButton(withTitle: "停止并退出")
            alert.addButton(withTitle: "取消")
            if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
            try? controller.stop()
        }
        return .terminateNow
    }
}

private func runSmokeTest() -> Int32 {
    let controller = CompanionController()
    do {
        _ = try controller.start()
        guard controller.isRunning() else { throw LauncherFailure.startupTimeout }
        try controller.stop()
        print("macOS launcher smoke test passed")
        return 0
    } catch {
        fputs("macOS launcher smoke test failed: \(error.localizedDescription)\n", stderr)
        return 1
    }
}

if CommandLine.arguments.contains("--smoke-test") {
    exit(runSmokeTest())
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
