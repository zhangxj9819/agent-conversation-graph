/**
 * Claude 对话分支图 —— VS Code 插件入口。
 *
 * 职责划分：
 *   扩展宿主（本文件）：扫描 ~/.claude/projects、解析 .jsonl、监听文件变化
 *   webview（media/viewer.js）：泳道布局与渲染
 * 会话正文按需加载 —— 树视图只读文件元信息，选中某个会话才解析它。
 */
"use strict";

const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");

const { PROJECTS_DIR, parseSession, listSessionFiles } = require("./src/parser");

/** 解析结果按 mtime + size 缓存，避免重复读大文件。 */
const cache = new Map();

function loadSession(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;

  const cfg = vscode.workspace.getConfiguration("claudeGraph");
  const data = parseSession(file, {
    maxChars: cfg.get("maxChars", 2000),
    maxPrompt: cfg.get("maxPrompt", 20000),
  });
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

/** 与 layout.js 里 contract 的可见性判断保持一致，仅用于树视图上的计数。 */
function statsOf(turns, showNoise) {
  const visible = t => showNoise || t.kind === "prompt" || t.kind === "compact";
  const byId = new Map(turns.map(t => [t.id, t]));
  const keep = new Set(turns.filter(visible).map(t => t.id));
  const counts = new Map();
  let n = 0;
  for (const t of turns) {
    if (!keep.has(t.id)) continue;
    n++;
    let p = t.parent;
    const seen = new Set();
    while (p && byId.has(p) && !keep.has(p) && !seen.has(p)) { seen.add(p); p = byId.get(p).parent; }
    if (p && keep.has(p)) counts.set(p, (counts.get(p) || 0) + 1);
  }
  return { turns: n, forks: [...counts.values()].filter(v => v > 1).length };
}

// ---------------------------------------------------------------- 树视图

class SessionTree {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.projects = [];
  }

  refresh() {
    this.projects = listSessionFiles(PROJECTS_DIR);
    vscode.commands.executeCommand("setContext", "claudeGraph.hasSessions",
      this.projects.length > 0);
    this._onDidChange.fire();
  }

  getTreeItem(el) { return el; }

  getChildren(el) {
    if (!el) {
      // 顶层：项目。目录名是把路径里的 / 换成 - 得来的，不可逆，
      // 所以先解析首个会话拿真实 cwd 当标题。
      return this.projects.map(p => {
        const first = loadSession(p.sessions[0].file);
        const label = first && first.cwd ? path.basename(first.cwd) : p.dir;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${p.sessions.length} 个会话`;
        item.tooltip = (first && first.cwd) || p.path;
        item.iconPath = new vscode.ThemeIcon("folder");
        item.contextValue = "project";
        item._project = p;
        return item;
      });
    }

    if (el.contextValue !== "project") return [];

    const showNoise = vscode.workspace.getConfiguration("claudeGraph")
      .get("showSystemEvents", false);

    return el._project.sessions.map(s => {
      const data = loadSession(s.file);
      if (!data) return null;
      const st = statsOf(data.turns, showNoise);
      const item = new vscode.TreeItem(data.title, vscode.TreeItemCollapsibleState.None);
      item.description = `${st.turns} 轮${st.forks ? ` · ${st.forks} 分叉` : ""}`;
      item.tooltip = new vscode.MarkdownString(
        `**${data.title}**\n\n` +
        `${st.turns} 轮 · ${st.forks} 处分叉\n\n` +
        `${data.start.slice(0, 16).replace("T", " ")} → ${data.end.slice(0, 16).replace("T", " ")}\n\n` +
        `\`${data.id}\``);
      // 有分叉的会话才是这张图有看头的地方，用图标区分
      item.iconPath = new vscode.ThemeIcon(st.forks ? "git-branch" : "comment-discussion");
      item.contextValue = "session";
      item.resourceUri = vscode.Uri.file(s.file);
      item.command = {
        command: "claudeGraph.open",
        title: "打开分支图",
        arguments: [s.file],
      };
      return item;
    }).filter(Boolean);
  }
}

// ---------------------------------------------------------------- Webview

let panel = null;
let currentFile = null;

function webviewHtml(webview, extensionUri) {
  const uri = f => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f));
  const nonce = Array.from({ length: 32 },
    () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
      [Math.floor(Math.random() * 62)]).join("");

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';
  style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("viewer.css")}">
<title>Claude 对话分支图</title>
</head>
<body>
  <header>
    <span id="hdr-title">…</span>
    <span class="stats" id="stats"></span>
    <span class="spacer"></span>
    <input type="search" id="q" placeholder="搜索提问内容…" autocomplete="off">
    <label class="chk"><input type="checkbox" id="f-noise"> 命令与系统事件</label>
  </header>
  <main>
    <section id="center"></section>
    <aside id="detail"></aside>
  </main>
  <script nonce="${nonce}" src="${uri("layout.js")}"></script>
  <script nonce="${nonce}" src="${uri("viewer.js")}"></script>
</body>
</html>`;
}

function postSession(file) {
  if (!panel) return;
  const data = loadSession(file);
  if (!data) {
    vscode.window.showWarningMessage(`无法解析会话：${path.basename(file)}`);
    return;
  }
  currentFile = file;
  panel.title = `分支图 · ${data.title.slice(0, 28)}`;
  panel.webview.postMessage({
    type: "session",
    session: data,
    showNoise: vscode.workspace.getConfiguration("claudeGraph").get("showSystemEvents", false),
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function existingSessionCwd(data, turn) {
  const candidates = [turn.cwd, data.cwd,
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // 会话可能来自已经移动或删除的工作目录，继续尝试当前工作区。
    }
  }
  return null;
}

/**
 * 在独立终端中恢复到某个原始消息。fork=true 时让 Claude 创建新 session ID；
 * 否则在同一 session 的所选分支尖端继续。绝不接受 webview 传来的路径或 UUID，
 * 所有参数都从当前重新解析的会话中取得。
 */
async function openClaudeAtTurn(file, turnId, fork) {
  const data = loadSession(file);
  const turn = data?.turns.find(t => t.id === turnId);
  if (!data || !turn) {
    vscode.window.showWarningMessage("所选轮次已经不存在，请刷新分支图后重试。");
    return;
  }

  const resumeAt = turn.resumeAt || turn.id;
  if (!UUID_RE.test(data.id) || !UUID_RE.test(resumeAt)) {
    vscode.window.showErrorMessage("会话或轮次 UUID 无效，无法安全地启动 Claude。");
    return;
  }

  const cwd = existingSessionCwd(data, turn);
  if (!cwd) {
    vscode.window.showErrorMessage(
      `原工作目录不存在：${turn.cwd || data.cwd || "（记录中没有 cwd）"}`);
    return;
  }

  let branchName = "";
  if (fork) {
    const input = await vscode.window.showInputBox({
      title: "从此轮创建 Claude 分支",
      prompt: "为新分支命名；留空则由 Claude 自动命名。按 Esc 取消。",
      placeHolder: `branch-${turn.short}`,
      ignoreFocusOut: true,
      validateInput: value => value.trim().length > 100 ? "名称不能超过 100 个字符" : undefined,
    });
    if (input === undefined) return;
    branchName = input.trim();
  }

  const configured = vscode.workspace.getConfiguration("claudeGraph")
    .get("claudeCommand", "claude");
  const executable = typeof configured === "string" && configured.trim()
    ? configured.trim() : "claude";
  const args = ["--resume", data.id, `--resume-session-at=${resumeAt}`];
  if (fork) args.push("--fork-session");
  if (branchName) args.push("--name", branchName);

  try {
    const terminal = vscode.window.createTerminal({
      name: fork ? `Claude 分支 · ${branchName || turn.short}` : `Claude · ${turn.short}`,
      cwd,
      shellPath: executable,
      shellArgs: args,
    });
    terminal.show();
    vscode.window.showInformationMessage(fork
      ? "已在新终端从所选轮次创建 Claude 分支。"
      : "已在新终端切换到所选 Claude 分支。若原会话仍在运行，请避免同时输入。"
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `无法启动 Claude：${err instanceof Error ? err.message : String(err)}`);
  }
}

function openGraph(context, file) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = vscode.window.createWebviewPanel(
      "claudeGraph.view", "Claude 对话分支图", vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      });
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri);
    panel.onDidDispose(() => { panel = null; currentFile = null; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === "openFile" && currentFile) {
        vscode.window.showTextDocument(vscode.Uri.file(currentFile));
      } else if (msg.type === "ready" && currentFile) {
        postSession(currentFile);
      } else if ((msg.type === "forkTurn" || msg.type === "resumeTurn") && currentFile) {
        const fileAtClick = currentFile;
        await openClaudeAtTurn(fileAtClick, msg.turnId, msg.type === "forkTurn");
      }
    }, null, context.subscriptions);
  }
  postSession(file);
}

/** 当前工作区对应的最近一个会话。目录名是 cwd 把 / 换成 - 得来的。 */
function sessionForWorkspace() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  const encoded = folder.uri.fsPath.replace(/\//g, "-");
  for (const p of listSessionFiles(PROJECTS_DIR)) {
    if (p.dir === encoded) return p.sessions[0].file;   // sessions 已按 mtime 降序
  }
  // 退一步：按解析出来的真实 cwd 匹配
  for (const p of listSessionFiles(PROJECTS_DIR)) {
    const d = loadSession(p.sessions[0].file);
    if (d && d.cwd === folder.uri.fsPath) return p.sessions[0].file;
  }
  return null;
}

// ---------------------------------------------------------------- 激活

function activate(context) {
  const tree = new SessionTree();
  tree.refresh();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudeGraph.sessions", tree),

    vscode.commands.registerCommand("claudeGraph.refresh", () => {
      cache.clear();
      tree.refresh();
      if (currentFile) postSession(currentFile);
    }),

    vscode.commands.registerCommand("claudeGraph.open", file => {
      if (typeof file === "string") openGraph(context, file);
    }),

    vscode.commands.registerCommand("claudeGraph.openCurrent", () => {
      const file = sessionForWorkspace();
      if (file) return openGraph(context, file);
      vscode.window.showInformationMessage(
        "当前工作区没有对应的 Claude Code 会话记录。可以从侧边栏挑一个。");
      vscode.commands.executeCommand("claudeGraph.sessions.focus");
    }),

    vscode.commands.registerCommand("claudeGraph.revealFile", item => {
      const uri = item?.resourceUri;
      if (uri) vscode.window.showTextDocument(uri);
    }),
  );

  // 对话写入时自动刷新。记录目录在工作区之外，所以要用绝对 RelativePattern。
  let timer = null;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(PROJECTS_DIR), "**/*.jsonl"));
  const onChange = uri => {
    if (!vscode.workspace.getConfiguration("claudeGraph").get("autoRefresh", true)) return;
    clearTimeout(timer);
    // Claude Code 是逐行追加写的，一次回答会触发很多次事件，去抖一下
    timer = setTimeout(() => {
      tree.refresh();
      if (currentFile && uri.fsPath === currentFile) postSession(currentFile);
    }, 500);
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration("claudeGraph")) return;
      if (e.affectsConfiguration("claudeGraph.maxChars") ||
          e.affectsConfiguration("claudeGraph.maxPrompt")) cache.clear();
      tree.refresh();
      if (currentFile) postSession(currentFile);
    }),
  );
}

function deactivate() { cache.clear(); }

module.exports = { activate, deactivate };
