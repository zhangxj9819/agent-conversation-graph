/**
 * Webview 渲染测试：把插件真正生成的 HTML 套上 VS Code 主题令牌，
 * 在无头 Chrome 里跑一遍，检查图确实画出来了、状态恢复正常。
 *
 *   node test/webview.js
 *
 * 找不到 Chrome 时跳过（退出码 0），不阻塞其余测试。
 */
"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.CLAUDE_CONFIG_DIR = path.resolve(__dirname, "fixtures");
process.env.CODEX_HOME = path.resolve(__dirname, "fixtures/codex");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const chrome = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!chrome) {
  console.log("  ⊘ 未找到 Chrome，跳过 webview 渲染测试");
  process.exit(0);
}

// ---- 拿到插件真正生成的 webview HTML 与会话数据 ---------------------------
const { vscode, calls } = require("./mock-vscode");
const origLoad = Module._load;
Module._load = function (r, p, m) { return r === "vscode" ? vscode : origLoad.call(this, r, p, m); };

const extRoot = path.resolve(__dirname, "..");
const ext = require("../extension.js");
ext.activate({ subscriptions: [], extensionUri: vscode.Uri.file(extRoot) });

const tree = calls.treeProviders.get("claudeGraph.sessions");
const sessions = tree.getChildren().flatMap(p => tree.getChildren(p));
const forked = sessions
  .filter(s => s.description.includes("分叉"))
  .sort((a, b) => parseInt(b.description.match(/(\d+) 分叉/)[1], 10) -
                  parseInt(a.description.match(/(\d+) 分叉/)[1], 10));
if (!forked.length) {
  console.log("  ⊘ 本机没有含分叉的会话，跳过");
  process.exit(0);
}
calls.registeredCommands.get("claudeGraph.open")(forked[0].command.arguments[0]);
const payload = calls.messages.at(-1);

// 挑一个分叉点，预置成「上次看到这里」的状态
const kids = new Map();
for (const t of payload.session.turns) {
  if (t.parent) kids.set(t.parent, [...(kids.get(t.parent) || []), t.id]);
}
const visible = new Set(payload.session.turns
  .filter(t => t.kind === "prompt" || t.kind === "compact").map(t => t.id));
const forkId = [...kids.entries()]
  .filter(([p, cs]) => visible.has(p) && cs.filter(c => visible.has(c)).length > 1)
  .sort((a, b) => b[1].length - a[1].length)[0][0];
const forkTurn = payload.session.turns.find(t => t.id === forkId);

// ---- 组装可离线打开的测试页 ----------------------------------------------
const html = calls.panels[0].webview.html
  .replace(/vscode-webview:\/\/mock/g, "file://")
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, "")  // file:// 下会挡住脚本
  .replace(/ nonce="[A-Za-z0-9]{32}"/g, "")
  .replace("</head>", `<style>
:root{--vscode-foreground:#ccc;--vscode-editor-background:#1f1f1f;
--vscode-sideBar-background:#181818;--vscode-panel-border:#2b2b2b;
--vscode-list-activeSelectionBackground:#04395e;--vscode-input-background:#313131;
--vscode-font-family:sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;}
</style>
<script>
let _state=${JSON.stringify({ selected: forkId, showNoise: false, query: "" })};
window.acquireVsCodeApi=()=>({
  postMessage(m){
    if(m.type==='forkTurn') document.documentElement.dataset.forkTurn=m.turnId;
    if(m.type==='resumeTurn') document.documentElement.dataset.resumeTurn=m.turnId;
  },
  setState(s){_state=s},getState(){return _state}
});
window.addEventListener('DOMContentLoaded',()=>{
  document.body.classList.add('vscode-dark');
  setTimeout(()=>{
    window.postMessage(${JSON.stringify(payload)},'*');
    setTimeout(()=>{
      document.getElementById('fork-turn')?.click();
      document.querySelector('.sib[data-go]')?.click();
      document.getElementById('resume-turn')?.click();
      document.querySelector('[data-id="${forkId}"]')?.click();
    },50);
  },0);
});
</script></head>`);

const tmp = path.join(os.tmpdir(), `claude-graph-webview-test-${process.pid}.html`);
fs.writeFileSync(tmp, html);

const dom = execFileSync(chrome, [
  "--headless", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
  "--virtual-time-budget=6000", "--dump-dom", `file://${tmp}`,
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
fs.unlinkSync(tmp);

// ---- 断言 -----------------------------------------------------------------
const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push(["✓", name]); }
  catch (e) { checks.push(["✗", `${name} —— ${e.message}`]); }
};

const shownTurns = payload.session.turns.filter(t => visible.has(t.id)).length;

check("画出了全部可见轮次", () => {
  const rows = (dom.match(/class="row kind-/g) || []).length;
  assert.strictEqual(rows, shownTurns, `期望 ${shownTurns} 行，实际 ${rows}`);
});

check("画出了连线与节点", () => {
  assert.ok((dom.match(/<path /g) || []).length >= shownTurns - 1, "连线偏少");
  assert.strictEqual((dom.match(/<circle /g) || []).length, shownTurns, "节点数与行数不符");
});

check("用到了多条泳道的颜色", () => {
  const lanes = new Set([...dom.matchAll(/var\(--lane-(\d)\)/g)].map(m => m[1]));
  assert.ok(lanes.size >= 2, `只用到 ${lanes.size} 种泳道色，分叉应当换色`);
});

check("HEAD 与 tip 标签都渲染了", () => {
  assert.ok(dom.includes(">HEAD<"), "缺少 HEAD 标签");
  assert.ok(/>tip\/\d+</.test(dom), "缺少 tip 标签");
});

// 这条是回归测试：webview 被 VS Code 重建后扩展会重投数据，
// 曾经把 setState 恢复出来的选中当成「切换会话」清掉了。
check("重投数据后仍保留恢复的选中", () => {
  assert.ok(dom.includes(`class="row kind-${forkTurn.kind} on"`),
    "选中行没有 .on 状态");
  assert.ok(dom.includes(`${forkTurn.short} ·`), "详情面板没有显示选中的轮次");
});

check("分叉点列出了分出的分支", () => {
  const n = kids.get(forkId).filter(c => visible.has(c)).length;
  assert.ok(dom.includes(`从这里分出 ${n} 条`), `详情里没有「从这里分出 ${n} 条」`);
});

check("详情面板渲染了助手动作", () => {
  assert.ok(dom.includes("助手动作"), "缺少助手动作一节");
  if (forkTurn.steps.length) assert.ok(dom.includes("<details class=\"step\""), "步骤没渲染");
});

check("详情面板提供从轮次创建分支的操作", () => {
  assert.ok(/从此轮创建(?: Claude| Codex) 分支/.test(dom), "缺少创建分支按钮");
});

check("分支按钮向扩展发送受限的轮次 ID", () => {
  assert.ok(dom.includes(`data-fork-turn="${forkId}"`), "创建分支按钮没有发送 forkTurn");
  const childIds = kids.get(forkId).filter(id => visible.has(id));
  assert.ok(childIds.some(id => dom.includes(`data-resume-turn="${id}"`)),
    "切换分支按钮没有发送 resumeTurn");
});

Module._load = origLoad;
for (const [mark, name] of checks) console.log(`  ${mark} ${name}`);
const failed = checks.filter(c => c[0] === "✗").length;
console.log(`\n${checks.length} 项检查 · 失败 ${failed}`);
process.exit(failed ? 1 : 0);
