/**
 * 把一个 Claude Code 会话截至指定消息的主链复制成新的 session。
 *
 * Claude Code 2.1.231 已不再支持曾经可用的 --resume-session-at 参数；官方
 * --fork-session（以及交互式 /branch）只能从当前叶子分支。为了让图上的任意节点
 * 仍能精确分支，这里只读取原记录，并创建一份只包含目标祖先链的新 JSONL。
 * 原会话绝不改写。
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { lineageParentUuid } = require("./parser");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readJsonlStrict(file) {
  const raw = fs.readFileSync(file, "utf8");
  const records = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("记录不是对象");
      }
      records.push(value);
    } catch (err) {
      throw new Error(`会话第 ${index + 1} 行不是有效 JSON：${err.message}`);
    }
  }
  if (!records.length) throw new Error("会话记录为空");
  return records;
}

function ancestorUuids(records, targetUuid) {
  const byUuid = new Map();
  for (const rec of records) {
    if (typeof rec.uuid === "string" && !rec.isSidechain) byUuid.set(rec.uuid, rec);
  }
  if (!byUuid.has(targetUuid)) throw new Error("所选消息在原会话中不存在");

  const ancestors = new Set();
  let current = targetUuid;
  while (current) {
    if (ancestors.has(current)) throw new Error("会话父链存在循环");
    const rec = byUuid.get(current);
    if (!rec) throw new Error(`会话父链断裂：${current}`);
    ancestors.add(current);
    current = lineageParentUuid(rec);
  }
  return ancestors;
}

function latestOfType(records, type) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === type) return records[i];
  }
  return null;
}

function withSessionId(record, sessionId) {
  return { ...record, sessionId };
}

function promptText(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec.type !== "user" || rec.isSidechain || rec.isMeta) continue;
    const content = rec.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(block => block && block.type === "text")
      .map(block => block.text || "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function branchRecords(records, targetUuid, sessionId, name) {
  const ancestors = ancestorUuids(records, targetUuid);
  const messages = records
    .filter(rec => typeof rec.uuid === "string" && ancestors.has(rec.uuid) && !rec.isSidechain)
    .map(rec => withSessionId(rec, sessionId));

  if (!messages.length || messages.at(-1).uuid !== targetUuid) {
    throw new Error("无法按原始顺序截取到所选消息");
  }

  const metadata = [];
  const cleanName = typeof name === "string" ? name.trim() : "";
  const sourceTitle = latestOfType(records, "ai-title");
  const sourceCustomTitle = latestOfType(records, "custom-title");
  const sourceAgentName = latestOfType(records, "agent-name");

  if (cleanName) {
    metadata.push({ type: "custom-title", customTitle: cleanName, sessionId });
  } else if (sourceCustomTitle) {
    metadata.push(withSessionId(sourceCustomTitle, sessionId));
  }
  if (sourceTitle) metadata.push(withSessionId(sourceTitle, sessionId));
  if (cleanName) {
    metadata.push({ type: "agent-name", agentName: cleanName, sessionId });
  } else if (sourceAgentName) {
    metadata.push(withSessionId(sourceAgentName, sessionId));
  }

  for (const type of ["mode", "permission-mode"]) {
    const rec = latestOfType(records, type);
    if (rec) metadata.push(withSessionId(rec, sessionId));
  }

  // Checkpoint 快照没有 uuid，而是通过 messageId 归属于某条消息。只复制祖先链
  // 对应的快照，避免把所选轮次之后的文件状态带进新会话。
  const snapshots = records
    .filter(rec => rec.type === "file-history-snapshot" && ancestors.has(rec.messageId))
    .map(rec => ({ ...rec }));

  return [
    ...metadata,
    ...snapshots,
    ...messages,
    {
      type: "last-prompt",
      lastPrompt: promptText(messages),
      leafUuid: targetUuid,
      sessionId,
    },
  ];
}

/**
 * 新会话写在原文件旁边，Claude 才能按当前项目找到它。使用 wx 保证即使 UUID
 * 极端碰撞也不会覆盖任何已有历史。
 */
function createBranchSession(file, targetUuid, options = {}) {
  if (!UUID_RE.test(targetUuid)) throw new Error("所选消息 UUID 无效");
  const sourceFile = path.resolve(file);
  if (path.extname(sourceFile) !== ".jsonl") throw new Error("会话文件类型无效");

  const records = readJsonlStrict(sourceFile);
  const sessionId = options.sessionId || crypto.randomUUID();
  if (!UUID_RE.test(sessionId)) throw new Error("新会话 UUID 无效");

  const outputFile = path.join(path.dirname(sourceFile), `${sessionId}.jsonl`);
  const output = branchRecords(records, targetUuid, sessionId, options.name)
    .map(rec => JSON.stringify(rec))
    .join("\n") + "\n";
  fs.writeFileSync(outputFile, output, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { id: sessionId, file: outputFile };
}

module.exports = { createBranchSession, branchRecords, ancestorUuids };
