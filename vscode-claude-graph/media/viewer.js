/**
 * Webview 端：拿到扩展宿主发来的轮次树，用 layout.js 排出泳道，画成 git-graph。
 * layout.js 已由 <script> 先行加载，暴露全局 contract / layout。
 */
"use strict";

const vscodeApi = acquireVsCodeApi();

const ROW_H = 34, LANE_W = 18, PAD_X = 14, NODE_R = 4.5;
const LANE_VARS = ["var(--lane-1)", "var(--lane-2)", "var(--lane-3)", "var(--lane-4)"];

const state = { session: null, selected: null, showNoise: false, query: "" };
let view = null;

const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const laneColor = l => LANE_VARS[l % LANE_VARS.length];
const fmtTime = ts => ts ? ts.slice(0, 16).replace("T", " ") : "";
const isVisible = t => state.showNoise || t.kind === "prompt" || t.kind === "compact";

/* ---------------------------------------------------------------- 图 */

function renderGraph() {
  const center = document.getElementById("center");
  if (!state.session) {
    center.innerHTML = `<div class="empty center-empty">从左侧「对话分支图」里选一个会话。</div>`;
    view = null;
    return;
  }

  const turns = contract(state.session.turns, isVisible);
  if (!turns.length) {
    center.innerHTML = `<div class="empty center-empty">这个会话没有可显示的轮次，勾选「命令与系统事件」试试。</div>`;
    view = null;
    return;
  }
  view = layout(turns);

  const gw = PAD_X * 2 + view.maxLane * LANE_W;
  const h = view.order.length * ROW_H;
  const px = id => PAD_X + view.lane.get(id) * LANE_W;
  const py = id => view.row.get(id) * ROW_H + ROW_H / 2;

  // 跨泳道时在第一段行距内拐进目标泳道，其余全程在自己泳道里垂直下行。
  // 若用一条从头拉到尾的长曲线，父子相隔多行时会斜穿过中间的兄弟节点。
  const edges = [];
  for (const t of turns) {
    if (!t.parent || !view.row.has(t.parent)) continue;
    const x1 = px(t.parent), y1 = py(t.parent), x2 = px(t.id), y2 = py(t.id);
    let d;
    if (x1 === x2) {
      d = `M${x1},${y1} L${x2},${y2}`;
    } else {
      const ym = y1 + ROW_H;
      d = `M${x1},${y1} C${x1},${y1 + ROW_H * .55} ${x2},${ym - ROW_H * .55} ${x2},${ym}`
        + (y2 > ym ? ` L${x2},${y2}` : "");
    }
    edges.push(`<path d="${d}" fill="none" stroke="${laneColor(view.lane.get(t.id))}"
      stroke-width="2" stroke-linecap="round"/>`);
  }

  const nodes = view.order.map(id => {
    const c = laneColor(view.lane.get(id));
    const fork = view.forks.has(id);
    return `<circle cx="${px(id)}" cy="${py(id)}" r="${fork ? NODE_R + 1.5 : NODE_R}"
      fill="${id === view.head ? c : "var(--vscode-editor-background)"}"
      stroke="${c}" stroke-width="2.5"/>`;
  }).join("");

  const q = state.query.trim().toLowerCase();
  const rows = view.order.map(id => {
    const t = view.byId.get(id);
    const ref = view.refs.get(id);
    const hit = !q || (t.title + " " + t.body).toLowerCase().includes(q);
    const nTools = Object.values(t.toolCounts || {}).reduce((a, v) => a + v, 0);
    return `<div class="row kind-${t.kind}${state.selected === id ? " on" : ""}${hit ? "" : " dim"}"
              data-id="${esc(id)}">
      <span class="hash">${esc(t.short)}</span>
      <span class="title">${highlight(t.title, q)}</span>
      ${ref ? `<span class="ref ${ref === "HEAD" ? "head" : "tip"}">${esc(ref)}</span>` : ""}
      ${view.forks.has(id) ? `<span class="ref fork">分出 ${view.kids.get(id).length}</span>` : ""}
      ${nTools ? `<span class="tools">⚒ ${nTools}</span>` : ""}
      <span class="meta">${esc(fmtTime(t.ts))}</span>
    </div>`;
  }).join("");

  center.innerHTML = `<div class="graph-wrap">
    <svg class="graph-svg" width="${gw}" height="${h}" aria-hidden="true">${edges.join("")}${nodes}</svg>
    <div class="rows">${rows}</div>
  </div>`;
  center.querySelectorAll(".row").forEach(n =>
    n.onclick = () => { state.selected = n.dataset.id; save(); render(); });

  document.getElementById("stats").innerHTML =
    `<span><b>${view.order.length}</b> 轮</span>
     <span><b>${view.forks.size}</b> 处分叉</span>
     <span><b>${view.refs.size}</b> 条分支</span>`;
}

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) +
         "</mark>" + esc(text.slice(i + q.length));
}

/* ---------------------------------------------------------------- 详情 */

/** 把一组轮次渲染成可点击的分支列表；少于 2 条时不值得单列一节。 */
function branchList(ids, selfId, heading) {
  if (ids.length < 2) return "";
  return `<div class="sec">${esc(heading)}</div>` + ids.map(id => {
    const s = view.byId.get(id);
    return `<button class="sib${id === selfId ? " self" : ""}" data-go="${esc(id)}">
      <span class="h">${esc(s.short)} ${esc(fmtTime(s.ts))}${
        view.refs.has(id) ? " · " + esc(view.refs.get(id)) : ""}</span><br>${esc(s.title.slice(0, 110))}
    </button>`;
  }).join("");
}

function renderDetail() {
  const el = document.getElementById("detail");
  if (!view || !state.selected || !view.byId.has(state.selected)) {
    el.innerHTML = `<div class="empty">点一行看这一轮的完整内容。<br><br>
      圆圈较大的节点是分叉点 —— 你在那里回退并改写了提问。<br><br>
      <button class="link" id="open-raw">打开 .jsonl 原始记录</button></div>`;
    document.getElementById("open-raw").onclick =
      () => vscodeApi.postMessage({ type: "openFile" });
    return;
  }

  const t = view.byId.get(state.selected);
  const parent = t.parent && view.byId.has(t.parent) ? view.byId.get(t.parent) : null;
  const sibs = parent ? (view.kids.get(parent.id) || []) : (view.roots.length > 1 ? view.roots : []);
  const ref = view.refs.get(t.id);
  const isCodex = state.session.provider === "codex";

  const kv = [
    ["来源", state.session.providerLabel || (isCodex ? "Codex" : "Claude Code")],
    ["时间", fmtTime(t.ts)],
    ["父节点", parent ? `${parent.short} ${parent.title.slice(0, 22)}` : "（根）"],
    ["git 分支", t.gitBranch || "—"],
    ["模型", (t.models || []).join(", ") || "—"],
    ["输出", t.outputTokens ? `${t.outputTokens.toLocaleString()} tokens` : "—"],
    ["子 agent", t.subagents || "—"],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");

  const steps = (t.steps || []).map(s => {
    const label = { thinking: "思考", text: "回复", tool: s.name, result: "结果" }[s.type] || s.type;
    const head = s.type === "tool" ? s.summary || ""
      : (s.detail || "").replace(/\s+/g, " ").slice(0, 90);
    return `<details class="step">
      <summary><span class="tag${s.isError ? " err" : ""}">${esc(label)}</span><span class="s">${esc(head)}</span></summary>
      <pre>${esc(s.detail)}${s.truncated ? `\n<span class="cut">…已截断</span>` : ""}</pre>
    </details>`;
  }).join("") || `<div class="empty">（这一轮没有助手动作）</div>`;

  el.innerHTML = `
    <h2>${esc(t.title)}</h2>
    <div class="sub">${esc(t.short)} · ${esc(t.kind)}${
      ref ? " · " + esc(ref) : ""}</div>
    <dl class="kv">${kv}</dl>
    <div class="turn-actions">
      <button class="action primary" id="fork-turn">从此轮创建${isCodex ? " Codex" : " Claude"} 分支</button>
      ${ref ? `<button class="action" id="resume-turn">${
        isCodex
          ? (ref === "HEAD" ? "继续此 Codex 分支" : `继续 ${esc(ref)} Codex 分支`)
          : (ref === "HEAD" ? "从此尖端继续（新会话）" : `从 ${esc(ref)} 继续（新会话）`)
      }</button>` : ""}
    </div>
    <div class="action-note">${isCodex
      ? "创建分支会通过 Codex 官方接口精确复制截至所选轮次的历史；继续会打开现有分支尖端。"
      : "两项操作都会精确复制截至所选轮次的对话并在新终端打开；原会话不变。"}
      只处理对话上下文，不会切换 Git 分支或回滚文件。</div>
    ${branchList(view.kids.get(t.id) || [], t.id,
      `从这里分出 ${(view.kids.get(t.id) || []).length} 条 —— 你在这一轮之后回退改写`)}
    ${branchList(sibs.length > 1 ? sibs : [], t.id,
      `同父分支 ${sibs.length} 条 —— 与它源自同一次提问`)}
    <div class="sec">提问原文${t.bodyTruncated ? "（已截断）" : ""}</div>
    <pre class="body">${esc(t.body || t.title)}</pre>
    <div class="sec">助手动作 ${(t.steps || []).length} 步</div>
    ${steps}`;

  document.getElementById("fork-turn").onclick = () =>
    vscodeApi.postMessage({ type: "forkTurn", turnId: t.id });
  const resume = document.getElementById("resume-turn");
  if (resume) resume.onclick = () =>
    vscodeApi.postMessage({ type: "resumeTurn", turnId: t.id });

  el.querySelectorAll("[data-go]").forEach(n =>
    n.onclick = () => { state.selected = n.dataset.go; save(); render(); });
}

function render() { renderGraph(); renderDetail(); }

/* ---------------------------------------------------------------- 交互 */

// webview 被隐藏后可能整体重建，把选中状态存回去
const save = () => vscodeApi.setState({
  selected: state.selected, showNoise: state.showNoise, query: state.query,
});

document.getElementById("q").oninput = e => {
  state.query = e.target.value; save(); renderGraph();
};
document.getElementById("f-noise").onchange = e => {
  state.showNoise = e.target.checked; state.selected = null; save(); render();
};
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || !view) return;
  const i = view.order.indexOf(state.selected);
  if (e.key === "j" || e.key === "ArrowDown") {
    state.selected = view.order[Math.min(view.order.length - 1, i + 1)] || view.order[0];
  } else if (e.key === "k" || e.key === "ArrowUp") {
    state.selected = view.order[Math.max(0, i - 1)] || view.order[0];
  } else return;
  e.preventDefault(); save(); render();
  document.querySelector(".row.on")?.scrollIntoView({ block: "nearest" });
});

/** 本次 webview 是否从 setState 恢复出了用户自己的视图状态。 */
let restored = false;

window.addEventListener("message", ev => {
  const msg = ev.data;
  if (msg.type !== "session") return;

  // VS Code 会在 webview 隐藏后销毁重建，扩展随即重投一次数据。那不是「切换会话」，
  // 不能借机清掉恢复出来的选中 —— 否则用户每次切回标签页都会丢失当前位置。
  const prevId = state.session ? (state.session.key || `${state.session.provider}:${state.session.id}`) : null;
  const nextId = msg.session.key || `${msg.session.provider}:${msg.session.id}`;
  const switching = prevId !== null && prevId !== nextId;
  state.session = msg.session;

  if (switching) state.selected = null;
  if (switching || !restored) {
    state.showNoise = msg.showNoise;          // 跟随配置默认值
    document.getElementById("f-noise").checked = state.showNoise;
  }
  // 选中的轮次可能已经不存在了（换了会话，或对话被改写）
  if (state.selected && !msg.session.turns.some(t => t.id === state.selected)) {
    state.selected = null;
  }

  document.getElementById("hdr-title").textContent =
    `${msg.session.providerLabel || ""} · ${msg.session.title}`.replace(/^ · /, "").slice(0, 52);
  save();
  render();
});

(function init() {
  const prev = vscodeApi.getState();
  if (prev) {
    restored = true;
    state.selected = prev.selected ?? null;
    state.showNoise = Boolean(prev.showNoise);
    state.query = prev.query || "";
    document.getElementById("f-noise").checked = state.showNoise;
    document.getElementById("q").value = state.query;
  }
  render();
  vscodeApi.postMessage({ type: "ready" });
})();
