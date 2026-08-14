/** 用 Codex app-server 的稳定 thread/fork(lastTurnId) API 精确创建历史分支。 */
"use strict";

const { spawn } = require("node:child_process");

const CLIENT_INFO = {
  name: "conversation_graph_vscode",
  title: "Claude / Codex Conversation Graph",
  version: "0.3.3",
};

function forkThread(options = {}) {
  const {
    command = "codex", threadId, lastTurnId, cwd, name = "",
    timeoutMs = 15_000, spawnImpl = spawn,
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, ["app-server", "--listen", "stdio://"], {
        cwd, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let buffer = "";
    let stderr = "";
    let forkedId = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(result);
    };
    const describeError = error => {
      const message = error?.message || error?.data || JSON.stringify(error || {});
      return new Error(`${message}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
    };
    const send = message => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch (error) { finish(error); }
    };

    const timer = setTimeout(() => finish(new Error(
      `Codex app-server 在 ${Math.round(timeoutMs / 1000)} 秒内没有响应。`)), timeoutMs);

    child.on("error", error => finish(error));
    child.on("exit", code => {
      if (!settled && code !== null) finish(new Error(
        `Codex app-server 已退出（code ${code}）。${stderr.trim() ? ` ${stderr.trim()}` : ""}`));
    });
    child.stderr?.on("data", chunk => {
      stderr = (stderr + String(chunk)).slice(-8192);
    });
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(describeError(message.error));
          forkedId = message.result?.thread?.id || "";
          if (!forkedId) return finish(new Error("Codex 没有返回新分支的 thread ID。"));
          if (name) send({
            method: "thread/name/set", id: 2,
            params: { threadId: forkedId, name },
          });
          else return finish(null, { id: forkedId, nameSet: false });
        } else if (message.id === 2) {
          // 名称失败不应丢掉已经成功创建的分支；把警告交给调用方显示。
          if (message.error) return finish(null, {
            id: forkedId, nameSet: false, nameError: describeError(message.error).message,
          });
          return finish(null, { id: forkedId, nameSet: true });
        }
      }
    });

    send({ method: "initialize", id: 0, params: { clientInfo: CLIENT_INFO } });
    send({ method: "initialized", params: {} });
    send({
      method: "thread/fork", id: 1,
      params: { threadId, lastTurnId, cwd },
    });
  });
}

module.exports = { forkThread, CLIENT_INFO };
