/**
 * 把 Codex rollout JSONL 聚合成与 Claude parser 相同的「轮次树」数据结构。
 *
 * Codex 的一个 thread 是线性历史；thread/fork 会把所选轮次以前的 turn 原样复制到
 * 新 rollout。合并同一 fork 谱系并按 turn_id 去重后，线性历史自然还原成分支树。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_DIR, "sessions");
const SESSION_INDEX = path.join(CODEX_DIR, "session_index.jsonl");

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_PROMPT = 20000;

const cut = (value, n) => {
  const text = value == null ? "" : String(value);
  if (text.length <= n) return text;
  const points = [...text];
  return points.length <= n ? text : points.slice(0, n).join("");
};

function truncate(value, limit) {
  const original = value == null ? "" : String(value);
  const text = cut(original, limit);
  return { text, truncated: text.length !== original.length };
}

function readJsonl(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { return []; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { /* rollout 正在写入时末行可能不完整 */ }
  }
  return rows;
}

/** 只读第一条 JSON，避免侧栏刷新时完整加载每个 rollout。 */
function readFirstJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending = "";
    // session_meta 可能内嵌较长的 instructions；给第一行留 4 MiB 上限。
    while (pending.length < 4 * 1024 * 1024) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      pending += decoder.write(chunk.subarray(0, count));
      const newline = pending.indexOf("\n");
      if (newline !== -1) {
        const line = pending.slice(0, newline).trim();
        return line ? JSON.parse(line) : null;
      }
    }
    pending += decoder.end();
    const line = pending.trim();
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function walkJsonl(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

function readThreadNames(indexFile = SESSION_INDEX) {
  const names = new Map();
  for (const row of readJsonl(indexFile)) {
    if (typeof row.id === "string" && typeof row.thread_name === "string" && row.thread_name.trim()) {
      names.set(row.id, row.thread_name.trim());
    }
  }
  return names;
}

function isInteractive(meta) {
  const source = meta.source;
  if (meta.thread_source === "subagent" || meta.thread_source === "subAgent") return false;
  if (source && typeof source === "object" && source.subagent) return false;
  // 新版明确标 user；旧版没有 thread_source 时，cli/vscode 仍是交互会话。
  if (meta.thread_source === "user") return true;
  if (["cli", "vscode"].includes(source)) return true;
  return /codex_(tui|vscode|work_desktop)/.test(meta.originator || "") && !meta.parent_thread_id;
}

/** 只列 metadata；不解析会话正文。 */
function listCodexSessionFiles(sessionsDir = SESSIONS_DIR, indexFile = SESSION_INDEX) {
  const files = [];
  walkJsonl(sessionsDir, files);
  const names = readThreadNames(indexFile);
  const sessions = [];
  for (const file of files) {
    const row = readFirstJson(file);
    if (row?.type !== "session_meta" || !row.payload || typeof row.payload.id !== "string") continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.size) continue;
    const meta = row.payload;
    sessions.push({
      id: meta.id,
      sessionId: typeof meta.session_id === "string" ? meta.session_id : meta.id,
      forkedFromId: typeof meta.forked_from_id === "string" ? meta.forked_from_id : null,
      parentThreadId: typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : null,
      cwd: typeof meta.cwd === "string" ? meta.cwd : "",
      timestamp: meta.timestamp || row.timestamp || "",
      source: meta.source,
      threadSource: meta.thread_source || "",
      originator: meta.originator || "",
      interactive: isInteractive(meta),
      name: names.get(meta.id) || "",
      file, mtimeMs: stat.mtimeMs, size: stat.size,
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  return sessions;
}

function lineageRoot(session, byId) {
  let current = session;
  let root = current.id;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = current.forkedFromId ||
      (current.sessionId && current.sessionId !== current.id ? current.sessionId : null);
    if (!parentId) break;
    root = parentId;
    current = byId.get(parentId);
  }
  return root;
}

/** 当前工作区里的交互 thread 按 fork 谱系合并；子 agent 永不进入侧栏。 */
function groupCodexSessions(sessions, workspacePath) {
  const workspace = workspacePath ? path.resolve(workspacePath) : null;
  if (!workspace) return [];
  const byId = new Map(sessions.map(session => [session.id, session]));
  const groups = new Map();
  for (const session of sessions) {
    if (!session.interactive || !session.cwd) continue;
    let cwd;
    try { cwd = path.resolve(session.cwd); } catch { continue; }
    if (cwd !== workspace) continue;
    const rootId = lineageRoot(session, byId);
    let group = groups.get(rootId);
    if (!group) {
      group = {
        provider: "codex", id: rootId, rootId, sessions: [],
        mtimeMs: 0, size: 0,
      };
      groups.set(rootId, group);
    }
    group.sessions.push(session);
    group.mtimeMs = Math.max(group.mtimeMs, session.mtimeMs || 0);
    group.size += session.size || 0;
  }
  const out = [...groups.values()];
  for (const group of out) {
    group.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    group.file = group.sessions[0].file;
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  return out;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(item => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    return item.text ?? item.value ?? item.input_text ?? item.output_text ?? "";
  }).filter(Boolean).join("\n").trim();
}

function jsonDetail(value) {
  try { return JSON.stringify(value ?? {}, null, 2); }
  catch { return String(value ?? ""); }
}

function isoTime(value, fallback = "") {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  if (typeof value === "string" && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return fallback || "";
}

function makeBuilder(id, row) {
  return {
    id,
    ts: isoTime(row?.payload?.started_at, isoTime(row?.timestamp)),
    cwd: "", models: new Set(), normalized: [], fallback: [],
    normalizedBody: "", fallbackBody: "", outputTokens: 0,
    complete: false, compact: false, contextSeen: false,
    normalizedSeen: new Set(), subagents: 0,
  };
}

function pushStep(target, type, detail, maxChars, extra = {}) {
  const value = detail == null ? "" : String(detail);
  if (!value.trim()) return;
  const part = truncate(value, maxChars);
  target.push({ type, detail: part.text, truncated: part.truncated, ...extra });
}

function addNormalizedItem(builder, item, maxChars) {
  if (!item || typeof item !== "object") return;
  const type = String(item.type || "").toLowerCase();
  const dedupe = `${type}:${item.id || jsonDetail(item).slice(0, 120)}`;
  if (builder.normalizedSeen.has(dedupe)) return;
  builder.normalizedSeen.add(dedupe);

  if (type === "usermessage") {
    builder.normalizedBody = contentText(item.content) || builder.normalizedBody;
  } else if (type === "agentmessage") {
    pushStep(builder.normalized, "text", contentText(item.content) || item.text, maxChars);
  } else if (type === "reasoning") {
    const summary = item.summary_text ?? item.summary ?? item.raw_content ?? item.content;
    pushStep(builder.normalized, "thinking",
      Array.isArray(summary) ? summary.join("\n") : summary, maxChars);
  } else if (type === "commandexecution") {
    const command = typeof item.command === "string" ? item.command : jsonDetail(item.command);
    pushStep(builder.normalized, "tool", command, maxChars, {
      name: "shell", summary: cut(command.replace(/\s+/g, " "), 200),
    });
    const output = item.aggregated_output ?? item.formatted_output ??
      [item.stdout, item.stderr].filter(Boolean).join("\n");
    pushStep(builder.normalized, "result", output, maxChars,
      { isError: item.status === "failed" || Number(item.exit_code) > 0 });
  } else if (type === "filechange") {
    pushStep(builder.normalized, "tool", jsonDetail(item.changes), maxChars,
      { name: "fileChange", summary: `${item.changes?.length || 0} 个文件变更` });
  } else if (type === "mcptoolcall" || type === "dynamictoolcall") {
    const name = item.tool || "tool";
    const namespace = item.server || item.namespace;
    pushStep(builder.normalized, "tool", jsonDetail(item.arguments), maxChars, {
      name: namespace ? `${namespace}/${name}` : name,
      summary: cut(jsonDetail(item.arguments).replace(/\s+/g, " "), 200),
    });
    pushStep(builder.normalized, "result", jsonDetail(item.result ?? item.content_items), maxChars,
      { isError: Boolean(item.error) || item.success === false });
  } else if (type === "collabagenttoolcall" || type === "subagentactivity") {
    builder.subagents++;
    pushStep(builder.normalized, "tool", item.prompt || jsonDetail(item), maxChars,
      { name: "subagent", summary: item.tool || item.kind || "子 agent" });
  } else if (type === "websearch") {
    pushStep(builder.normalized, "tool", jsonDetail(item), maxChars,
      { name: "webSearch", summary: item.query || item.action || "网页搜索" });
  } else if (type === "contextcompaction") {
    builder.compact = true;
    pushStep(builder.normalized, "text", "Codex 压缩了之前的上下文。", maxChars);
  }
}

function addFallbackResponse(builder, payload, maxChars) {
  const type = String(payload?.type || "").toLowerCase();
  if (type === "message") {
    const text = contentText(payload.content);
    if (payload.role === "user") builder.fallbackBody = text || builder.fallbackBody;
    else if (payload.role === "assistant") pushStep(builder.fallback, "text", text, maxChars);
  } else if (type === "reasoning") {
    const summary = payload.summary ?? payload.content;
    pushStep(builder.fallback, "thinking",
      Array.isArray(summary) ? summary.map(x => x?.text ?? x).join("\n") : summary, maxChars);
  } else if (["custom_tool_call", "function_call", "local_shell_call"].includes(type)) {
    const name = payload.name || (type === "local_shell_call" ? "shell" : "tool");
    const input = payload.input ?? payload.arguments ?? payload.action ?? "";
    const detail = typeof input === "string" ? input : jsonDetail(input);
    pushStep(builder.fallback, "tool", detail, maxChars,
      { name, summary: cut(detail.replace(/\s+/g, " "), 200) });
  } else if (["custom_tool_call_output", "function_call_output", "local_shell_call_output"].includes(type)) {
    const output = payload.output ?? payload.content ?? "";
    pushStep(builder.fallback, "result",
      typeof output === "string" ? output : jsonDetail(output), maxChars);
  }
}

function finishBuilder(builder, maxPrompt) {
  const bodyRaw = builder.normalizedBody || builder.fallbackBody || "";
  const body = truncate(bodyRaw.trim(), maxPrompt);
  const clean = body.text.replace(/\s+/g, " ").trim();
  const kind = builder.compact && !clean ? "compact" : (clean ? "prompt" : "system-event");
  const title = clean ? cut(clean, 160) :
    (builder.compact ? "／compact 上下文压缩" : `Codex 轮次 ${builder.id.slice(0, 8)}`);
  const steps = builder.normalized.length ? builder.normalized : builder.fallback;
  const toolCounts = {};
  for (const step of steps) {
    if (step.type === "tool") toolCounts[step.name] = (toolCounts[step.name] || 0) + 1;
  }
  return {
    id: builder.id,
    short: builder.id.slice(0, 8),
    parent: null,
    resumeAt: builder.id,
    ts: builder.ts,
    kind, title,
    body: body.text,
    bodyTruncated: body.truncated,
    steps,
    tools: Object.keys(toolCounts),
    toolCounts,
    models: [...builder.models],
    outputTokens: builder.outputTokens,
    subagents: builder.subagents,
    cwd: builder.cwd,
    gitBranch: "",
    complete: builder.complete,
    provider: "codex",
  };
}

function parseCodexSession(file, opts = {}) {
  const records = readJsonl(file);
  const metaRow = records.find(row => row?.type === "session_meta");
  const meta = metaRow?.payload;
  if (!meta || typeof meta.id !== "string") return null;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxPrompt = opts.maxPrompt ?? DEFAULT_MAX_PROMPT;
  const turns = [];
  let current = null;

  const ensure = (id, row) => {
    if (!id) return current;
    if (current && current.id !== id) {
      turns.push(finishBuilder(current, maxPrompt));
      current = null;
    }
    if (!current) current = makeBuilder(id, row);
    return current;
  };
  const flush = () => {
    if (current) turns.push(finishBuilder(current, maxPrompt));
    current = null;
  };

  for (const row of records) {
    const payload = row?.payload || {};
    if (row.type === "event_msg" && payload.type === "task_started") {
      ensure(payload.turn_id, row);
      continue;
    }
    if (row.type === "turn_context") {
      const turn = ensure(payload.turn_id, row);
      if (!turn) continue;
      turn.contextSeen = true;
      turn.cwd = payload.cwd || turn.cwd || meta.cwd || "";
      if (payload.model) turn.models.add(payload.model);
      if (!turn.ts) turn.ts = isoTime(row.timestamp);
      continue;
    }
    if (!current) continue;

    if (row.type === "event_msg" && payload.type === "item_completed") {
      ensure(payload.turn_id || current.id, row);
      addNormalizedItem(current, payload.item, maxChars);
    } else if (row.type === "event_msg" && payload.type === "user_message") {
      current.fallbackBody = payload.message || current.fallbackBody;
    } else if (row.type === "response_item") {
      // app-server 创建的历史 fork 会保留 task_started/response_item，
      // 但可能不再写 turn_context；只要已经进入当前 turn，就仍应读取消息。
      addFallbackResponse(current, payload, maxChars);
    } else if (row.type === "event_msg" && payload.type === "token_count") {
      current.outputTokens += Number(payload.info?.last_token_usage?.output_tokens || 0);
    } else if (row.type === "event_msg" &&
               ["task_complete", "task_completed"].includes(payload.type)) {
      if (!payload.turn_id || payload.turn_id === current.id) current.complete = true;
    }
  }
  flush();
  if (!turns.length) return null;
  return {
    id: meta.id,
    sessionId: meta.session_id || meta.id,
    forkedFromId: meta.forked_from_id || null,
    cwd: meta.cwd || turns[0].cwd || "",
    timestamp: meta.timestamp || metaRow.timestamp || "",
    turns,
  };
}

/** 合并同一 Codex fork 谱系，重复祖先 turn_id 只保留一份。 */
function parseCodexConversation(sessionEntries, opts = {}) {
  const sessions = sessionEntries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!sessions.length) return null;
  const parsed = sessions.map(entry => ({ entry, data: parseCodexSession(entry.file, opts) }))
    .filter(item => item.data?.turns?.length);
  if (!parsed.length) return null;

  const byId = new Map();
  const nonNullParent = new Map();
  const richness = turn => (turn.body || "").length +
    (turn.steps || []).reduce((sum, step) => sum + (step.detail || "").length, 0) +
    (turn.kind === "prompt" ? 1000 : 0);
  for (const { entry, data } of parsed) {
    let previous = null;
    for (const raw of data.turns) {
      const turn = { ...raw, parent: previous, sourceFile: entry.file, sourceThreadId: entry.id };
      if (previous) nonNullParent.set(turn.id, previous);
      if (!byId.has(turn.id)) {
        byId.set(turn.id, turn);
      } else {
        const existing = byId.get(turn.id);
        // 新 fork 可能只持久化精简祖先事件。展示内容和分支来源都取更完整副本，
        // 否则再次从该节点 fork 会把已经精简掉的用户消息也一并丢失。
        if (richness(turn) > richness(existing)) {
          byId.set(turn.id, { ...turn, parent: existing.parent || turn.parent });
        }
      }
      previous = turn.id;
    }
  }
  for (const [id, parent] of nonNullParent) {
    if (byId.has(id)) byId.get(id).parent = parent;
  }
  const turns = [...byId.values()].sort((a, b) =>
    (a.ts || "").localeCompare(b.ts || "") || a.id.localeCompare(b.id));
  if (!turns.length) return null;

  const stamps = turns.map(turn => turn.ts).filter(Boolean).sort();
  const rootId = opts.rootId || sessions[0].rootId || sessions[0].sessionId || sessions[0].id;
  const named = sessions.find(session => session.id === rootId && session.name)?.name ||
    sessions.slice().reverse().find(session => session.name)?.name;
  const firstPrompt = turns.find(turn => turn.kind === "prompt");
  return {
    provider: "codex",
    providerLabel: "Codex",
    id: rootId,
    short: rootId.slice(0, 8),
    file: sessions[sessions.length - 1].file,
    files: sessions.map(session => session.file),
    title: named || firstPrompt?.title || `Codex ${rootId.slice(0, 8)}`,
    cwd: parsed[0].data.cwd,
    start: stamps[0] || parsed[0].data.timestamp || "",
    end: stamps[stamps.length - 1] || parsed[0].data.timestamp || "",
    sessionCount: sessions.length,
    turnCount: turns.length,
    turns,
  };
}

module.exports = {
  CODEX_DIR,
  SESSIONS_DIR,
  SESSION_INDEX,
  readJsonl,
  readFirstJson,
  listCodexSessionFiles,
  groupCodexSessions,
  parseCodexSession,
  parseCodexConversation,
};
