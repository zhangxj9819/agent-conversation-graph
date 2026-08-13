/**
 * 对话树 → git-graph 泳道布局。浏览器里直接 <script> 引入，Node 里 require 亦可。
 * 纯函数、不碰 DOM —— 因此可以拿真实数据跑不变量测试（见 test_layout.mjs）。
 *
 * 两处使用者：
 *   1. claude_graph.py 生成单文件 HTML 时把本文件内容注入模板
 *   2. VS Code 插件的 webview 直接加载本文件
 * 改这里两边同时生效，不要复制副本。
 */
function contract(turns, visible) {
  const byId = new Map(turns.map(t => [t.id, t]));
  const keep = new Set(turns.filter(visible).map(t => t.id));
  const lift = id => {
    let p = byId.get(id).parent;
    const seen = new Set();
    while (p && byId.has(p) && !keep.has(p) && !seen.has(p)) { seen.add(p); p = byId.get(p).parent; }
    return (p && keep.has(p)) ? p : null;
  };
  return turns.filter(visible).map(t => ({ ...t, parent: lift(t.id) }));
}

function layout(turns) {
  const byId = new Map(turns.map(t => [t.id, t]));
  const kids = new Map();
  const roots = [];
  for (const t of turns) {
    const p = t.parent && byId.has(t.parent) ? t.parent : null;
    if (p === null) roots.push(t.id);
    else { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(t.id); }
  }

  // 子树最晚时间戳（后序，迭代实现以免深链爆栈）
  const subMax = new Map();
  const post = [];
  const seen = new Set();
  for (const r of roots) {
    const stack = [r];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id); post.push(id);
      for (const c of kids.get(id) || []) stack.push(c);
    }
  }
  for (let i = post.length - 1; i >= 0; i--) {
    const id = post[i];
    let m = byId.get(id).ts || "";
    for (const c of kids.get(id) || []) { const v = subMax.get(c); if (v > m) m = v; }
    subMax.set(id, m);
  }

  const order = [], lane = new Map(), busy = new Set();
  const lastRow = new Map();   // 每条泳道最后被占用的行号

  /**
   * 取一条可用泳道。两个条件缺一不可：
   *   busy   —— 该泳道上有仍在延伸的分支链；
   *   lastRow —— 该泳道自 afterRow 行之后被占用过。连线要从父节点所在行一路
   *              垂直下行到子节点，中途若有旧节点占位，线就会从它身上穿过去。
   */
  const freeLane = afterRow => {
    let l = 0;
    while (busy.has(l) || (lastRow.get(l) ?? -1) > afterRow) l++;
    return l;
  };

  const walk = (id, l) => {
    const r = order.length;
    lane.set(id, l); order.push(id); busy.add(l); lastRow.set(l, r);
    const cs = (kids.get(id) || []).slice()
      .sort((a, b) => (subMax.get(a) || "").localeCompare(subMax.get(b) || "") || a.localeCompare(b));
    // 侧枝各占一条泳道，并保持占用到全部兄弟铺完 —— 否则后一个兄弟会复用前一个
    // 的泳道，两条连线便会重叠在一起。
    const held = [];
    for (let i = 0; i < cs.length - 1; i++) {
      const nl = freeLane(r);
      busy.add(nl); held.push(nl);
      walk(cs[i], nl);
    }
    for (const nl of held) busy.delete(nl);
    if (cs.length) walk(cs[cs.length - 1], l);           // 主干继承本泳道
    return l;
  };
  roots.sort((a, b) => (byId.get(a).ts || "").localeCompare(byId.get(b).ts || ""));
  for (const r of roots) walk(r, freeLane(order.length - 1));

  const row = new Map(order.map((id, i) => [id, i]));
  const maxLane = Math.max(0, ...lane.values());

  // ref 标签：全局最新的叶子是 HEAD，其余叶子是被放弃的分支尖端
  const leaves = order.filter(id => !(kids.get(id) || []).length);
  let head = null, best = "";
  for (const id of leaves) { const t = byId.get(id).ts || ""; if (t > best) { best = t; head = id; } }
  const refs = new Map();
  let n = 0;
  for (const id of leaves) refs.set(id, id === head ? "HEAD" : `tip/${++n}`);
  const forks = new Set([...kids.entries()].filter(([, c]) => c.length > 1).map(([p]) => p));

  return { turns, byId, kids, order, row, lane, maxLane, refs, forks, head, roots };
}

if (typeof module !== "undefined" && module.exports) module.exports = { contract, layout };
