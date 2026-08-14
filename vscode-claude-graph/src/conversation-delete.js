/**
 * 解析一次“删除对话”应当处理的本地文件。
 *
 * 这里不执行删除；只接受解析器刚刚发现的 session，并把目标严格限制在对应提供方的
 * JSONL 根目录。真正删除由扩展宿主通过 vscode.workspace.fs + useTrash 完成。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function isInside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return Boolean(relative) && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function collectCodexMembers(conversation, allSessions) {
  const members = new Map();
  const relatedIds = new Set();
  for (const session of conversation.sessions) {
    members.set(path.resolve(session.file), session);
    if (typeof session.id === "string") relatedIds.add(session.id);
  }

  // 子 agent 不在侧栏显示，但仍属于被删除的对话。递归纳入它们，避免留下隐蔽历史。
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of allSessions) {
      if (session.interactive !== false || typeof session.file !== "string") continue;
      const file = path.resolve(session.file);
      if (members.has(file)) continue;
      if (!relatedIds.has(session.parentThreadId) && !relatedIds.has(session.sessionId)) continue;
      members.set(file, session);
      if (typeof session.id === "string") relatedIds.add(session.id);
      changed = true;
    }
  }
  return [...members.values()];
}

function collectConversationFiles(conversation, options = {}) {
  if (!conversation || !Array.isArray(conversation.sessions) || !conversation.sessions.length) {
    throw new Error("对话没有可验证的 session 文件。");
  }
  const provider = conversation.provider === "codex" ? "codex" : "claude";
  const root = provider === "codex" ? options.codexRoot : options.claudeRoot;
  if (typeof root !== "string" || !root) throw new Error("对话数据目录无效。");

  const sessions = provider === "codex"
    ? collectCodexMembers(conversation, options.codexSessions || [])
    : conversation.sessions;
  const files = new Set();
  for (const session of sessions) {
    if (typeof session?.file !== "string" || !session.file) {
      throw new Error("对话包含没有文件路径的 session。");
    }
    const file = path.resolve(session.file);
    if (!isInside(root, file) || path.extname(file).toLowerCase() !== ".jsonl") {
      throw new Error(`拒绝删除数据目录之外的文件：${file}`);
    }
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    // 不跟随符号链接，防止一个伪装成会话的链接扩大删除范围。
    if (!stat.isFile()) throw new Error(`拒绝删除非普通会话文件：${file}`);
    files.add(file);
  }
  return [...files].sort();
}

module.exports = { collectConversationFiles, isInside };
