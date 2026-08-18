/**
 * 最小可用的 vscode API 替身，只为在没有编辑器的情况下跑通 activate()。
 * 覆盖到 extension.js 实际用到的那部分 —— 用不到的一律不实现，
 * 这样一旦插件用了没被 mock 的 API，测试会立刻抛错而不是静默通过。
 */
"use strict";

const fs = require("node:fs");
const pathMod = require("node:path");

class EventEmitter {
  constructor() { this.listeners = []; }
  get event() { return listener => { this.listeners.push(listener); return { dispose() {} }; }; }
  fire(v) { for (const l of this.listeners) l(v); }
  dispose() { this.listeners = []; }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon { constructor(id) { this.id = id; } }
class MarkdownString { constructor(value) { this.value = value; } }
class RelativePattern {
  constructor(base, pattern) { this.base = base; this.pattern = pattern; }
}

const Uri = {
  file: p => ({ fsPath: p, scheme: "file", path: p, toString: () => `file://${p}` }),
  joinPath: (base, ...parts) => Uri.file(pathMod.join(base.fsPath, ...parts)),
};

const calls = {
  registeredCommands: new Map(),
  treeProviders: new Map(),
  panels: [],
  messages: [],
  watchers: [],
  executed: [],
  terminals: [],
  inputBoxes: [],
  inputBoxResponses: [],
  quickPicks: [],
  quickPickResponses: [],
  warningMessages: [],
  warningResponses: [],
  workspaceStateUpdates: [],
  deletedFiles: [],
  deleteErrors: new Map(),
};

const config = {
  maxChars: 2000,
  maxPrompt: 20000,
  showSystemEvents: false,
  autoRefresh: true,
  claudeCommand: "claude",
  codexCommand: "codex",
};

const workspaceStateValues = new Map();
const workspaceState = {
  get(key, fallback) {
    return workspaceStateValues.has(key) ? workspaceStateValues.get(key) : fallback;
  },
  update(key, value) {
    workspaceStateValues.set(key, value);
    calls.workspaceStateUpdates.push({ key, value });
    return Promise.resolve();
  },
};

const vscode = {
  EventEmitter,
  TreeItem,
  ThemeIcon,
  MarkdownString,
  RelativePattern,
  Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { Active: -1, One: 1 },

  workspace: {
    workspaceFolders: [{ uri: Uri.file("/tmp") }],
    fs: {
      delete(uri, options) {
        calls.deletedFiles.push({ file: uri.fsPath, options });
        const injected = calls.deleteErrors.get(uri.fsPath);
        if (injected) return Promise.reject(new Error(injected));
        return fs.promises.rm(uri.fsPath, {
          recursive: Boolean(options?.recursive),
          force: false,
        });
      },
    },
    getConfiguration() {
      return { get: (key, def) => (key in config ? config[key] : def) };
    },
    createFileSystemWatcher(pattern) {
      const w = {
        pattern,
        handlers: { change: [], create: [], delete: [] },
        onDidChange(fn) { w.handlers.change.push(fn); return { dispose() {} }; },
        onDidCreate(fn) { w.handlers.create.push(fn); return { dispose() {} }; },
        onDidDelete(fn) { w.handlers.delete.push(fn); return { dispose() {} }; },
        dispose() {},
      };
      calls.watchers.push(w);
      return w;
    },
    onDidChangeConfiguration(fn) { calls.onConfig = fn; return { dispose() {} }; },
    onDidChangeWorkspaceFolders(fn) { calls.onWorkspaceFolders = fn; return { dispose() {} }; },
  },

  window: {
    registerTreeDataProvider(id, provider) {
      calls.treeProviders.set(id, provider);
      return { dispose() {} };
    },
    createWebviewPanel(viewType, title, column, options) {
      const panel = {
        viewType, title, options,
        visible: true,
        webview: {
          html: "",
          cspSource: "vscode-webview://mock",
          asWebviewUri: uri => ({ toString: () => `vscode-webview://mock${uri.fsPath}` }),
          postMessage(msg) { calls.messages.push(msg); return Promise.resolve(true); },
          onDidReceiveMessage(fn) { panel._onMessage = fn; return { dispose() {} }; },
        },
        reveal() { panel.revealed = true; },
        onDidDispose(fn) { panel._onDispose = fn; return { dispose() {} }; },
        dispose() { panel.disposed = true; if (panel._onDispose) panel._onDispose(); },
      };
      calls.panels.push(panel);
      return panel;
    },
    createTerminal(options) {
      const terminal = {
        options,
        shown: false,
        show() { terminal.shown = true; },
        dispose() {},
      };
      calls.terminals.push(terminal);
      return terminal;
    },
    showInputBox(options) {
      calls.inputBoxes.push(options);
      const value = calls.inputBoxResponses.length ? calls.inputBoxResponses.shift() : "";
      return Promise.resolve(value);
    },
    showQuickPick(items, options) {
      calls.quickPicks.push({ items, options });
      const response = calls.quickPickResponses.length ? calls.quickPickResponses.shift() : undefined;
      if (typeof response === "string") {
        return Promise.resolve(items.find(item => item.label === response));
      }
      return Promise.resolve(response);
    },
    showWarningMessage(m, ...args) {
      calls.executed.push(["warn", m]);
      calls.warningMessages.push({ message: m, args });
      const choices = args.filter(arg => typeof arg === "string");
      if (!choices.length) return Promise.resolve(undefined);
      const value = calls.warningResponses.length ? calls.warningResponses.shift() : undefined;
      return Promise.resolve(value);
    },
    showInformationMessage(m) { calls.executed.push(["info", m]); },
    showErrorMessage(m) { calls.executed.push(["error", m]); },
    showTextDocument(uri) { calls.executed.push(["open", uri.fsPath]); },
  },

  commands: {
    registerCommand(id, fn) {
      calls.registeredCommands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand(id, ...args) {
      calls.executed.push([id, ...args]);
      return Promise.resolve();
    },
  },
};

module.exports = { vscode, calls, config, workspaceState };
