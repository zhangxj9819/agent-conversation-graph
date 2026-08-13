/**
 * 用真实对话数据跑 layout.js 的不变量测试。
 *
 *   node test_layout.mjs [claude-graph.html]
 *
 * 数据来源是生成好的单文件 HTML 里内嵌的 DATA —— 省得再实现一遍 JSONL 解析。
 * 先跑 `python3 claude_graph.py --all` 生成它。
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const { contract, layout } = createRequire(import.meta.url)("./layout.js");

const file = process.argv[2] || "claude-graph.html";
if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}，先跑：python3 claude_graph.py --all`);
  process.exit(2);
}
const m = fs.readFileSync(file, "utf8").match(/const DATA = (\{.*?\});\n/s);
if (!m) { console.error(`${file} 里没有内嵌数据`); process.exit(2); }
const DATA = JSON.parse(m[1]);

let layouts = 0, nodes = 0, edges = 0, forks = 0, maxLane = 0;
const fail = [];
const bad = (...a) => fail.push(a.join(" "));

for (const p of DATA.projects) for (const s of p.sessions) {
  // 两种过滤模式都要成立：默认视图，以及放出命令/系统事件后的视图
  for (const showNoise of [false, true]) {
    const turns = contract(s.turns,
      t => showNoise || t.kind === "prompt" || t.kind === "compact");
    if (!turns.length) continue;

    const v = layout(turns);
    const id = s.id.slice(0, 8);
    layouts++; nodes += v.order.length; forks += v.forks.size;
    maxLane = Math.max(maxLane, v.maxLane + 1);

    // 1. 节点数守恒
    if (v.order.length !== turns.length) bad("节点丢失", id);

    // 2. 行号连续且唯一
    if ([...v.row.values()].sort((a, b) => a - b).some((r, i) => r !== i))
      bad("行号不连续", id);

    // 3. 同一父节点的兄弟必须各占一条泳道，否则连线会重叠
    for (const [pid, cs] of v.kids) {
      if (cs.length < 2 || !v.lane.has(pid)) continue;
      const ls = cs.map(c => v.lane.get(c));
      if (new Set(ls).size !== ls.length) bad("兄弟泳道冲突", id, pid.slice(0, 7));
    }

    const occupied = new Map();
    for (const nid of v.order) occupied.set(`${v.row.get(nid)}:${v.lane.get(nid)}`, nid);

    for (const t of turns) {
      if (!t.parent || !v.row.has(t.parent)) continue;
      const r1 = v.row.get(t.parent), r2 = v.row.get(t.id), l2 = v.lane.get(t.id);
      edges++;

      // 4. 边一律向下
      if (r2 <= r1) { bad("边不向下", id, t.short); continue; }

      // 5. 「线不穿节点」的真正条件：连线拐进目标泳道后要一路垂直下行，
      //    因此该泳道在父行与子行之间不得有任何其他节点占位。
      for (let r = r1 + 1; r < r2; r++) {
        const occ = occupied.get(`${r}:${l2}`);
        if (occ) bad("连线穿过节点", id, t.short, `泳道${l2} 行${r} →`, occ.slice(0, 7));
      }
    }
  }
}

for (const f of fail) console.error("  ✗", f);
console.log(`\n布局 ${layouts} · 节点 ${nodes} · 边 ${edges} · 分叉 ${forks}` +
            ` · 最宽 ${maxLane} 泳道 · 违例 ${fail.length}`);
process.exit(fail.length ? 1 : 0);
