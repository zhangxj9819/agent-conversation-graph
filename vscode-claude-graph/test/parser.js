/**
 * Claude 会话解析与分支复制的定向回归测试。
 *
 *   node test/parser.js
 */
"use strict";

const assert = require("node:assert");
const { buildTurns } = require("../src/parser");
const { ancestorUuids, branchRecords } = require("../src/session-branch");
const { contract, layout } = require("../media/layout");

const ids = {
  prompt1: "11111111-1111-4111-8111-111111111111",
  answer1: "22222222-2222-4222-8222-222222222222",
  compactCommand: "aaaaaaaa-1111-4111-8111-111111111111",
  boundary: "33333333-3333-4333-8333-333333333333",
  summary: "44444444-4444-4444-8444-444444444444",
  answer2: "55555555-5555-4555-8555-555555555555",
  prompt2: "66666666-6666-4666-8666-666666666666",
  answer3: "77777777-7777-4777-8777-777777777777",
  otherPrompt: "88888888-8888-4888-8888-888888888888",
  otherAnswer: "99999999-9999-4999-8999-999999999999",
};

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = (uuid, parentUuid, type, timestamp) => ({
  uuid, parentUuid, type, timestamp, sessionId, cwd: "/tmp", version: "2.1.232",
});
const user = (uuid, parentUuid, timestamp, content, extra = {}) => ({
  ...base(uuid, parentUuid, "user", timestamp),
  message: { role: "user", content },
  ...extra,
});
const assistant = (uuid, parentUuid, timestamp, text) => ({
  ...base(uuid, parentUuid, "assistant", timestamp),
  message: {
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
  },
});

const compactRecords = [
  user(ids.prompt1, null, "2026-08-16T00:00:00.000Z", "压缩前的问题"),
  assistant(ids.answer1, ids.prompt1, "2026-08-16T00:00:01.000Z", "压缩前的回答"),
  // 真实记录会先写一条无标签的 /compact；boundary 与它共享同一个物理父节点。
  user(ids.compactCommand, ids.answer1, "2026-08-16T00:00:01.500Z", "/compact"),
  {
    ...base(ids.boundary, null, "system", "2026-08-16T00:00:02.000Z"),
    subtype: "compact_boundary",
    content: "Conversation compacted",
    logicalParentUuid: ids.answer1,
    compactMetadata: { trigger: "manual", preTokens: 200000 },
  },
  user(ids.summary, ids.boundary, "2026-08-16T00:00:03.000Z",
    "This session is being continued from a previous conversation that ran out of context.",
    { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  assistant(ids.answer2, ids.summary, "2026-08-16T00:00:04.000Z", "压缩后恢复上下文"),
  user(ids.prompt2, ids.answer2, "2026-08-16T00:00:05.000Z", "压缩后继续提问"),
  assistant(ids.answer3, ids.prompt2, "2026-08-16T00:00:06.000Z", "继续回答"),
];

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(["✓", name]);
  } catch (error) {
    checks.push(["✗", `${name} —— ${error.message}`]);
  }
}

check("纯文本 /compact 与压缩摘要合并为线性语义父链", () => {
  const turns = buildTurns(compactRecords, 2000, 20000);
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  assert.strictEqual(byId.get(ids.compactCommand).kind, "command");
  assert.strictEqual(byId.get(ids.summary).kind, "compact");
  assert.strictEqual(byId.get(ids.compactCommand).parent, ids.prompt1);
  assert.strictEqual(byId.get(ids.summary).parent, ids.compactCommand);
  assert.strictEqual(byId.get(ids.prompt2).parent, ids.summary);
  assert.deepStrictEqual(turns.filter(turn => !turn.parent).map(turn => turn.id), [ids.prompt1]);
});

check("压缩前后在默认视图中保持单泳道且不产生伪 tip", () => {
  const turns = buildTurns(compactRecords, 2000, 20000);
  const visible = turn => turn.kind === "prompt" || turn.kind === "compact";
  const contracted = contract(turns, visible);
  const summary = contracted.find(turn => turn.id === ids.summary);
  assert.strictEqual(summary.parent, ids.prompt1, "隐藏 /compact 后摘要没有接回主线");
  const view = layout(contracted);
  assert.deepStrictEqual(view.roots, [ids.prompt1]);
  assert.strictEqual(view.maxLane, 0);
  assert.strictEqual(view.forks.size, 0);
  assert.deepStrictEqual([...view.refs.values()], ["HEAD"]);

  const noisyView = layout(turns);
  assert.strictEqual(noisyView.maxLane, 0, "显示命令时不应出现 /compact 侧枝");
  assert.strictEqual(noisyView.forks.size, 0, "显示命令时不应出现 /compact 假分叉");
});

const recordsWithUnrelatedBranch = [
  ...compactRecords.slice(0, 2),
  user(ids.otherPrompt, ids.answer1, "2026-08-16T00:00:01.100Z", "真正的另一条分支"),
  assistant(ids.otherAnswer, ids.otherPrompt, "2026-08-16T00:00:01.200Z", "另一条回答"),
  ...compactRecords.slice(2),
];

check("压缩后节点的祖先链包含压缩前历史且排除真实旁支", () => {
  const ancestors = ancestorUuids(recordsWithUnrelatedBranch, ids.answer3);
  for (const id of [
    ids.prompt1, ids.answer1, ids.boundary, ids.summary,
    ids.answer2, ids.prompt2, ids.answer3,
  ]) assert.ok(ancestors.has(id), `祖先链缺少 ${id}`);
  assert.ok(!ancestors.has(ids.compactCommand), "/compact 控制命令不应进入模型历史祖先链");
  assert.ok(!ancestors.has(ids.otherPrompt));
  assert.ok(!ancestors.has(ids.otherAnswer));
});

check("从压缩后轮次创建分支会完整复制逻辑祖先链", () => {
  const newSession = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const copied = branchRecords(recordsWithUnrelatedBranch, ids.answer3, newSession, "compact-fix");
  assert.deepStrictEqual(copied.filter(record => record.uuid).map(record => record.uuid), [
    ids.prompt1, ids.answer1, ids.boundary, ids.summary,
    ids.answer2, ids.prompt2, ids.answer3,
  ]);
  const boundary = copied.find(record => record.uuid === ids.boundary);
  assert.strictEqual(boundary.logicalParentUuid, ids.answer1);
  assert.ok(copied.filter(record => record.uuid)
    .every(record => record.sessionId === newSession));
  assert.strictEqual(copied.at(-1).leafUuid, ids.answer3);
});

for (const [mark, name] of checks) console.log(`  ${mark} ${name}`);
const failed = checks.filter(([mark]) => mark === "✗").length;
console.log(`\n${checks.length} 项解析检查 · 失败 ${failed}`);
process.exitCode = failed ? 1 : 0;
