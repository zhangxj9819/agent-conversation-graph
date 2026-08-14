"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectConversationFiles, isInside } = require("../src/conversation-delete");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-delete-test-"));
const claudeRoot = path.join(root, "claude", "projects");
const codexRoot = path.join(root, "codex", "sessions");
fs.mkdirSync(claudeRoot, { recursive: true });
fs.mkdirSync(codexRoot, { recursive: true });

const makeFile = file => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n", "utf8");
  return file;
};
const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push(["✓", name]); }
  catch (err) { checks.push(["✗", `${name} —— ${err.message}`]); }
};

try {
  const claudeA = makeFile(path.join(claudeRoot, "project", "a.jsonl"));
  const claudeB = makeFile(path.join(claudeRoot, "project", "b.jsonl"));
  check("Claude 删除目标包含同一对话的全部 session", () => {
    const files = collectConversationFiles({
      provider: "claude",
      sessions: [{ file: claudeA }, { file: claudeB }, { file: claudeA }],
    }, { claudeRoot, codexRoot });
    assert.deepStrictEqual(files, [claudeA, claudeB].sort());
  });

  const outside = makeFile(path.join(root, "outside.jsonl"));
  check("拒绝删除提供方数据目录以外的路径", () => {
    assert.throws(() => collectConversationFiles({
      provider: "claude", sessions: [{ file: outside }],
    }, { claudeRoot, codexRoot }), /数据目录之外/);
    assert.strictEqual(isInside(claudeRoot, outside), false);
  });

  const rootThread = makeFile(path.join(codexRoot, "root.jsonl"));
  const forkThread = makeFile(path.join(codexRoot, "fork.jsonl"));
  const childAgent = makeFile(path.join(codexRoot, "child.jsonl"));
  const nestedAgent = makeFile(path.join(codexRoot, "nested.jsonl"));
  const unrelated = makeFile(path.join(codexRoot, "unrelated.jsonl"));
  const codexSessions = [
    { id: "root", sessionId: "root", file: rootThread, interactive: true },
    { id: "fork", sessionId: "root", file: forkThread, interactive: true },
    { id: "child", sessionId: "root", parentThreadId: "root",
      file: childAgent, interactive: false },
    { id: "nested", sessionId: "child", parentThreadId: "child",
      file: nestedAgent, interactive: false },
    { id: "other", sessionId: "other", file: unrelated, interactive: true },
  ];
  check("Codex 删除目标递归包含子 agent，但不包含其他对话", () => {
    const files = collectConversationFiles({
      provider: "codex", sessions: codexSessions.slice(0, 2),
    }, { claudeRoot, codexRoot, codexSessions });
    assert.deepStrictEqual(files,
      [rootThread, forkThread, childAgent, nestedAgent].sort());
    assert.ok(!files.includes(unrelated));
  });

  check("已经消失的会话文件会被安全忽略", () => {
    const missing = path.join(claudeRoot, "project", "missing.jsonl");
    assert.deepStrictEqual(collectConversationFiles({
      provider: "claude", sessions: [{ file: missing }],
    }, { claudeRoot, codexRoot }), []);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

for (const [mark, name] of checks) console.log(`  ${mark} ${name}`);
const failed = checks.filter(([mark]) => mark === "✗").length;
console.log(`\n${checks.length} 项检查 · 失败 ${failed}`);
process.exit(failed ? 1 : 0);
