"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { forkThread } = require("../src/codex-app-server");

function fakeServer(calls, options = {}) {
  return (command, args, spawnOptions) => {
    calls.spawn = { command, args, options: spawnOptions };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    let buffer = "";
    child.stdin.on("data", chunk => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        calls.messages.push(message);
        if (message.method === "thread/fork") {
          setImmediate(() => child.stdout.write(JSON.stringify(options.forkError
            ? { id: 1, error: { message: options.forkError } }
            : { id: 1, result: { thread: { id: "99999999-9999-7999-8999-999999999999" } } }) + "\n"));
        } else if (message.method === "thread/name/set") {
          setImmediate(() => child.stdout.write(JSON.stringify({ id: 2, result: {} }) + "\n"));
        }
      }
    });
    return child;
  };
}

(async () => {
  const calls = { messages: [] };
  const result = await forkThread({
    command: "/opt/codex",
    threadId: "55555555-5555-7555-8555-555555555555",
    lastTurnId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    cwd: "/tmp",
    name: "passkey",
    spawnImpl: fakeServer(calls),
  });

  assert.strictEqual(calls.spawn.command, "/opt/codex");
  assert.deepStrictEqual(calls.spawn.args, ["app-server", "--listen", "stdio://"]);
  assert.strictEqual(calls.spawn.options.cwd, "/tmp");
  assert.deepStrictEqual(calls.messages.map(message => message.method), [
    "initialize", "initialized", "thread/fork", "thread/name/set",
  ]);
  assert.deepStrictEqual(calls.messages[2].params, {
    threadId: "55555555-5555-7555-8555-555555555555",
    lastTurnId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    cwd: "/tmp",
  });
  assert.deepStrictEqual(calls.messages[3].params, {
    threadId: "99999999-9999-7999-8999-999999999999",
    name: "passkey",
  });
  assert.deepStrictEqual(result, {
    id: "99999999-9999-7999-8999-999999999999",
    nameSet: true,
  });

  const failedCalls = { messages: [] };
  await assert.rejects(() => forkThread({
    threadId: "55555555-5555-7555-8555-555555555555",
    lastTurnId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    cwd: "/tmp",
    spawnImpl: fakeServer(failedCalls, { forkError: "unknown turn" }),
  }), /unknown turn/);

  console.log("  ✓ app-server 初始化并发送精确 lastTurnId");
  console.log("  ✓ 新 Codex thread 可立即命名");
  console.log("  ✓ app-server 错误会返回给扩展");
  console.log("\n3 项检查 · 失败 0");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
