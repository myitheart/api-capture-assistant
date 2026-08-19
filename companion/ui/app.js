const state = { tasks: [], selectedId: "", selected: null, panel: "chat", search: "", pollTimer: null, clockTimer: null, config: null };
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const labels = { received:"待分析", analyzing:"分析中", awaiting_approval:"待审核", modifying:"修改中", testing:"测试中", ready_to_commit:"待提交", committed:"已提交", merged:"已合并", failed:"失败", cancelled:"已取消" };
const running = new Set(["analyzing", "modifying", "testing"]);
const runKindLabels = { analyze:"只读分析", modify:"代码修改", test:"测试验证" };
const runPhaseLabels = { preparing:"准备运行环境", launching_harness:"正在启动 Harness", running_harness:"Harness 正在处理", creating_worktree:"正在创建独立 Worktree", running_tests:"正在执行测试命令", finalizing:"正在整理运行结果", stopping:"正在停止子进程", finished:"运行已结束" };
const finishLabels = { completed:"正常完成", cancelled:"用户已取消", timeout:"自动超时", failed:"运行失败", service_restarted:"服务重启中断" };

function timeMs(value) { const result = new Date(value || 0).getTime(); return Number.isFinite(result) ? result : 0; }
function formatDuration(milliseconds) { const seconds = Math.max(0, Math.floor(milliseconds / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = seconds % 60; return hours ? `${hours}时 ${String(minutes).padStart(2,"0")}分` : `${minutes}分 ${String(rest).padStart(2,"0")}秒`; }
function relativeTime(value) { const delta = Date.now() - timeMs(value); if (delta < 60000) return "刚刚"; if (delta < 3600000) return `${Math.floor(delta / 60000)}分`; if (delta < 86400000) return `${Math.floor(delta / 3600000)}时`; const days = Math.floor(delta / 86400000); return days < 30 ? `${days}天` : new Date(value).toLocaleDateString(); }
function runTiming(task, now = Date.now()) { const run = task?.run; if (!run?.startedAt) return null; const active = running.has(task.status) && run.phase !== "finished"; const endAt = active ? now : (timeMs(run.finishedAt) || now); return { run, active, elapsed: Math.max(0, endAt - timeMs(run.startedAt)), remaining: Math.max(0, timeMs(run.timeoutAt) - now), heartbeatAge: Math.max(0, now - timeMs(run.heartbeatAt)), activityAge: Math.max(0, now - timeMs(run.lastActivityAt)) }; }

async function api(path, options = {}) { const response = await fetch(path, { headers: { "Content-Type":"application/json" }, ...options }); const data = await response.json().catch(() => ({})); if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败（${response.status}）`); return data; }
function toast(message) { const node = $("toast"); node.textContent = message; node.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3500); }

function markdown(value) {
  let source = esc(value || "");
  const blocks = [];
  source = source.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, code) => { const key = `@@CODE${blocks.length}@@`; blocks.push(`<pre><code>${code.trim()}</code></pre>`); return key; });
  source = source.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = source.split(/\r?\n/); let list = ""; const output = [];
  const closeList = () => { if (list) { output.push(`</${list}>`); list = ""; } };
  for (const line of lines) {
    if (/^@@CODE\d+@@$/.test(line)) { closeList(); output.push(line); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)/); if (heading) { closeList(); const level = heading[1].length; output.push(`<h${level}>${heading[2]}</h${level}>`); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.+)/); const ordered = line.match(/^\s*\d+[.)]\s+(.+)/);
    if (bullet || ordered) { const next = bullet ? "ul" : "ol"; if (list !== next) { closeList(); list = next; output.push(`<${list}>`); } output.push(`<li>${(bullet || ordered)[1]}</li>`); continue; }
    closeList(); if (line.trim()) output.push(`<p>${line}</p>`);
  }
  closeList(); let html = output.join(""); blocks.forEach((block, index) => { html = html.replace(`@@CODE${index}@@`, block); }); return html;
}

async function checkHealth() {
  try { const data = await api("/api/health"); const node = $("healthBadge"); node.className = `service-dot ${data.apiKeyConfigured ? "ok" : "pending"}`; node.title = data.apiKeyConfigured ? "本地服务正常" : "服务正常，尚未配置 API Key"; node.querySelector(".wide-label").textContent = data.apiKeyConfigured ? "本地服务正常" : "待配置 API Key"; }
  catch (error) { const node = $("healthBadge"); node.className = "service-dot error"; node.title = error.message; node.querySelector(".wide-label").textContent = "服务连接失败"; }
}

async function loadTasks({ keepSelection = true, loadSelected = true } = {}) {
  const data = await api("/api/tasks"); state.tasks = data.tasks || [];
  if (!keepSelection || !state.tasks.some((task) => task.id === state.selectedId)) state.selectedId = state.tasks[0]?.id || "";
  renderTaskList(); if (state.selectedId && loadSelected) await loadTask(state.selectedId); else if (!state.selectedId) renderEmpty();
}

function repositoryName(task) { const root = String(task.repository?.root || "未分组").replace(/[\\/]+$/, ""); return root.split(/[\\/]/).pop() || "未分组"; }
function renderTaskList() {
  const query = state.search.trim().toLowerCase(); const filtered = state.tasks.filter((task) => !query || [task.sourceTask?.name, task.sourceTask?.goal, task.repository?.root].some((value) => String(value || "").toLowerCase().includes(query)));
  const groups = new Map(); for (const task of filtered) { const key = task.repository?.root || "未分组"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(task); }
  $("taskList").innerHTML = groups.size ? [...groups].map(([root, tasks]) => `<section class="workspace-group" role="group"><button class="workspace-group-title" type="button" title="${esc(root)}"><span class="folder">▱</span><strong>${esc(repositoryName(tasks[0]))}</strong><span class="count">${tasks.length}</span></button><div class="session-list">${tasks.map((task) => `<button class="task-item ${task.id === state.selectedId ? "active" : ""}" data-task-id="${esc(task.id)}" role="treeitem" aria-selected="${task.id === state.selectedId}"><span class="task-dot ${running.has(task.status) ? "running" : task.status === "failed" ? "failed" : ""}"></span><strong>${esc(task.sourceTask?.name || "未命名会话")}</strong><time data-task-time="${esc(task.id)}">${relativeTime(task.updatedAt)}</time></button>`).join("")}</div></section>`).join("") : `<div class="sidebar-empty">${query ? "没有匹配的会话" : "暂无会话<br>请从插件发送任务"}</div>`;
  $("taskList").querySelectorAll("[data-task-id]").forEach((button) => button.addEventListener("click", () => selectTask(button.dataset.taskId)));
}

async function selectTask(id) { state.selectedId = id; renderTaskList(); await loadTask(id); }
async function loadTask(id) { const data = await api(`/api/tasks/${encodeURIComponent(id)}`); state.selected = data.task; const index = state.tasks.findIndex((task) => task.id === id); if (index >= 0) state.tasks[index] = data.task; renderTask(); }
function renderEmpty() { state.selected = null; $("emptyState").hidden = false; $("taskDetail").hidden = true; document.title = "DeepSeek Harness · 接口现场助手"; }

function contextHtml(task) {
  const evidence = task.evidence || {}; const source = task.source?.mode === "developer" ? "研发抓包" : "产品录制";
  return `<article class="context-message"><div class="context-kicker"><span>${source}</span>插件已自动带入需求和现场证据</div><h1>${esc(task.sourceTask?.name || "未命名任务")}</h1><p><strong>目标：</strong>${esc(task.sourceTask?.goal || "请根据现场证据理解并定位问题。")}</p>${task.requestNote ? `<p><strong>补充说明：</strong>${esc(task.requestNote)}</p>` : ""}<div class="evidence-chips"><span class="evidence-chip">${evidence.stepCount || 0} 个关键操作</span><span class="evidence-chip">${evidence.networkCount || 0} 条请求</span><span class="evidence-chip">${evidence.screenshotCount || 0} 张截图</span><span class="evidence-chip">${evidence.attachmentCount || 0} 个附件</span></div></article>`;
}
function renderConversation(task) {
  const items = task.conversation || [];
  $("conversation").innerHTML = contextHtml(task) + (items.length ? items.map((item) => item.role === "assistant" ? `<article class="chat-message assistant"><div class="message-body">${markdown(item.content)}</div><div class="assistant-actions"><button title="复制" data-copy-message="${esc(item.createdAt)}">▢</button><button title="有帮助">♧</button><button title="没帮助">♤</button></div><div class="message-meta">${new Date(item.createdAt).toLocaleTimeString()}</div></article>` : `<article class="chat-message user">${esc(item.content)}</article>`).join("") : `<div class="chat-empty">在下方输入你希望研发助手解决的问题。<br>发送第一条消息后才会调用模型。</div>`);
  $("conversation").querySelectorAll("[data-copy-message]").forEach((button) => button.addEventListener("click", async () => { const item = items.find((entry) => entry.createdAt === button.dataset.copyMessage); if (item) { await navigator.clipboard.writeText(item.content); toast("回复已复制。"); } }));
}

function renderTask() {
  const task = state.selected; if (!task) return renderEmpty(); $("emptyState").hidden = true; $("taskDetail").hidden = false;
  const isRunning = running.has(task.status); document.title = `${task.sourceTask?.name || "未命名会话"} · Harness`;
  $("taskName").textContent = task.sourceTask?.name || "未命名会话"; $("sourceMode").textContent = "标准模式"; $("taskStatus").textContent = labels[task.status] || task.status; $("taskStatus").className = `session-status ${isRunning ? "running" : task.status === "failed" ? "failed" : ""}`;
  $("repoPath").textContent = task.repository?.root || "-"; $("repoState").textContent = task.repository?.clean ? "工作区干净" : `${task.repository?.changes?.length || 0} 项未提交修改`; $("targetBranch").textContent = task.repository?.targetBranch || "-"; $("baseCommit").textContent = `基准 ${task.repository?.baseCommit?.slice(0,12) || "-"}`;
  const evidence = task.evidence || {}; $("evidenceCount").textContent = `${evidence.screenshotCount || 0} 截图 · ${evidence.networkCount || 0} 请求`; $("taskMeta").textContent = task.source?.mode === "developer" ? "研发诊断证据" : "产品现场证据";
  $("warningBox").hidden = Boolean(task.repository?.clean && !task.failure); $("warningBox").textContent = task.failure || "目标仓库存在未提交修改：可以继续只读对话，但授权修改前需要自行提交或清理。";
  renderConversation(task); renderRunCard(); renderTrajectory(task);
  $("permissionLabel").textContent = task.worktree && !task.worktree.cleaned ? "Workspace Write" : "Read Only"; $("modelLabel").textContent = state.config?.deepseekModel || "DeepSeek";
  $("evidencePopover").innerHTML = `<strong>本轮上下文已自动携带</strong><p>${evidence.stepCount || 0} 个操作、${evidence.networkCount || 0} 条请求、${evidence.screenshotCount || 0} 张截图、${evidence.attachmentCount || 0} 个附件。无需再复制给 Harness。</p>`;
  $("approvalCard").hidden = task.status !== "awaiting_approval"; $("modifyBtn").disabled = task.status !== "awaiting_approval" || !task.repository?.clean;
  $("analyzeBtn").disabled = isRunning; $("chatInput").disabled = isRunning; $("chatInput").placeholder = isRunning ? `${runKindLabels[task.run?.kind] || "Harness"}运行中，可在完成后继续对话` : "给研发助手发送消息";
  $("chatStats").textContent = isRunning ? "Harness 正在运行 · Headless 模式会在本轮结束后返回完整回复" : `${task.conversation?.length || 0} 条对话 · 现场证据保存在本机 · ${labels[task.status] || task.status}`;
  showPanel(state.panel); requestAnimationFrame(() => { const scroll = $("conversationScroll"); if (scroll) scroll.scrollTop = scroll.scrollHeight; });
}

function heartbeatState(timing) { if (!timing?.active) return "finished"; return timing.heartbeatAge >= 15000 ? "interrupted" : timing.heartbeatAge >= 10000 ? "slow" : "active"; }
function renderRunCard(now = Date.now()) {
  const timing = runTiming(state.selected, now); const card = $("runCard"); card.hidden = !timing; if (!timing) return;
  const { run, active, elapsed, remaining, heartbeatAge, activityAge } = timing; const heartbeat = heartbeatState(timing); card.className = `run-strip ${heartbeat}`;
  $("runTitle").textContent = runKindLabels[run.kind] || "本地任务"; $("runPhase").textContent = runPhaseLabels[run.phase] || run.phase; $("runElapsed").textContent = formatDuration(elapsed); $("runRemaining").textContent = active ? formatDuration(remaining) : "已结束"; $("runActivity").textContent = active ? `${formatDuration(activityAge)}前` : new Date(run.finishedAt || run.lastActivityAt).toLocaleTimeString(); $("runHeartbeat").textContent = active ? (heartbeat === "interrupted" ? "心跳中断" : heartbeat === "slow" ? "响应变慢" : "心跳正常") : (finishLabels[run.finishReason] || "已结束"); $("cancelBtn").hidden = !active; $("cancelBtn").disabled = run.phase === "stopping"; $("cancelBtn").textContent = run.phase === "stopping" ? "停止中" : "停止";
  $("traceRunPhase").textContent = runPhaseLabels[run.phase] || run.phase; $("traceHeartbeat").textContent = $("runHeartbeat").textContent; $("traceActivity").textContent = $("runActivity").textContent; $("traceElapsed").textContent = formatDuration(elapsed); $("runFinishSummary").textContent = active ? `${runKindLabels[run.kind]}运行中` : (finishLabels[run.finishReason] || "已结束");
}
function renderTrajectory(task) {
  $("worktreeMeta").textContent = task.worktree ? `${task.worktree.branch} · ${task.worktree.path}${task.worktree.cleaned ? "（已清理）" : ""}` : "尚未创建 Worktree";
  $("modifyOutput").textContent = task.modificationSummary || (new Set(["modifying","testing"]).has(task.status) ? "Harness 正在独立 Worktree 中实施…" : "尚未开始修改。"); $("diffOutput").textContent = task.diff?.diff || task.diff?.status?.join("\n") || "尚无代码改动。"; $("testOutput").textContent = task.testResult?.output || `${task.testResult?.status || "not_run"}${task.testCommand ? ` · ${task.testCommand}` : ""}`;
  $("logTimeline").innerHTML = task.logs?.length ? task.logs.map((log) => `<article class="log-item"><strong>${esc(String(log.kind || "info").toUpperCase())}</strong><time>${new Date(log.at).toLocaleTimeString()}</time><p>${esc(log.message)}</p></article>`).join("") : '<div class="trace-empty">暂无运行日志</div>';
  const isRunning = running.has(task.status); $("commitBtn").disabled = task.status !== "ready_to_commit" || task.diff?.clean; $("mergeBtn").disabled = task.status !== "committed"; $("cleanupBtn").disabled = !task.worktree || task.worktree.cleaned || isRunning; $("discardBtn").disabled = !task.worktree || task.worktree.cleaned || isRunning; $("openProjectBtn").disabled = !task.worktree;
  if (!task.run) { $("traceRunPhase").textContent = "等待开始"; $("traceHeartbeat").textContent = "--"; $("traceActivity").textContent = "--"; $("traceElapsed").textContent = "--"; $("runFinishSummary").textContent = "尚未运行"; }
}
function renderRuntimeClock() { const now = Date.now(); renderRunCard(now); document.querySelectorAll("[data-task-time]").forEach((node) => { const task = state.tasks.find((item) => item.id === node.dataset.taskTime); const timing = runTiming(task, now); node.textContent = timing?.active ? formatDuration(timing.elapsed) : relativeTime(task?.updatedAt); }); }
function showPanel(panel) { state.panel = panel; document.querySelectorAll(".session-tab").forEach((button) => { const active = button.dataset.panel === panel; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); }); document.querySelectorAll(".view-panel").forEach((node) => node.classList.toggle("active", node.id === `panel-${panel}`)); }

async function action(name, body = {}) { if (!state.selectedId) return; try { const data = await api(`/api/tasks/${encodeURIComponent(state.selectedId)}/${name}`, { method:"POST", body:JSON.stringify(body) }); state.selected = data.task; const index = state.tasks.findIndex((task) => task.id === data.task.id); if (index >= 0) state.tasks[index] = data.task; renderTaskList(); renderTask(); toast("操作已提交。"); } catch (error) { toast(error.message); await loadTask(state.selectedId).catch(() => {}); } }
function openSettings() { const dialog = $("settingsDialog"); if (!dialog.open) dialog.showModal(); }
function autoSizeInput() { const input = $("chatInput"); input.style.height = "auto"; input.style.height = `${Math.min(180, Math.max(48, input.scrollHeight))}px`; }
function downloadSessionLog() { const task = state.selected; if (!task) return; const content = JSON.stringify({ exportedAt:new Date().toISOString(), taskId:task.id, name:task.sourceTask?.name, conversation:task.conversation || [], run:task.run || null, logs:task.logs || [], worktree:task.worktree || null, diff:task.diff || null, testResult:task.testResult || null }, null, 2); const blob = new Blob([content], { type:"application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${String(task.sourceTask?.name || task.id).replace(/[\\/:*?"<>|]/g,"-")}-session-log.json`; link.click(); URL.revokeObjectURL(url); }

document.querySelectorAll(".session-tab").forEach((button) => button.addEventListener("click", () => showPanel(button.dataset.panel)));
$("collapseBtn").addEventListener("click", () => { $("appShell").classList.toggle("collapsed"); $("collapseBtn").title = $("appShell").classList.contains("collapsed") ? "展开侧边栏" : "收起侧边栏"; });
function startNewSession() { state.selectedId = ""; renderTaskList(); renderEmpty(); }
$("newSessionBtn").addEventListener("click", startNewSession); $("brandBtn").addEventListener("click", () => { if ($("appShell").classList.contains("collapsed")) $("appShell").classList.remove("collapsed"); else startNewSession(); }); $("refreshBtn").addEventListener("click", () => loadTasks());
$("searchBtn").addEventListener("click", () => { $("searchBox").hidden = !$("searchBox").hidden; if (!$("searchBox").hidden) $("taskSearch").focus(); }); $("taskSearch").addEventListener("input", (event) => { state.search = event.target.value; renderTaskList(); });
$("settingsBtn").addEventListener("click", openSettings); $("emptySettingsBtn").addEventListener("click", openSettings);
$("chatInput").addEventListener("input", autoSizeInput); $("chatInput").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("chatForm").requestSubmit(); } });
$("chatForm").addEventListener("submit", async (event) => { event.preventDefault(); const message = $("chatInput").value.trim(); if (!message && state.selected?.conversation?.length) return toast("请输入消息。"); await action("chat", { message }); $("chatInput").value = ""; autoSizeInput(); });
$("evidenceBtn").addEventListener("click", () => { $("evidencePopover").hidden = !$("evidencePopover").hidden; });
$("permissionBtn").addEventListener("click", () => { const task = state.selected; if (!task) return; if (task.status === "awaiting_approval") { $("approvalCard").scrollIntoView({ behavior:"smooth", block:"nearest" }); toast("确认分析结果后，点击“授权并开始修改”。"); } else toast(task.worktree && !task.worktree.cleaned ? "当前只允许 Harness 写入独立 Worktree，原项目不会被直接修改。" : "当前为只读权限，Harness 不能修改任何项目文件。"); });
$("modifyBtn").addEventListener("click", () => { if (confirm("确认授权 Harness 在独立 Worktree 中修改代码？原始项目不会被直接修改。")) action("modify"); }); $("cancelBtn").addEventListener("click", () => { if (confirm("确认停止当前运行？已有证据、Worktree 和代码修改会保留。")) action("cancel"); });
$("commitBtn").addEventListener("click", () => action("commit", { message:$("commitMessage").value })); $("mergeBtn").addEventListener("click", () => { if (confirm("确认将 Companion 工作分支 fast-forward 合并到目标分支？不会推送远端。")) action("merge"); }); $("cleanupBtn").addEventListener("click", () => action("cleanup")); $("discardBtn").addEventListener("click", () => { if (confirm("这会永久放弃 Worktree 中尚未提交的修改。确认继续？")) action("cleanup", { discard:true }); });
$("openProjectBtn").addEventListener("click", async () => { const value = state.selected?.worktree?.path; if (value) { await navigator.clipboard.writeText(value); toast("Worktree 路径已复制。"); } }); $("downloadLogBtn").addEventListener("click", downloadSessionLog);
$("configForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const body = { deepseekApiKey:$("apiKey").value, deepseekModel:$("model").value, deepseekBaseUrl:$("baseUrl").value, analysisTimeoutMinutes:Number($("analysisTimeout").value), modifyTimeoutMinutes:Number($("modifyTimeout").value), testTimeoutMinutes:Number($("testTimeout").value) }; const data = await api("/api/config", { method:"PUT", body:JSON.stringify(body) }); state.config = data.config; $("apiKey").value = ""; $("settingsDialog").close(); toast("本地设置已保存。"); await checkHealth(); if (state.selected) renderTask(); } catch (error) { toast(error.message); } });
$("environmentBtn").addEventListener("click", async () => { try { const data = await api("/api/environment"); $("environmentOutput").textContent = JSON.stringify(data.environment, null, 2); } catch (error) { $("environmentOutput").textContent = error.message; } });

async function init() {
  await checkHealth(); try { const data = await api("/api/config"); state.config = data.config; $("model").value = data.config.deepseekModel; $("baseUrl").value = data.config.deepseekBaseUrl; $("analysisTimeout").value = data.config.analysisTimeoutMinutes; $("modifyTimeout").value = data.config.modifyTimeoutMinutes; $("testTimeout").value = data.config.testTimeoutMinutes; await loadTasks(); } catch (error) { toast(error.message); }
  state.pollTimer = setInterval(async () => { if (state.selectedId) await loadTask(state.selectedId).catch(() => {}); if (state.selected && !running.has(state.selected.status)) await loadTasks({ loadSelected:false }).catch(() => {}); }, 2500); state.clockTimer = setInterval(renderRuntimeClock, 1000); autoSizeInput();
}
init();
