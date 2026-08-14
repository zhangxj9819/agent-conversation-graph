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
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

// 分支测试会真实创建一个新的 JSONL。始终在临时副本上运行，固定 fixture 只读。
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-graph-test-"));
const testConfigDir = path.join(testRoot, "config");
fs.cpSync(path.resolve(__dirname, "fixtures"), testConfigDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = testConfigDir;

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

check("树顶层只列出当前工作区项目", () => {
  assert.strictEqual(projects.length, 1, "混入了其他工作区的项目");
  assert.strictEqual(projects[0].label, "tmp");
  assert.strictEqual(projects[0].description, "2 个对话");
  assert.ok(projects.every(p => p.contextValue === "project"));
  assert.ok(projects.every(p => typeof p.label === "string" && p.label.length));
});

let sessions = [];
check("展开项目按根 UUID 列出对话而不是 JSONL 文件", () => {
  sessions = projects.flatMap(p => tree.getChildren(p));
  assert.strictEqual(sessions.length, 2, "共享根 UUID 的分支 session 没有合并");
  assert.ok(sessions.every(s => s.contextValue === "session"));
  assert.ok(sessions.every(s => s.command?.command === "claudeGraph.open"));
  assert.ok(sessions.every(s => /^\d+ 轮/.test(s.description)));
  assert.ok(sessions.every(s => path.basename(path.dirname(s.resourceUri.fsPath)) === "-tmp"),
    "混入了其他工作区的会话");
  assert.ok(sessions.some(s => s.description.includes("2 个分支会话")),
    "没有标出被合并的两个 session 文件");
});

check("有分叉的会话用 git-branch 图标区分", () => {
  const forked = sessions.filter(s => s.description.includes("分叉"));
  assert.ok(forked.length > 0, "本机数据里应当存在有分叉的会话");
  assert.ok(forked.every(s => s.iconPath.id === "git-branch"));
  assert.ok(sessions.filter(s => !s.description.includes("分叉"))
    .every(s => s.iconPath.id === "comment-discussion"));
});

// ---- 打开 webview ---------------------------------------------------------
const targetItem = sessions.find(s => s.description.includes("分叉"));
const targetFile = targetItem.resourceUri.fsPath;
const targetConversationId = targetItem.command.arguments[0];
const outsideFile = path.join(testConfigDir,
  "projects/-other/33333333-3333-4333-8333-333333333333.jsonl");

calls.registeredCommands.get("claudeGraph.open")(outsideFile);
check("拒绝打开其他工作区的会话", () => {
  assert.strictEqual(calls.panels.length, 0, "为其他工作区创建了图面板");
  assert.ok(calls.executed.some(x => x[0] === "warn" && x[1].includes("不属于当前工作区")));
});

calls.registeredCommands.get("claudeGraph.open")(targetConversationId);

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
  assert.strictEqual(msg.session.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.strictEqual(msg.session.sessionCount, 2);
  assert.ok(msg.session.turns.some(t => t.body === "改用 Passkey"),
    "另一个 session 的独有轮次没有合入对话树");
  assert.ok(msg.session.turns.every(t => typeof t.sourceFile === "string" && t.sourceFile),
    "合并后有轮次丢失原始文件定位");
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

check("聚合后的侧栏条目仍能打开代表 session 原文件", () => {
  calls.executed.length = 0;
  calls.registeredCommands.get("claudeGraph.revealFile")(targetItem);
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
  const sourceDir = path.dirname(targetFile);
  const sourceBeforeBranch = new Map(fs.readdirSync(sourceDir)
    .filter(name => name.endsWith(".jsonl"))
    .map(name => {
      const file = path.join(sourceDir, name);
      return [file, fs.readFileSync(file, "utf8")];
    }));
  const assertSourcesUnchanged = () => {
    for (const [file, before] of sourceBeforeBranch) {
      assert.strictEqual(fs.readFileSync(file, "utf8"), before,
        `原 session 被改写：${path.basename(file)}`);
    }
  };

  calls.inputBoxResponses.push("oauth-experiment");
  await calls.panels[0]._onMessage({ type: "forkTurn", turnId: forkPoint.id });
  check("可从所选轮次创建命名 Claude 分支", () => {
    const term = calls.terminals.at(-1);
    assert.ok(term.shown, "终端没有显示");
    assert.strictEqual(term.options.shellPath, "claude");
    assert.strictEqual(term.options.cwd, "/tmp");
    assert.strictEqual(term.options.shellArgs[0], "--resume");
    assert.notStrictEqual(term.options.shellArgs[1], data.id, "仍在恢复原会话");
    assert.deepStrictEqual(term.options.shellArgs.slice(2), ["--name", "oauth-experiment"]);
    assert.ok(!term.options.shellArgs.some(arg => arg.startsWith("--resume-session-at")),
      "仍在使用 Claude 2.1.231 已移除的参数");
    assert.ok(!term.options.shellArgs.includes("--fork-session"),
      "物化后的新会话不应再次从最新节点分叉");
  });

  check("新分支只复制到所选轮次且原会话逐字节不变", () => {
    const branchId = calls.terminals.at(-1).options.shellArgs[1];
    const branchFile = path.join(sourceDir, `${branchId}.jsonl`);
    const rows = fs.readFileSync(branchFile, "utf8").trim().split("\n").map(JSON.parse);
    const uuids = rows.filter(r => r.uuid).map(r => r.uuid);
    assert.deepStrictEqual(uuids, [forkPoint.id, forkPoint.resumeAt]);
    assert.strictEqual(rows.at(-1).type, "last-prompt");
    assert.strictEqual(rows.at(-1).leafUuid, forkPoint.resumeAt);
    assert.ok(rows.filter(r => r.uuid).every(r => r.sessionId === branchId));
    assert.ok(rows.some(r => r.type === "custom-title" &&
      r.customTitle === "oauth-experiment"));
    assert.strictEqual(require("../src/parser").parseSession(branchFile).title,
      "oauth-experiment", "新分支名没有显示为会话标题");
    assertSourcesUnchanged();
  });

  await calls.panels[0]._onMessage({ type: "resumeTurn", turnId: branchTip.id });
  check("切换旧分支尖端时也精确复制为独立会话", () => {
    const term = calls.terminals.at(-1);
    assert.ok(term.shown, "终端没有显示");
    assert.strictEqual(term.options.shellArgs[0], "--resume");
    assert.notStrictEqual(term.options.shellArgs[1], data.id);
    assert.strictEqual(term.options.shellArgs.length, 2);
    const branchFile = path.join(sourceDir,
      `${term.options.shellArgs[1]}.jsonl`);
    const rows = fs.readFileSync(branchFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.strictEqual(rows.at(-1).leafUuid, branchTip.resumeAt);
    assert.ok(!rows.some(r => r.uuid === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
      "混入了另一个更新分支的消息");
    assert.ok(!rows.some(r => r.uuid === "99999999-9999-4999-8999-999999999999"),
      "混入了另一个 session 文件的分支消息");
    assertSourcesUnchanged();
  });

  calls.registeredCommands.get("claudeGraph.refresh")();
  check("新增分支 session 刷新后仍只占一个对话位置", () => {
    const refreshedProject = tree.getChildren()[0];
    const conversations = tree.getChildren(refreshedProject);
    assert.strictEqual(conversations.length, 2);
    const merged = conversations.find(item => item._conversation.id === data.id);
    assert.ok(merged, "刷新后丢失原对话标识");
    assert.ok(merged.description.includes("4 个分支会话"), merged.description);
    assert.strictEqual(calls.messages.at(-1).session.sessionCount, 4);
  });

  const terminalCount = calls.terminals.length;
  await calls.panels[0]._onMessage({ type: "resumeTurn", turnId: "not-a-real-turn" });
  check("拒绝 Webview 请求不存在的轮次", () =>
    assert.strictEqual(calls.terminals.length, terminalCount));

  const activePanel = calls.panels[0];
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file("/other") }];
  calls.onWorkspaceFolders({});
  const switchedProjects = tree.getChildren();
  check("切换工作区后只列出新目录的会话", () => {
    assert.strictEqual(switchedProjects.length, 1);
    assert.strictEqual(switchedProjects[0].label, "other");
    const switchedSessions = tree.getChildren(switchedProjects[0]);
    assert.strictEqual(switchedSessions.length, 1);
    assert.strictEqual(switchedSessions[0].resourceUri.fsPath, outsideFile);
  });
  check("切换工作区后关闭旧目录的图面板", () =>
    assert.strictEqual(activePanel.disposed, true));

  ext.deactivate();
  Module._load = origLoad;
  fs.rmSync(testRoot, { recursive: true, force: true });

  for (const [mark, name] of checks) console.log(`  ${mark} ${name}`);
  const failed = checks.filter(c => c[0] === "✗").length;
  console.log(`\n${checks.length} 项检查 · 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}, 900);
