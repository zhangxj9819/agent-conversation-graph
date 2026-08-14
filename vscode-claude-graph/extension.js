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

const {
  PROJECTS_DIR, parseConversation, groupSessionFiles, listSessionFiles,
} = require("./src/parser");
const { createBranchSession } = require("./src/session-branch");

/** 合并解析结果按全部成员文件的 mtime + size 缓存，避免重复读大文件。 */
const cache = new Map();

function loadConversation(conversation) {
  if (!conversation?.sessions?.length) return null;
  const signature = conversation.sessions
    .map(session => `${session.file}:${session.mtimeMs}:${session.size}`)
    .sort()
    .join("|");
  const cacheKey = conversation.key || conversation.id;
  const hit = cache.get(cacheKey);
  if (hit && hit.signature === signature) return hit.data;

  const cfg = vscode.workspace.getConfiguration("claudeGraph");
  const data = parseConversation(conversation.sessions, {
    maxChars: cfg.get("maxChars", 2000),
    maxPrompt: cfg.get("maxPrompt", 20000),
  });
  cache.set(cacheKey, { signature, data });
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
    this.workspacePath = null;
    this.projects = [];
  }

  refresh() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.workspacePath = folder?.uri?.fsPath ? path.resolve(folder.uri.fsPath) : null;
    if (!this.workspacePath) {
      this.projects = [];
    } else {
      // Claude Code 用 cwd 中的 / 替换成 - 作为项目记录目录名。只保留当前
      // VS Code 工作区对应的目录，避免在侧栏泄露或误操作其他项目的会话。
      const encoded = this.workspacePath.replace(/\//g, "-");
      this.projects = listSessionFiles(PROJECTS_DIR)
        .filter(project => project.dir === encoded)
        .map(project => {
          const conversations = groupSessionFiles(project.sessions)
            .map(conversation => ({
              ...conversation,
              // 根 UUID 在不同项目理论上也可能相同；内部键必须带项目边界。
              key: JSON.stringify([project.path, conversation.id]),
            }));
          return { ...project, workspacePath: this.workspacePath, conversations };
        });
    }
    vscode.commands.executeCommand("setContext", "claudeGraph.hasSessions",
      this.projects.length > 0);
    this._onDidChange.fire();
  }

  getConversation(key) {
    if (typeof key !== "string") return null;
    for (const project of this.projects) {
      const conversation = project.conversations.find(item => item.key === key);
      if (conversation) return conversation;
    }
    return null;
  }

  latestConversation() {
    return this.projects[0]?.conversations[0] || null;
  }

  getTreeItem(el) { return el; }

  getChildren(el) {
    if (!el) {
      // 顶层只会有当前工作区这个项目。
      return this.projects.map(p => {
        const label = path.basename(p.workspacePath);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${p.conversations.length} 个对话`;
        item.tooltip = p.workspacePath;
        item.iconPath = new vscode.ThemeIcon("folder");
        item.contextValue = "project";
        item._project = p;
        return item;
      });
    }

    if (el.contextValue !== "project") return [];

    const showNoise = vscode.workspace.getConfiguration("claudeGraph")
      .get("showSystemEvents", false);

    return el._project.conversations.map(conversation => {
      const data = loadConversation(conversation);
      if (!data) return null;
      const st = statsOf(data.turns, showNoise);
      const item = new vscode.TreeItem(data.title, vscode.TreeItemCollapsibleState.None);
      item.description = `${st.turns} 轮${st.forks ? ` · ${st.forks} 分叉` : ""}` +
        (data.sessionCount > 1 ? ` · ${data.sessionCount} 个分支会话` : "");
      item.tooltip = new vscode.MarkdownString(
        `**${data.title}**\n\n` +
        `${st.turns} 轮 · ${st.forks} 处分叉\n\n` +
        `${data.sessionCount} 个 session 文件合并为一个对话标识\n\n` +
        `${data.start.slice(0, 16).replace("T", " ")} → ${data.end.slice(0, 16).replace("T", " ")}\n\n` +
        `\`${data.id}\``);
      // 有分叉的会话才是这张图有看头的地方，用图标区分
      item.iconPath = new vscode.ThemeIcon(st.forks ? "git-branch" : "comment-discussion");
      item.contextValue = "session";
      item.resourceUri = vscode.Uri.file(conversation.file);
      item._conversation = conversation;
      item.command = {
        command: "claudeGraph.open",
        title: "打开分支图",
        arguments: [conversation.key],
      };
      return item;
    }).filter(Boolean);
  }
}

// ---------------------------------------------------------------- Webview

let panel = null;
let currentConversationKey = null;

function disposeGraphPanel() {
  currentConversationKey = null;
  if (panel) panel.dispose();
}

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

function postConversation(conversation) {
  if (!panel) return;
  const data = loadConversation(conversation);
  if (!data) {
    disposeGraphPanel();
    vscode.window.showWarningMessage(`无法解析对话：${conversation.id.slice(0, 8)}`);
    return;
  }
  currentConversationKey = conversation.key;
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
 * 在独立终端中恢复到某个原始消息。Claude Code 2.1.231 的 /branch 与
 * --fork-session 只能从当前叶子分支，因此先把截至所选消息的祖先链物化成一个
 * 独立 session，再恢复它。原会话保持不变。绝不接受 webview 传来的路径或 UUID，
 * 所有参数都从当前重新解析的会话中取得。
 */
async function openClaudeAtTurn(conversation, turnId, fork) {
  const data = loadConversation(conversation);
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

  const sourceFile = turn.sourceFile;
  const sourceAllowed = typeof sourceFile === "string" && conversation.sessions.some(session =>
    path.resolve(session.file) === path.resolve(sourceFile));
  if (!sourceAllowed) {
    vscode.window.showErrorMessage("找不到所选轮次所属的原始 session 文件，无法安全创建分支。");
    return;
  }

  let branch;
  try {
    branch = createBranchSession(sourceFile, resumeAt, { name: branchName });
    cache.delete(conversation.key);
    const args = ["--resume", branch.id];
    if (branchName) args.push("--name", branchName);
    const terminal = vscode.window.createTerminal({
      name: fork ? `Claude 分支 · ${branchName || turn.short}` : `Claude · ${turn.short}`,
      cwd,
      shellPath: executable,
      shellArgs: args,
    });
    terminal.show();
    vscode.window.showInformationMessage(fork
      ? `已从所选轮次创建独立 Claude 分支（${branch.id.slice(0, 8)}）。`
      : `已把所选分支尖端复制为独立会话（${branch.id.slice(0, 8)}）并打开。`
    );
  } catch (err) {
    // createTerminal 本身若失败，不留下一个用户从未真正打开的空分支。
    if (branch?.file) {
      try { fs.unlinkSync(branch.file); } catch { /* 文件可能已由 Claude 接管 */ }
    }
    vscode.window.showErrorMessage(
      `无法启动 Claude：${err instanceof Error ? err.message : String(err)}`);
  }
}

function openGraph(context, conversationId, tree) {
  const conversation = tree.getConversation(conversationId);
  if (!conversation) {
    vscode.window.showWarningMessage("该对话不属于当前工作区，分支图不会打开。");
    return;
  }
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
    panel.onDidDispose(() => {
      panel = null;
      currentConversationKey = null;
    }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async msg => {
      const current = tree.getConversation(currentConversationKey);
      if (msg.type === "openFile" && current) {
        vscode.window.showTextDocument(vscode.Uri.file(current.file));
      } else if (msg.type === "ready" && current) {
        postConversation(current);
      } else if ((msg.type === "forkTurn" || msg.type === "resumeTurn") && current) {
        await openClaudeAtTurn(current, msg.turnId, msg.type === "forkTurn");
      }
    }, null, context.subscriptions);
  }
  postConversation(conversation);
}

/** 重扫当前工作区，并确保已打开的图没有越过工作区边界或指向已删除文件。 */
function refreshTreeAndPanel(tree, changedFile = null) {
  tree.refresh();
  if (!currentConversationKey) return;
  const conversation = tree.getConversation(currentConversationKey);
  if (!conversation) {
    disposeGraphPanel();
    return;
  }
  const changedPath = changedFile ? path.resolve(changedFile) : null;
  const changedMember = !changedPath || conversation.sessions.some(session =>
    path.resolve(session.file) === changedPath) ||
    (!fs.existsSync(changedPath) && conversation.sessions.some(session =>
      path.dirname(path.resolve(session.file)) === path.dirname(changedPath)));
  if (changedMember) {
    postConversation(conversation);
  }
}

// ---------------------------------------------------------------- 激活

function activate(context) {
  const tree = new SessionTree();
  tree.refresh();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudeGraph.sessions", tree),

    vscode.commands.registerCommand("claudeGraph.refresh", () => {
      cache.clear();
      refreshTreeAndPanel(tree);
    }),

    vscode.commands.registerCommand("claudeGraph.open", conversationId => {
      if (typeof conversationId === "string") openGraph(context, conversationId, tree);
    }),

    vscode.commands.registerCommand("claudeGraph.openCurrent", () => {
      const conversation = tree.latestConversation();
      if (conversation) return openGraph(context, conversation.key, tree);
      vscode.window.showInformationMessage(
        "当前工作区没有 Claude Code 会话记录。先在这个目录中启动 Claude Code 并进行对话。");
      vscode.commands.executeCommand("claudeGraph.sessions.focus");
    }),

    vscode.commands.registerCommand("claudeGraph.revealFile", item => {
      const conversation = tree.getConversation(item?._conversation?.key);
      if (conversation) vscode.window.showTextDocument(vscode.Uri.file(conversation.file));
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
      refreshTreeAndPanel(tree, uri.fsPath);
    }, 500);
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      cache.clear();
      refreshTreeAndPanel(tree);
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration("claudeGraph")) return;
      if (e.affectsConfiguration("claudeGraph.maxChars") ||
          e.affectsConfiguration("claudeGraph.maxPrompt")) cache.clear();
      refreshTreeAndPanel(tree);
    }),
  );
}

function deactivate() { cache.clear(); }

module.exports = { activate, deactivate };
