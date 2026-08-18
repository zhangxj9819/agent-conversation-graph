/** 虚拟子项目状态的 CRUD、工作区隔离与对话归类回归测试。 */
"use strict";

const assert = require("node:assert");
const {
  STATE_KEY,
  SubprojectStore,
  normalizeState,
} = require("../src/subproject-store");

class Memento {
  constructor() { this.values = new Map(); this.updates = 0; }
  get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; }
  async update(key, value) { this.values.set(key, value); this.updates++; }
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push(["✓", name]); }
  catch (err) { checks.push(["✗", `${name} —— ${err.message}`]); }
};

(async () => {
  const memento = new Memento();
  let nextId = 0;
  const store = new SubprojectStore(memento, () => `project-${++nextId}`);
  const workspace = "/work/a";
  const conversation = JSON.stringify(["claude", "/work/a", "session-a"]);

  check("新工作区默认没有虚拟子项目", () =>
    assert.deepStrictEqual(store.list(workspace), []));

  const auth = await store.create(workspace, "  登录   重构  ");
  check("创建时规范化名称并写入 workspaceState", () => {
    assert.strictEqual(auth.id, "project-1");
    assert.strictEqual(auth.name, "登录 重构");
    assert.strictEqual(store.list(workspace).length, 1);
    assert.ok(memento.values.has(STATE_KEY));
  });

  await assert.rejects(() => store.create(workspace, "登录 重构"), /同名/);
  check("拒绝空名称、超长名称和同名子项目", () => {
    assert.strictEqual(store.validateName(workspace, ""), "子项目名称不能为空");
    assert.ok(store.validateName(workspace, "x".repeat(81)).includes("80"));
    assert.strictEqual(store.validateName(workspace, "登录 重构"), "已经存在同名子项目");
  });

  await store.assign(workspace, conversation, auth.id);
  check("对话可归入子项目且只保存稳定标识", () =>
    assert.strictEqual(store.assignmentFor(workspace, conversation), auth.id));

  const renamed = await store.rename(workspace, auth.id, "身份认证");
  check("重命名不会破坏已有对话归类", () => {
    assert.strictEqual(renamed.name, "身份认证");
    assert.strictEqual(store.assignmentFor(workspace, conversation), auth.id);
  });

  const other = await store.create("/work/b", "另一个工作区");
  await store.assign("/work/b", "codex-thread", other.id);
  check("不同工作区的子项目和归类彼此隔离", () => {
    assert.deepStrictEqual(store.list(workspace).map(item => item.name), ["身份认证"]);
    assert.deepStrictEqual(store.list("/work/b").map(item => item.name), ["另一个工作区"]);
    assert.strictEqual(store.assignmentFor(workspace, "codex-thread"), null);
  });

  const removed = await store.delete(workspace, auth.id);
  check("删除子项目只解除其中的对话归类", () => {
    assert.strictEqual(removed.unassigned, 1);
    assert.strictEqual(store.assignmentFor(workspace, conversation), null);
    assert.deepStrictEqual(store.list(workspace), []);
    assert.strictEqual(store.list("/work/b").length, 1);
  });

  check("损坏或过期的状态会被安全清洗", () => {
    const cleaned = normalizeState({
      workspaces: {
        "/work/c": {
          projects: [{ id: "ok", name: "保留" }, { id: "bad", name: "" }],
          assignments: { valid: "ok", stale: "bad" },
        },
      },
    });
    assert.deepStrictEqual(cleaned.workspaces["/work/c"].projects.map(item => item.id), ["ok"]);
    assert.deepStrictEqual(cleaned.workspaces["/work/c"].assignments, { valid: "ok" });
  });

  for (const [mark, message] of checks) console.log(`  ${mark} ${message}`);
  const failures = checks.filter(([mark]) => mark === "✗");
  console.log(`\n${checks.length} 项子项目检查 · 失败 ${failures.length}`);
  if (failures.length) process.exitCode = 1;
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
