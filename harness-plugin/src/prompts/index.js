import { buildEvidenceContext } from "../tools/evidence.js";

export function buildAnalysisPrompt(task, userMessage = "") {
  return [
    "你正在执行接口现场助手的只读代码分析阶段。",
    "严格禁止修改、创建、删除或格式化任何项目文件，也不要提交代码。",
    ...buildEvidenceContext(task),
    userMessage ? `用户本轮问题：${userMessage}` : "用户本轮问题：请先根据任务目标、补充说明和现场证据理解需求，定位最相关的代码，不要无目的扫描整个项目。",
    "请检查真实仓库并输出结构清晰的 Markdown，必须包含：需求理解、现场证据映射、相关代码与原因、建议修改方案、风险、建议测试、仍需人工确认的信息。",
    "不要因为证据包含密码、Token、Cookie 或客户数据而复述敏感值；只说明其存在和相关位置。"
  ].join("\n\n");
}

export function buildAnalysisFollowupPrompt(userMessage) {
  return [
    "继续当前接口现场任务的只读对话。仍然禁止修改任何文件。",
    `用户本轮问题：${userMessage}`,
    "请结合当前会话已经加载的现场证据和此前结论回答；只在必要范围内继续读取代码。"
  ].join("\n\n");
}

export function buildModifyPrompt(task) {
  return [
    "你正在接口现场助手创建的独立 Git Worktree 中实施已经审核过的任务。",
    "只允许修改当前工作目录内的文件，不要访问或修改原始项目工作区，不要提交、合并、推送或删除分支。",
    ...buildEvidenceContext(task),
    `只读分析结论：${task.analysisFile}`,
    "请直接完成必要且最小的代码改动，复用项目现有规范，并尽量运行与改动相关的验证。最终说明修改文件、行为变化、测试结果和遗留风险。"
  ].join("\n\n");
}
