export function buildEvidenceContext(task) {
  const sourceMode = task.source?.mode === "developer" ? "研发模式抓包诊断" : "产品模式现场录制";
  return [
    `任务来源：${sourceMode}`,
    `现场交付证据：${task.evidence.deliveryFile}`,
    `任务名称：${task.sourceTask.name || "未命名任务"}`,
    `任务目标：${task.sourceTask.goal || "未填写"}`,
    `研发补充说明：${task.requestNote || "无"}`,
    `证据概览：${task.evidence.stepCount || 0} 个操作、${task.evidence.networkCount || 0} 条请求、${task.evidence.screenshotCount || 0} 张截图、${task.evidence.attachmentCount || 0} 个附件。`,
    "请先读取交付证据 JSON 的任务信息和索引，只按当前问题逐步打开必要的请求、响应或截图；不要先扫描全部证据或整个仓库。"
  ];
}
