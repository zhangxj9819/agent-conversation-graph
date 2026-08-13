/**
 * 把 Claude Code 的 .jsonl 会话记录聚合成「轮次树」。
 *
 * 原始记录粒度太细：助手一次回复会被拆成若干条（thinking / text / 每个 tool_use
 * 各一条），并行工具调用还会让它们互为父子 —— 直接照搬 uuid 树，图上全是并行工具
 * 造成的伪分支。所以以「真实用户提问」为锚点聚合：一次提问 + 其后的全部助手动作
 * = 一个 commit。这样剩下的分叉才是真实的回退改写。
 *
 * 与 claude_graph.py 的实现保持一致，改动请同步。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CONFIG_DIR, "projects");

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_PROMPT = 20000;

// CLI 注入的包装标签，不是用户真的敲进去的内容
const TAG_RE = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|task-notification|task-id|tool-use-id|user-prompt-submit-hook)>([\s\S]*?)<\/\1>/g;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const INTERRUPT_RE = /^\[Request interrupted by user/;

const stripTags = s => s.replace(TAG_RE, (_, __, inner) => inner);

function readJsonl(file) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 会话正在写入时最后一行可能是残缺的
    }
  }
  return out;
}

function msgBlocks(rec) {
  const c = rec && rec.message ? rec.message.content : undefined;
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (Array.isArray(c)) return c.filter(b => b && typeof b === "object");
  return [];
}

function plainText(blocks) {
  return blocks
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("\n")
    .replace(ANSI_RE, "")
    .trim();
}

/** 返回 [kind, title]。kind 决定这一轮在图上的样子和默认是否可见。 */
function classifyPrompt(text, rec) {
  const s = text.trim();

  if (INTERRUPT_RE.test(s)) return ["system-event", "⎋ 用户打断"];

  if (rec.isCompactSummary ||
      s.startsWith("This session is being continued from a previous conversation"))
    return ["compact", "／compact 上下文压缩续接"];

  const cmd = s.match(/<command-name>\s*([\s\S]*?)\s*<\/command-name>/);
  if (cmd) {
    const args = s.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);
    const name = cmd[1].trim();
    return ["command", `${name} ${args ? args[1].trim() : ""}`.trim() || name];
  }

  if (s.startsWith("<task-notification>")) {
    const tid = s.match(/<task-id>([\s\S]*?)<\/task-id>/);
    return ["system-event", `子任务完成 ${tid ? tid[1] : ""}`.trim()];
  }

  if (s.startsWith("<local-command-stdout>")) {
    const body = stripTags(s).trim();
    return ["system-event", cut(body.split("\n")[0] || "", 120)];
  }

  const clean = stripTags(s).trim().replace(/\s+/g, " ");
  return ["prompt", clean ? cut(clean, 160) : "(空)"];
}

/** 一条记录是不是「一轮对话的起点」—— 即真实的用户输入。 */
function isAnchor(rec) {
  if (rec.type !== "user" || rec.isSidechain || rec.isMeta) return false;
  const blocks = msgBlocks(rec);
  if (!blocks.length) return false;
  if (blocks.some(b => b.type === "tool_result")) return false;  // 工具返回值不是用户说的话
  return Boolean(plainText(blocks));
}

/**
 * 按 Unicode 码点截断，而不是 UTF-16 码元。
 * String.prototype.slice 数的是码元，文本里只要有一个星平面字符（emoji 等）就会
 * 比 Python 的 s[:n] 早切一位 —— 两个解析器的输出必须逐字节一致，这里不能图省事。
 */
function cut(s, n) {
  const str = s == null ? "" : String(s);
  if (str.length <= n) return str;          // 码元数 ≥ 码点数，因此这是安全的快路径
  const cps = [...str];
  return cps.length <= n ? str : cps.slice(0, n).join("");
}

function truncate(s, limit) {
  const str = s == null ? "" : String(s);
  const text = cut(str, limit);
  return { text, truncated: text.length !== str.length };
}

function summarizeTool(block, maxChars) {
  const input = block.input || {};
  let head = "";
  // 每种工具挑一个最能说明「做了什么」的字段做单行摘要
  for (const key of ["command", "file_path", "pattern", "path", "query", "prompt", "url", "skill"]) {
    if (typeof input[key] === "string" && input[key].trim()) {
      head = input[key].trim().replace(/\s+/g, " ");
      break;
    }
  }
  let dump;
  try {
    dump = JSON.stringify(input, null, 2);
  } catch {
    dump = String(input);
  }
  const detail = truncate(dump, maxChars);
  return {
    type: "tool",
    name: block.name || "tool",
    summary: cut(head, 200),
    detail: detail.text,
    truncated: detail.truncated,
  };
}

function buildTurns(records, maxChars, maxPrompt) {
  const byUuid = new Map();
  for (const rec of records) {
    if (rec.uuid && !rec.isSidechain) byUuid.set(rec.uuid, rec);
  }

  // 注意要包含 system / attachment 等类型：parentUuid 链会穿过它们，
  // 漏掉就会断链，一堆轮次会假装成根节点。
  const children = new Map();
  for (const [uuid, rec] of byUuid) {
    const p = rec.parentUuid ?? null;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(uuid);
  }

  const anchors = new Set();
  for (const [uuid, rec] of byUuid) if (isAnchor(rec)) anchors.add(uuid);

  const nearestAnchorAbove = uuid => {
    let p = byUuid.get(uuid).parentUuid;
    const seen = new Set();
    while (p && byUuid.has(p) && !anchors.has(p) && !seen.has(p)) {
      seen.add(p);
      p = byUuid.get(p).parentUuid;
    }
    return anchors.has(p) ? p : null;
  };

  // 子 agent（sidechain）按发起它的 tool_use 归属到某一轮
  const sidechainByTool = new Map();
  for (const rec of records) {
    if (rec.isSidechain && rec.sourceToolAssistantUUID) {
      const k = rec.sourceToolAssistantUUID;
      sidechainByTool.set(k, (sidechainByTool.get(k) || 0) + 1);
    }
  }

  const turns = [];
  for (const anchor of anchors) {
    const rec = byUuid.get(anchor);
    const blocks = msgBlocks(rec);
    const raw = plainText(blocks);
    const [kind, title] = classifyPrompt(raw, rec);
    const body = truncate(stripTags(raw).trim(), maxPrompt);

    // 这一轮的助手动作：从 anchor 往下走，遇到下一个 anchor 停
    const stepUuids = [];
    const stack = [...(children.get(anchor) || [])];
    while (stack.length) {
      const u = stack.pop();
      if (anchors.has(u)) continue;
      stepUuids.push(u);
      stack.push(...(children.get(u) || []));
    }
    stepUuids.sort((a, b) =>
      (byUuid.get(a).timestamp || "").localeCompare(byUuid.get(b).timestamp || "") ||
      a.localeCompare(b));

    // Claude Code 的 --resume-session-at 需要原始消息 UUID。轮次节点本身是
    // 用户提问；若本轮已有助手工作，则恢复到最后一条对话记录，保留整轮上下文。
    const resumable = [anchor, ...stepUuids.filter(u =>
      ["user", "assistant"].includes(byUuid.get(u).type))];
    const resumeAt = resumable[resumable.length - 1];

    const steps = [];
    const tools = [];
    const models = new Set();
    let outputTokens = 0;
    let subagents = 0;

    for (const u of stepUuids) {
      const r = byUuid.get(u);
      if (r.type === "assistant") {
        const m = r.message || {};
        if (m.model) models.add(m.model);
        outputTokens += (m.usage && m.usage.output_tokens) || 0;
        for (const b of msgBlocks(r)) {
          if (b.type === "text") {
            const t = truncate(b.text || "", maxChars);
            if (t.text.trim()) steps.push({ type: "text", detail: t.text, truncated: t.truncated });
          } else if (b.type === "thinking") {
            const t = truncate(b.thinking || "", maxChars);
            if (t.text.trim()) steps.push({ type: "thinking", detail: t.text, truncated: t.truncated });
          } else if (b.type === "tool_use") {
            subagents += sidechainByTool.get(u) || 0;
            const st = summarizeTool(b, maxChars);
            steps.push(st);
            tools.push(st.name);
          }
        }
      } else if (r.type === "user") {
        for (const b of msgBlocks(r)) {
          if (b.type !== "tool_result") continue;
          let c = b.content;
          if (Array.isArray(c)) c = c.filter(x => x && typeof x === "object").map(x => x.text || "").join("\n");
          const t = truncate(c == null ? "" : String(c), maxChars);
          steps.push({ type: "result", detail: t.text, truncated: t.truncated, isError: Boolean(b.is_error) });
        }
      }
    }

    const toolCounts = {};
    for (const name of tools.slice().sort()) toolCounts[name] = (toolCounts[name] || 0) + 1;

    turns.push({
      id: anchor,
      short: anchor.slice(0, 7),
      parent: nearestAnchorAbove(anchor),
      resumeAt,
      ts: rec.timestamp || "",
      kind,
      title,
      body: body.text,
      bodyTruncated: body.truncated,
      gitBranch: rec.gitBranch || "",
      cwd: rec.cwd || "",
      version: rec.version || "",
      models: [...models].sort(),
      steps,
      toolCounts,
      outputTokens,
      subagents,
    });
  }

  turns.sort((a, b) => (a.ts || "").localeCompare(b.ts || "") || a.id.localeCompare(b.id));
  return turns;
}

function sessionMeta(file, records, turns) {
  let title = "";
  let cwd = "";
  for (const rec of records) {
    if (rec.type === "ai-title" && rec.slug) title = rec.slug;
    if (!cwd && rec.cwd) cwd = rec.cwd;
  }
  if (!title && turns.length) {
    title = cut((turns.find(t => t.kind === "prompt") || turns[0]).title, 60);
  }
  const stamps = turns.map(t => t.ts).filter(Boolean).sort();
  const id = path.basename(file, ".jsonl");
  return {
    id,
    short: id.slice(0, 8),
    file,
    title: title || id.slice(0, 8),
    cwd,
    start: stamps[0] || "",
    end: stamps[stamps.length - 1] || "",
    turnCount: turns.length,
  };
}

/** 解析单个会话文件。调用方负责按 mtime 缓存。 */
function parseSession(file, opts = {}) {
  const records = readJsonl(file);
  if (!records.length) return null;
  const turns = buildTurns(records,
    opts.maxChars ?? DEFAULT_MAX_CHARS,
    opts.maxPrompt ?? DEFAULT_MAX_PROMPT);
  if (!turns.length) return null;
  const meta = sessionMeta(file, records, turns);
  meta.turns = turns;
  return meta;
}

/** 只列出会话文件，不解析内容 —— 树视图要快，正文按需再读。 */
function listSessionFiles(projectsDir = PROJECTS_DIR) {
  const projects = [];
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return projects;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const sessions = [];
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.size) continue;
      sessions.push({ id: path.basename(f, ".jsonl"), file: full, mtimeMs: st.mtimeMs, size: st.size });
    }
    if (sessions.length) {
      sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
      projects.push({ dir: d.name, path: dir, sessions });
    }
  }
  projects.sort((a, b) => b.sessions[0].mtimeMs - a.sessions[0].mtimeMs);
  return projects;
}

module.exports = {
  PROJECTS_DIR,
  parseSession,
  listSessionFiles,
  readJsonl,
  buildTurns,
};
