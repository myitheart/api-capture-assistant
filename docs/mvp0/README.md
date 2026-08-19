# MVP0 使用指南

MVP0 的目标是把插件采集结果直接带入原生 DeepSeek Harness 对话，不增加中间任务系统。

## 1. 启动 Harness

解压 Windows 便携包，双击 `启动本地研发助手.cmd`。脚本启动本机原生 Harness Web，并打开 `http://127.0.0.1:43110`。

首次使用时通过 Harness 自带的设置完成 API Key、模型和可选 Base URL 配置。Harness 数据位于 `%LOCALAPPDATA%\ApiCaptureAssistant\harness`，本地证据位于 `%LOCALAPPDATA%\ApiCaptureAssistant\evidence`；API Key 不进入插件或采集包。

## 2. 研发模式选择 Workspace

研发模式需要在原生 Harness 左侧工作区中选择或新建代码 Workspace，并按需要打开既有会话或新会话。产品模式不需要选择项目，会自动进入固定的「现场分析」分组。Workspace、会话历史、权限模式和工具都由 Harness 管理。

## 3. 从产品模式带入 Prompt

产品模式完成网页录制后，可以继续整理任务目标、关键操作、页面标记、截图说明和补充 Prompt。点击「带到 Harness 中继续」后，插件固定保留业务请求，把 Network、截图和步骤拆分到不可变的本机证据目录，再用不超过约 4 KB 的摘要和 `index.md` 路径创建独立的原生「现场分析」Session。该 Session 使用 Read Only 权限与证据读取工具，不注册代码 Workspace。

## 4. 从研发模式带入 Prompt

研发模式可以补充问题描述、目标模块、约束和验收标准，并从“当前请求、当前筛选结果、当前会话”中选择 Network 范围。没有显式筛选条件时默认当前会话。点击「带到 Harness 中继续」后，同样先生成证据目录，再把不超过约 8 KB 的摘要和索引路径放入当前项目 Session 的原生输入框。

## 5. 检查并发送

带入完成后，Prompt 只出现在原生输入框中，不会自动发送。先检查摘要和本机路径，再补充问题、加入团队预设 Prompt、切换模型或权限模式，确认后手动发送。Harness 应先读取 `index.md`，再围绕当前问题按需读取具体请求或截图，不要一次加载整个目录。

之后的分析、权限确认、Session log 和多轮沟通都使用 DeepSeek Harness 原生交互。产品现场分析只读取证据，不提供 Shell 或文件修改；研发项目会话继续按用户选择的原生权限提供代码能力。本连接器不设置首次只读阶段，也不接管 Worktree、提交或合并。

## 6. 数据提醒

产品录制和研发抓包可能包含页面输入、密码、Cookie、Token、Headers、响应正文和客户数据。插件当前只做软提醒，不脱敏、不加密、不筛除。证据包不会自动删除；可以从插件的“本地证据管理”复制路径、打开目录或批量删除。删除后历史会话中的路径会失效。

## 常见问题

### 点击后提示无法连接

确认便携包已启动，并在浏览器访问 `http://127.0.0.1:43110/api-capture/health`。正常响应会标记 `surface` 为 `native-harness`，且 `protocolVersion`、`chatDraftProtocolVersion` 与 `evidenceProtocolVersion` 均为 `1.0`。

### 证据上传失败

插件会对单文件自动重试，并在同一次证据事务中复用已经上传成功的文件。仍然失败时可再次点击重试，也可以继续使用 JSON 或 ZIP 导出；如果提示超过 1 GB、单文件 200 MB 或 5000 个文件，请缩小研发请求范围。

### Prompt 没有出现

产品模式会自动创建「现场分析」Session，无需选择 Workspace；若创建失败，请确认健康检查包含 `chatDraftProtocolVersion: "1.0"` 后重试。研发模式需要先在原生 Harness 选择项目 Workspace 或项目 Session。

### 带入 Prompt 会消耗 Token 吗

不会。只有用户在原生 Harness 中手动发送后才会调用模型。

### 是否需要 WSL 或 Ubuntu

正式 Windows 便携包不需要 WSL、Ubuntu、Node.js、pnpm 或 Python。源码开发和发行构建才需要 Node.js 与 pnpm。
