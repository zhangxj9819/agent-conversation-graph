/** 分支筛选纯函数回归测试：只显示所选 tip，同时保留完整祖先链。 */
"use strict";

const assert = require("node:assert");
const { contract, filterBranch, layout } = require("../media/layout");

const turns = [
  { id: "root", parent: null, kind: "prompt", title: "根", ts: "2026-01-01T00:00:00Z" },
  { id: "hidden", parent: "root", kind: "command", title: "/model", ts: "2026-01-01T00:00:01Z" },
  { id: "left", parent: "hidden", kind: "prompt", title: "方案 A", ts: "2026-01-01T00:00:02Z" },
  { id: "left-tip", parent: "left", kind: "prompt", title: "完成 A", ts: "2026-01-01T00:00:03Z" },
  { id: "right", parent: "root", kind: "prompt", title: "方案 B", ts: "2026-01-01T00:00:04Z" },
  { id: "right-tip", parent: "right", kind: "prompt", title: "完成 B", ts: "2026-01-01T00:00:05Z" },
];

const visible = contract(turns, turn => turn.kind === "prompt");
const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push(["✓", name]); }
  catch (err) { checks.push(["✗", `${name} —— ${err.message}`]); }
};

check("完整图把两个叶子识别成可筛选分支", () => {
  const graph = layout(visible);
  assert.strictEqual(graph.refs.size, 2);
  assert.strictEqual(graph.refs.get("right-tip"), "HEAD");
  assert.strictEqual(graph.refs.get("left-tip"), "tip/1");
});

check("筛选 tip 时保留它到根节点的完整可见祖先链", () => {
  const filtered = filterBranch(visible, "left-tip");
  assert.deepStrictEqual(filtered.map(turn => turn.id), ["root", "left", "left-tip"]);
  assert.strictEqual(filtered[1].parent, "root", "隐藏命令收缩后的父链没有保留");
  assert.strictEqual(filtered[2].parent, "left");
});

check("清除筛选或 tip 失效时安全显示完整图", () => {
  assert.strictEqual(filterBranch(visible, ""), visible);
  assert.strictEqual(filterBranch(visible, "missing-tip"), visible);
});

for (const [mark, name] of checks) console.log(`  ${mark} ${name}`);
const failed = checks.filter(([mark]) => mark === "✗").length;
console.log(`\n${checks.length} 项分支筛选检查 · 失败 ${failed}`);
process.exit(failed ? 1 : 0);
