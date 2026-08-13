/**
 * 冒烟测试：在没有 VS Code 的情况下真正跑一遍 activate()，
 * 展开树视图、打开 webview、模拟文件变更。
 *
 *   node test/smoke.js
 *
 * 使用仓库内固定 JSONL fixture，测试结果不依赖用户机器上的会话状态。
 */
"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

process.env.CLAUDE_CONFIG_DIR = path.resolve(__dirname, "fixtures");

const { vscode, calls, config } = require("./mock-vscode");

// 把 require("vscode") 换成替身
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  return origLoad.call(this, request, parent, isMain);
};

const ext = require("../extension.js");

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push(["✓", name]); }
  catch (e) { checks.push(["✗", `${name} —— ${e.message}`]); }
};

// ---- 激活 -----------------------------------------------------------------
const context = {
  subscriptions: [],
  extensionUri: vscode.Uri.file(path.resolve(__dirname, "..")),
};
ext.activate(context);

check("activate 注册了 4 个命令", () => {
  assert.deepStrictEqual([...calls.registeredCommands.keys()].sort(), [
    "claudeGraph.open", "claudeGraph.openCurrent",
    "claudeGraph.refresh", "claudeGraph.revealFile",
  ]);
});

check("注册了会话树视图", () =>
  assert.ok(calls.treeProviders.has("claudeGraph.sessions")));

check("注册了 .jsonl 文件监听", () => {
  assert.strictEqual(calls.watchers.length, 1);
  assert.strictEqual(calls.watchers[0].pattern.pattern, "**/*.jsonl");
});

// ---- 树视图 ---------------------------------------------------------------
const tree = calls.treeProviders.get("claudeGraph.sessions");
const projects = tree.getChildren();

check("树顶层列出了项目", () => {
  assert.ok(Array.isArray(projects) && projects.length > 0, "没有扫描到任何项目");
  assert.ok(projects.every(p => p.contextValue === "project"));
  assert.ok(projects.every(p => typeof p.label === "string" && p.label.length));
});

let sessions = [];
check("展开项目能列出会话", () => {
  sessions = projects.flatMap(p => tree.getChildren(p));
  assert.ok(sessions.length > 0, "没有会话");
  assert.ok(sessions.every(s => s.contextValue === "session"));
  assert.ok(sessions.every(s => s.command?.command === "claudeGraph.open"));
  assert.ok(sessions.every(s => /^\d+ 轮/.test(s.description)));
});

check("有分叉的会话用 git-branch 图标区分", () => {
  const forked = sessions.filter(s => s.description.includes("分叉"));
  assert.ok(forked.length > 0, "本机数据里应当存在有分叉的会话");
  assert.ok(forked.every(s => s.iconPath.id === "git-branch"));
  assert.ok(sessions.filter(s => !s.description.includes("分叉"))
    .every(s => s.iconPath.id === "comment-discussion"));
});

// ---- 打开 webview ---------------------------------------------------------
const targetFile = sessions.find(s => s.description.includes("分叉")).resourceUri.fsPath;
calls.registeredCommands.get("claudeGraph.open")(targetFile);

check("创建了 webview 面板", () => assert.strictEqual(calls.panels.length, 1));

const html = calls.panels[0].webview.html;
check("webview HTML 带 CSP 且脚本用 nonce", () => {
  assert.ok(html.includes("Content-Security-Policy"), "缺少 CSP");
  assert.ok(html.includes("default-src 'none'"), "CSP 没有默认拒绝");
  const nonces = [...html.matchAll(/nonce-([A-Za-z0-9]{32})/g)].map(m => m[1]);
  assert.strictEqual(nonces.length, 1, "CSP 里应有且仅有一个 nonce");
  const tags = [...html.matchAll(/<script nonce="([A-Za-z0-9]{32})"/g)].map(m => m[1]);
  assert.strictEqual(tags.length, 2, "应有 layout.js 与 viewer.js 两个脚本");
  assert.ok(tags.every(t => t === nonces[0]), "脚本 nonce 与 CSP 不一致");
  assert.ok(!/<script(?![^>]*nonce)/.test(html), "存在没有 nonce 的脚本标签");
});

check("webview 资源指向 media/ 下的文件", () => {
  assert.ok(html.includes("/media/layout.js"));
  assert.ok(html.includes("/media/viewer.js"));
  assert.ok(html.includes("/media/viewer.css"));
});

check("localResourceRoots 限定在 media/", () => {
  const roots = calls.panels[0].options.localResourceRoots;
  assert.strictEqual(roots.length, 1);
  assert.ok(roots[0].fsPath.endsWith(path.join("vscode-claude-graph", "media")));
});

// ---- 数据投递 -------------------------------------------------------------
check("向 webview 投递了会话数据", () => {
  const msg = calls.messages.at(-1);
  assert.strictEqual(msg.type, "session");
  assert.ok(msg.session.turns.length > 0, "轮次为空");
  assert.strictEqual(typeof msg.showNoise, "boolean");
  const t = msg.session.turns[0];
  for (const f of ["id", "short", "parent", "resumeAt", "ts", "kind", "title", "body", "steps"]) {
    assert.ok(f in t, `轮次缺少字段 ${f}`);
  }
});

check("投递的轮次树里存在真实分叉", () => {
  const turns = calls.messages.at(-1).session.turns
    .filter(t => t.kind === "prompt" || t.kind === "compact");
  const c = new Map();
  for (const t of turns) if (t.parent) c.set(t.parent, (c.get(t.parent) || 0) + 1);
  assert.ok([...c.values()].some(v => v > 1), "选中的会话本应有分叉");
});

// ---- webview → 扩展的消息 -------------------------------------------------
check("webview 请求打开原始文件能被处理", () => {
  calls.executed.length = 0;
  calls.panels[0]._onMessage({ type: "openFile" });
  assert.deepStrictEqual(calls.executed.at(-1), ["open", targetFile]);
});

check("webview ready 会重新投递数据", () => {
  const before = calls.messages.length;
  calls.panels[0]._onMessage({ type: "ready" });
  assert.strictEqual(calls.messages.length, before + 1);
});

// ---- 文件变更自动刷新 -----------------------------------------------------
check("对话写入后去抖刷新（同一文件才重投）", async () => {
  const before = calls.messages.length;
  const w = calls.watchers[0];
  for (let i = 0; i < 5; i++) w.handlers.change[0](vscode.Uri.file(targetFile));
  assert.strictEqual(calls.messages.length, before, "去抖期内不应立即投递");
});

// ---- 缓存 -----------------------------------------------------------------
check("重复展开走缓存，不重复解析", () => {
  const t0 = process.hrtime.bigint();
  projects.flatMap(p => tree.getChildren(p));
  const warm = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(warm < 200, `二次展开耗时 ${warm.toFixed(0)}ms，缓存似乎没生效`);
});

// ---- 配置改变清缓存 -------------------------------------------------------
check("改 maxChars 会清缓存并重投", () => {
  const before = calls.messages.length;
  config.maxChars = 500;
  calls.onConfig({ affectsConfiguration: s => s.startsWith("claudeGraph") });
  assert.ok(calls.messages.length > before, "配置变更后应重新投递");
  const msg = calls.messages.at(-1);
  const longest = Math.max(...msg.session.turns
    .flatMap(t => t.steps.map(s => [...(s.detail || "")].length)));
  assert.ok(longest <= 500, `截断没生效，最长 step ${longest} 字`);
});

// ---- 共享算法文件 ---------------------------------------------------------
check("media/layout.js 与仓库根的 layout.js 一致", () => {
  const fs = require("node:fs");
  const shared = path.resolve(__dirname, "../../layout.js");
  if (!fs.existsSync(shared)) return;   // 打包成 .vsix 后没有仓库根，跳过
  assert.strictEqual(
    fs.readFileSync(path.resolve(__dirname, "../media/layout.js"), "utf8"),
    fs.readFileSync(shared, "utf8"),
    "两份布局算法已经漂移，跑 `cp ../layout.js media/layout.js` 同步");
});

const messagesBeforeDebounce = calls.messages.length;

// 去抖定时器跑完后，验证分支操作并收尾
setTimeout(async () => {
  check("去抖窗口结束后完成刷新", () =>
    assert.ok(calls.messages.length > messagesBeforeDebounce, "刷新未发生"));

  // ---- 创建/切换 Claude 对话分支 ------------------------------------------
  const data = calls.messages.at(-1).session;
  const childCounts = new Map();
  for (const t of data.turns) if (t.parent)
    childCounts.set(t.parent, (childCounts.get(t.parent) || 0) + 1);
  const forkPoint = data.turns.find(t => childCounts.get(t.id) > 1);
  const branchTip = data.turns.find(t => t.parent === forkPoint.id);

  calls.inputBoxResponses.push("oauth-experiment");
  await calls.panels[0]._onMessage({ type: "forkTurn", turnId: forkPoint.id });
  check("可从所选轮次创建命名 Claude 分支", () => {
    const term = calls.terminals.at(-1);
    assert.ok(term.shown, "终端没有显示");
    assert.strictEqual(term.options.shellPath, "claude");
    assert.strictEqual(term.options.cwd, "/tmp");
    assert.deepStrictEqual(term.options.shellArgs, [
      "--resume", data.id,
      `--resume-session-at=${forkPoint.resumeAt}`,
      "--fork-session", "--name", "oauth-experiment",
    ]);
  });

  await calls.panels[0]._onMessage({ type: "resumeTurn", turnId: branchTip.id });
  check("可切换到所选分支尖端", () => {
    const term = calls.terminals.at(-1);
    assert.ok(term.shown, "终端没有显示");
    assert.deepStrictEqual(term.options.shellArgs, [
      "--resume", data.id,
      `--resume-session-at=${branchTip.resumeAt}`,
    ]);
    assert.ok(!term.options.shellArgs.includes("--fork-session"));
  });

  const terminalCount = calls.terminals.length;
  await calls.panels[0]._onMessage({ type: "resumeTurn", turnId: "not-a-real-turn" });
  check("拒绝 Webview 请求不存在的轮次", () =>
    assert.strictEqual(calls.terminals.length, terminalCount));

  ext.deactivate();
  Module._load = origLoad;

  for (const [mark, name] of checks) console.log(`  ${mark} ${name}`);
  const failed = checks.filter(c => c[0] === "✗").length;
  console.log(`\n${checks.length} 项检查 · 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}, 900);
