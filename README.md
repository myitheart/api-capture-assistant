# 接口现场助手 · 原生 DeepSeek Harness 连接器

本仓库负责启动和发行原生 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面。浏览器插件先把产品录制或研发抓包保存为本机结构化证据目录，再把任务摘要和 `index.md` 绝对路径作为可编辑 Prompt 预填到当前会话输入框；用户可以继续补充、套用自己的 Prompt，并决定何时发送。

这里不提供第二套任务中心、只读分析页、审批页或 Worktree 控制台。产品模式进入不依赖代码项目的原生「现场分析」会话；研发模式进入当前项目会话。Workspace、会话、模型、API Key、权限模式、工具调用和代码修改都沿用 DeepSeek Harness 原生交互。

## 使用流程

1. Windows 双击便携包中的 `启动本地研发助手.cmd`；Apple Silicon Mac 双击 `接口现场助手.app`。浏览器会在本地 Harness 就绪后打开 `http://127.0.0.1:43110`。
2. 首次使用时，在 Harness 原生设置中配置 DeepSeek API Key、模型和可选 Base URL；只有研发项目会话需要选择 Workspace。
3. 在 Chrome 插件的产品模式或研发模式完成采集，检查补充说明和请求范围，然后点击「带到 Harness 中继续」。
4. 插件把 Network 正文、Headers、截图和步骤拆分保存到本机证据目录；产品模式每次新建独立的「现场分析」会话，研发模式继续使用当前项目会话，输入框中只出现摘要与索引路径。Prompt 不会自动发送，也不会因为带入动作消耗 Token。
5. 用户继续编辑 Prompt，选择原生权限模式，再手动发送并按正常 Harness 方式对话。

插件仍可单独录制、抓包、导出 ZIP、JSON、HAR、cURL 和 Python；未启动 Harness 时只有「带到 Harness」能力不可用。

## 三个独立仓库

```text
api-capture-assistant-extensions/  Chrome 插件：采集证据并生成 Prompt
api-capture-assistant/             本仓库：启动器、Windows/macOS 发行组装和兼容测试
api-capture-harness/               DeepSeek Harness Fork：原生 Web 与 Prompt 草稿桥
```

三个目录是同级、独立的 Git 仓库。`AGENTS.md` 记录了跨仓库归属，后续从任意仓库开始的开发任务都应先判断实际修改归属。

## Windows 普通用户安装

1. 下载 `api-capture-companion-win-x64.zip` 并完整解压。
2. 双击 `启动本地研发助手.cmd`。
3. 在自动打开的原生 Harness 页面完成首次配置。
4. 在 Chrome 加载或安装接口现场助手插件。

发行包已经包含 Node.js Runtime 和固定源码版本构建的 Harness。普通用户不需要安装 Node.js、pnpm、Python、WSL 或 Ubuntu，也不需要部署服务器。程序仅监听 `127.0.0.1`；Harness 配置和会话保存在 `%LOCALAPPDATA%\ApiCaptureAssistant\harness`，现场分析技术目录位于 `%LOCALAPPDATA%\ApiCaptureAssistant\analysis-workspace`，不可变证据包保存在 `%LOCALAPPDATA%\ApiCaptureAssistant\evidence`，升级程序目录不会清除它们。证据包只会在插件的“本地证据管理”中由用户明确删除。

## macOS Apple Silicon 普通用户安装

1. 下载 `api-capture-companion-macos-arm64.zip` 并完整解压。
2. 双击 `接口现场助手.app`，不要求移动到“应用程序”目录。
3. 内部测试版没有 Developer ID 和苹果公证。首次如果被阻止，先尝试打开一次，再进入“系统设置 → 隐私与安全”点击“仍要打开”。
4. 状态窗口显示“运行正常”后，浏览器自动打开 Harness；完成 API Key 配置并加载 Chrome 插件。
5. 启动异常时双击 `诊断并启动.command`，需要结束残留进程时使用 `停止全部服务.command`。

macOS 第一版支持 M1/M2/M3/M4 等 Apple Silicon 和 macOS 13.5+，暂不支持 Intel Mac。用户不需要安装 Node.js、pnpm、Python、Git、Homebrew 或 Xcode。配置、会话和证据保存在 `~/Library/Application Support/ApiCaptureAssistant`，日志位于 `~/Library/Logs/ApiCaptureAssistant`，替换程序 ZIP 不会删除历史数据。

## 开发运行

将三个仓库放在同一父目录。开发机需要 Node.js 22.19+、pnpm 11.7.0 和 Git。

```bash
npm start
```

启动器会从相邻的 `api-capture-harness` 源码仓库运行 `pnpm dsh web --port 43110`。插件使用相互独立的草稿与证据接口：

```text
GET  /api-capture/health
POST /api-capture/drafts
GET  /api-capture/drafts/:id
POST /api-capture/chat-drafts
GET  /api-capture/chat-drafts/:id
DELETE /api-capture/chat-drafts/:id
POST /api-capture/evidence-packages
PUT  /api-capture/evidence-packages/:packageId/files/:fileId
POST /api-capture/evidence-packages/:packageId/finalize
GET  /api-capture/evidence-packages
GET  /api-capture/evidence-packages/:packageId
DELETE /api-capture/evidence-packages/:packageId
```

两种草稿接口都只接收 `{ prompt }`。`/drafts` 进入当前项目，`/chat-drafts` 创建使用「现场分析模式」与 Read Only 权限的独立 Session；证据先进入暂存区，完整上传并通过大小、路径与 SHA-256 校验后才原子发布。浏览器侧插件使用原生会话服务填充 composer，不触发发送动作。

## 构建 Windows 便携包

先在 Harness Fork 构建固定版本的 Windows 运行产物，再组装便携包：

```bash
cd ../api-capture-harness
pnpm run build:api-capture-web

cd ../api-capture-assistant
npm run build:portable
npm run smoke:portable
```

产物位于 `dist/api-capture-companion-win-x64/` 和同名 ZIP。发行包只包含原生 Harness、内置 Node Runtime、启动/停止脚本和许可证，不打包旧的自定义任务控制台。

## 云端构建 macOS 便携包

macOS 包由 GitHub Actions 的 `macos-15` Apple Silicon Runner 原生构建，本地 Windows 开发机不需要拥有 Mac。打开本仓库 Actions 页，手动运行 `Build macOS Apple Silicon portable package`：工作流会读取 `companion/harness.lock.json` 中固定的公开 Harness Fork commit，完成编译、协议 Smoke Test、Swift 启动器无界面测试、Bundle 校验和 ad-hoc 临时签名。

成功后下载 Artifact `api-capture-companion-macos-arm64`，其中包含 ZIP 和 SHA-256 文件。工作流失败时不会上传可分发 ZIP，只保留诊断 Artifact。该流水线不读取 API Key、用户会话或证据，也不进行 Developer ID 签名和公证。

开发者在 Apple Silicon Mac 上也可以本地执行：

```bash
cd ../api-capture-harness
pnpm run build:api-capture-web

cd ../api-capture-assistant
npm run build:portable:macos
npm run smoke:portable
```

## 版本边界

| 模块 | 当前版本 | 含义 |
| --- | ---: | --- |
| Chrome 插件 | 0.9.0 | 插件独立发布版本 |
| Windows/macOS 启动与发行 | 0.4.0 | 本仓库发行版本 |
| API Capture Harness 构建 | 0.3.0 | 固定源码 Fork 的 Windows 与 Apple Silicon macOS 运行构建版本 |
| Prompt 草稿协议 | 1.0 | 插件与 Harness Fork 的本机接口版本 |
| 现场分析草稿协议 | 1.0 | 产品草稿创建独立分析 Session 的接口版本 |
| 本地证据协议 | 1.0 | 证据声明、分文件上传、完成与管理接口版本 |
| API Capture 证据结构 | 1.0 | `index.md`、Network 拆分文件和 `manifest.json` 的目录含义 |

## 验证

```bash
npm test
npm run check
```

跨仓库验收还包括插件全部 Node 测试、Harness 草稿桥与证据 Host 测试，以及真实浏览器中“只预填、不自动发送”的原生界面检查。详细用户步骤见 [MVP0 使用指南](docs/mvp0/README.md)。
