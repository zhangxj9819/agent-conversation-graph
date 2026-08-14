/**
 * Claude / Codex 对话分支图 —— VS Code 插件入口。
 *
 * 职责划分：
 *   扩展宿主（本文件）：扫描 Claude/Codex rollout、解析 .jsonl、监听文件变化
 *   webview（media/viewer.js）：泳道布局与渲染
 * 会话正文按需加载 —— 树视图只读文件元信息，选中某个会话才解析它。
 */
"use strict";

const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");

const {
  PROJECTS_DIR: CLAUDE_PROJECTS_DIR,
  parseConversation: parseClaudeConversation,
  groupSessionFiles: groupClaudeSessionFiles,
  listSessionFiles: listClaudeSessionFiles,
} = require("./src/parser");
const {
  SESSIONS_DIR: CODEX_SESSIONS_DIR,
  SESSION_INDEX: CODEX_SESSION_INDEX,
  parseCodexConversation, groupCodexSessions, listCodexSessionFiles,
} = require("./src/codex-parser");
const { createBranchSession } = require("./src/session-branch");
const { forkThread: forkCodexThread } = require("./src/codex-app-server");

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
  const parser = conversation.provider === "codex"
    ? parseCodexConversation : parseClaudeConversation;
  const data = parser(conversation.sessions, {
    maxChars: cfg.get("maxChars", 2000),
    maxPrompt: cfg.get("maxPrompt", 20000),
    rootId: conversation.id,
  });
  if (data) {
    data.provider = conversation.provider || data.provider || "claude";
    data.providerLabel = data.provider === "codex" ? "Codex" : "Claude Code";
    data.key = conversation.key;
  }
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
  constructor(provider) {
    this.provider = provider;
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
      const conversations = [];

      const encoded = this.workspacePath.replace(/\//g, "-");
      if (this.provider === "claude") {
        // Claude Code 用 cwd 中的 / 替换成 - 作为项目记录目录名。
        const claudeProject = listClaudeSessionFiles(CLAUDE_PROJECTS_DIR)
          .find(project => project.dir === encoded);
        for (const conversation of groupClaudeSessionFiles(claudeProject?.sessions || [])) {
          conversations.push({
            ...conversation,
            provider: "claude",
            key: JSON.stringify(["claude", claudeProject.path, conversation.id]),
          });
        }
      } else {
        // Codex rollout 自带 cwd；只纳入精确匹配当前工作区的交互 thread，子 agent 排除。
        const codexSessions = listCodexSessionFiles(CODEX_SESSIONS_DIR, CODEX_SESSION_INDEX);
        for (const conversation of groupCodexSessions(codexSessions, this.workspacePath)) {
          conversations.push({
            ...conversation,
            key: JSON.stringify(["codex", this.workspacePath, conversation.id]),
          });
        }
      }

      conversations.sort((a, b) => b.mtimeMs - a.mtimeMs || a.key.localeCompare(b.key));
      this.projects = conversations.length ? [{
        dir: encoded,
        path: this.workspacePath,
        workspacePath: this.workspacePath,
        conversations,
      }] : [];
    }
    const contextPrefix = this.provider === "codex" ? "codexGraph" : "claudeGraph";
    vscode.commands.executeCommand("setContext", `${contextPrefix}.hasSessions`,
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
        (data.sessionCount > 1 ? ` · ${data.sessionCount} 个分支` : "");
      item.tooltip = new vscode.MarkdownString(
        `**${data.providerLabel} · ${data.title}**\n\n` +
        `${st.turns} 轮 · ${st.forks} 处分叉\n\n` +
        `${data.sessionCount} 个 ${data.provider === "codex" ? "thread" : "session 文件"}` +
        `合并为一个对话标识\n\n` +
        `${data.start.slice(0, 16).replace("T", " ")} → ${data.end.slice(0, 16).replace("T", " ")}\n\n` +
        `\`${data.id}\``);
      // 有分叉的会话才是这张图有看头的地方，用图标区分
      item.iconPath = new vscode.ThemeIcon(st.forks ? "git-branch" :
        (data.provider === "codex" ? "sparkle" : "comment-discussion"));
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
let sessionTrees = [];

function findConversation(key) {
  if (typeof key !== "string") return null;
  for (const tree of sessionTrees) {
    const conversation = tree.getConversation(key);
    if (conversation) return conversation;
  }
  return null;
}

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
<title>Claude / Codex 对话分支图</title>
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
  panel.title = `${data.providerLabel} 分支图 · ${data.title.slice(0, 28)}`;
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

/**
 * Codex 精确分支走官方 app-server thread/fork(lastTurnId)；继续尖端则直接 resume
 * 保存该尖端的原 thread。两种操作都只使用重新解析得到的可信 ID 和 cwd。
 */
async function openCodexAtTurn(conversation, turnId, fork) {
  const data = loadConversation(conversation);
  const turn = data?.turns.find(item => item.id === turnId);
  if (!data || !turn) {
    vscode.window.showWarningMessage("所选 Codex 轮次已经不存在，请刷新分支图后重试。");
    return;
  }
  if (!UUID_RE.test(turn.id) || !UUID_RE.test(turn.sourceThreadId || "")) {
    vscode.window.showErrorMessage("Codex thread 或 turn UUID 无效，无法安全启动。");
    return;
  }
  const sourceAllowed = conversation.sessions.some(session => session.id === turn.sourceThreadId);
  if (!sourceAllowed) {
    vscode.window.showErrorMessage("所选轮次不属于当前工作区里的 Codex thread。");
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
      title: "从此轮创建 Codex 分支",
      prompt: "为新 Codex 分支命名；留空则使用原对话标题。按 Esc 取消。",
      placeHolder: `branch-${turn.short}`,
      ignoreFocusOut: true,
      validateInput: value => value.trim().length > 100 ? "名称不能超过 100 个字符" : undefined,
    });
    if (input === undefined) return;
    branchName = input.trim();
  } else if (data.turns.some(item => item.parent === turn.id)) {
    vscode.window.showWarningMessage("只能直接继续分支尖端；历史节点请使用“创建分支”。");
    return;
  }

  const configured = vscode.workspace.getConfiguration("claudeGraph")
    .get("codexCommand", "codex");
  const executable = typeof configured === "string" && configured.trim()
    ? configured.trim() : "codex";

  let targetThreadId = turn.sourceThreadId;
  let branchResult = null;
  try {
    if (fork) {
      branchResult = await forkCodexThread({
        command: executable,
        threadId: turn.sourceThreadId,
        lastTurnId: turn.id,
        cwd,
        name: branchName,
      });
      targetThreadId = branchResult.id;
      cache.delete(conversation.key);
    }

    const terminal = vscode.window.createTerminal({
      name: fork ? `Codex 分支 · ${branchName || turn.short}` : `Codex · ${turn.short}`,
      cwd,
      shellPath: executable,
      shellArgs: ["resume", targetThreadId],
    });
    terminal.show();
    if (branchResult?.nameError) {
      vscode.window.showWarningMessage(
        `Codex 分支已创建并打开，但名称未保存：${branchResult.nameError}`);
    } else {
      vscode.window.showInformationMessage(fork
        ? `已从所选轮次创建 Codex 分支（${targetThreadId.slice(0, 8)}）。`
        : `已打开该 Codex 分支（${targetThreadId.slice(0, 8)}）继续对话。`);
    }
  } catch (err) {
    const suffix = branchResult?.id ? ` 新分支 ${branchResult.id} 已保留。` : "";
    vscode.window.showErrorMessage(
      `无法启动 Codex：${err instanceof Error ? err.message : String(err)}${suffix}`);
  }
}

function openGraph(context, conversationId) {
  const conversation = findConversation(conversationId);
  if (!conversation) {
    vscode.window.showWarningMessage("该对话不属于当前工作区，分支图不会打开。");
    return;
  }
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = vscode.window.createWebviewPanel(
      "claudeGraph.view", "Claude / Codex 对话分支图", vscode.ViewColumn.Active,
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
      const current = findConversation(currentConversationKey);
      if (msg.type === "openFile" && current) {
        vscode.window.showTextDocument(vscode.Uri.file(current.file));
      } else if (msg.type === "ready" && current) {
        postConversation(current);
      } else if ((msg.type === "forkTurn" || msg.type === "resumeTurn") && current) {
        const handler = current.provider === "codex" ? openCodexAtTurn : openClaudeAtTurn;
        await handler(current, msg.turnId, msg.type === "forkTurn");
      }
    }, null, context.subscriptions);
  }
  postConversation(conversation);
}

/** 重扫当前工作区，并确保已打开的图没有越过工作区边界或指向已删除文件。 */
function refreshTreeAndPanel(tree, changedFile = null) {
  tree.refresh();
  refreshCurrentPanel(changedFile);
}

function refreshAllTreesAndPanel(changedFile = null) {
  for (const tree of sessionTrees) tree.refresh();
  refreshCurrentPanel(changedFile);
}

function refreshCurrentPanel(changedFile = null) {
  if (!currentConversationKey) return;
  const conversation = findConversation(currentConversationKey);
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
  const claudeTree = new SessionTree("claude");
  const codexTree = new SessionTree("codex");
  sessionTrees = [claudeTree, codexTree];
  for (const tree of sessionTrees) tree.refresh();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudeGraph.sessions", claudeTree),
    vscode.window.registerTreeDataProvider("codexGraph.sessions", codexTree),

    vscode.commands.registerCommand("claudeGraph.refresh", () => {
      cache.clear();
      refreshTreeAndPanel(claudeTree);
    }),

    vscode.commands.registerCommand("codexGraph.refresh", () => {
      cache.clear();
      refreshTreeAndPanel(codexTree);
    }),

    vscode.commands.registerCommand("claudeGraph.open", conversationId => {
      if (typeof conversationId === "string") openGraph(context, conversationId);
    }),

    vscode.commands.registerCommand("claudeGraph.openCurrent", () => {
      const conversation = claudeTree.latestConversation();
      if (conversation) return openGraph(context, conversation.key);
      vscode.window.showInformationMessage(
        "当前工作区没有 Claude Code 会话记录。先在这个目录中启动 Claude Code 并进行对话。");
      vscode.commands.executeCommand("claudeGraph.sessions.focus");
    }),

    vscode.commands.registerCommand("codexGraph.openCurrent", () => {
      const conversation = codexTree.latestConversation();
      if (conversation) return openGraph(context, conversation.key);
      vscode.window.showInformationMessage(
        "当前工作区没有 Codex 会话记录。先在这个目录中启动 Codex 并进行对话。");
      vscode.commands.executeCommand("codexGraph.sessions.focus");
    }),

    vscode.commands.registerCommand("claudeGraph.revealFile", item => {
      const conversation = findConversation(item?._conversation?.key);
      if (conversation) vscode.window.showTextDocument(vscode.Uri.file(conversation.file));
    }),
  );

  // 对话写入时自动刷新。两个记录目录都在工作区之外，所以用绝对 RelativePattern。
  let timer = null;
  const pendingTrees = new Set();
  const onChange = (tree, uri) => {
    if (!vscode.workspace.getConfiguration("claudeGraph").get("autoRefresh", true)) return;
    pendingTrees.add(tree);
    clearTimeout(timer);
    // Claude 与 Codex 都逐行追加，一次回答会触发很多次事件，去抖一下。
    timer = setTimeout(() => {
      for (const pending of pendingTrees) pending.refresh();
      pendingTrees.clear();
      // 多个 provider 可能在同一个去抖窗口内写入；重投当前面板即可由缓存判断是否重解析。
      refreshCurrentPanel();
    }, 500);
  };
  for (const [root, tree] of [
    [CLAUDE_PROJECTS_DIR, claudeTree],
    [CODEX_SESSIONS_DIR, codexTree],
  ]) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), "**/*.jsonl"));
    watcher.onDidChange(uri => onChange(tree, uri));
    watcher.onDidCreate(uri => onChange(tree, uri));
    watcher.onDidDelete(uri => onChange(tree, uri));
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      cache.clear();
      refreshAllTreesAndPanel();
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration("claudeGraph")) return;
      if (e.affectsConfiguration("claudeGraph.maxChars") ||
          e.affectsConfiguration("claudeGraph.maxPrompt")) cache.clear();
      refreshAllTreesAndPanel();
    }),
  );
}

function deactivate() {
  cache.clear();
  sessionTrees = [];
}

module.exports = { activate, deactivate };
