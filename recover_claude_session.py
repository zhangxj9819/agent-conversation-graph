#!/usr/bin/env python3
"""从 claude-graph 单文件 HTML 中重建可恢复的 Claude Code JSONL 会话。

静态 HTML 只保存聚合后的轮次，因此本脚本保留：
- session / 用户轮次 UUID 与父子分支结构
- 用户提问、助手文本、工具输入与工具结果的可见快照
- 时间、cwd、git 分支、模型和 token 元数据

无法还原：被 --max-chars 截断的尾部、原始助手消息 UUID、thinking 签名、
tool_use ID，以及 file-history checkpoint。工具调用与结果会安全地转成助手文本，
避免制造无效的 tool_use/tool_result 配对。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)


def load_payload(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    marker = "const DATA = "
    start = raw.find(marker)
    if start < 0:
        raise ValueError("HTML 中没有找到内嵌 DATA")
    start += len(marker)
    end_marker = ";\n\nconst ROW_H"
    end = raw.find(end_marker, start)
    if end < 0:
        raise ValueError("无法确定内嵌 DATA 的结束位置")
    return json.loads(raw[start:end])


def find_session(payload: dict, prefix: str) -> dict:
    matches = [
        session
        for project in payload.get("projects", [])
        for session in project.get("sessions", [])
        if session.get("id", "").startswith(prefix)
    ]
    if not matches:
        raise ValueError(f"没有找到 session {prefix}")
    if len(matches) > 1:
        raise ValueError(f"session 前缀 {prefix} 不唯一，共匹配 {len(matches)} 个")
    return matches[0]


def add_millisecond(timestamp: str) -> str:
    try:
        value = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        return (value + timedelta(milliseconds=1)).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
    except (TypeError, ValueError):
        return timestamp


def recovered_assistant_id(session_id: str, turn_id: str) -> str:
    return str(uuid.uuid5(uuid.UUID(session_id), f"recovered-assistant:{turn_id}"))


def recovered_prompt_id(session_id: str, turn_id: str) -> str:
    return str(uuid.uuid5(uuid.UUID(session_id), f"recovered-prompt:{turn_id}"))


def assistant_snapshot(turn: dict) -> str:
    steps = turn.get("steps") or []
    if not steps:
        return ""

    parts: list[str] = []
    contains_snapshot = any(step.get("type") not in {"text"} for step in steps)
    if contains_snapshot:
        parts.append(
            "> [从 claude-graph.html 恢复的静态快照。工具调用与结果已转成文本；"
            "标记为截断的内容无法完整还原。]"
        )

    for index, step in enumerate(steps, 1):
        kind = step.get("type") or "unknown"
        detail = str(step.get("detail") or "")
        suffix = "\n[…原静态快照在此处已截断…]" if step.get("truncated") else ""

        if kind == "text":
            parts.append(detail + suffix)
        elif kind == "thinking":
            parts.append(f"### 恢复的思考片段 {index}\n\n{detail}{suffix}")
        elif kind == "tool":
            name = step.get("name") or "tool"
            summary = step.get("summary") or ""
            heading = f"### 工具调用 {index}: {name}"
            if summary:
                heading += f"\n\n摘要：{summary}"
            parts.append(f"{heading}\n\n```json\n{detail}\n```{suffix}")
        elif kind == "result":
            label = "工具错误" if step.get("isError") else "工具结果"
            parts.append(f"### {label} {index}\n\n```text\n{detail}\n```{suffix}")
        else:
            parts.append(f"### 恢复步骤 {index}: {kind}\n\n{detail}{suffix}")

    return "\n\n".join(part for part in parts if part.strip()).strip()


def user_snapshot(turn: dict) -> str:
    """补回用于分类的 CLI 包装标签，使恢复后的图仍能区分命令与系统事件。"""
    body = turn.get("body") or turn.get("title") or "(恢复的空消息)"
    kind = turn.get("kind")
    title = turn.get("title") or ""
    if kind == "command":
        name, _, args = title.partition(" ")
        return (
            f"<command-name>{name}</command-name>"
            f"<command-args>{args}</command-args>"
            f"<command-message>{body}</command-message>"
        )
    if kind == "system-event":
        if title.startswith("⎋ 用户打断"):
            return "[Request interrupted by user]"
        return f"<local-command-stdout>{body}</local-command-stdout>"
    return body


def topological_turns(turns: list[dict]) -> list[dict]:
    by_id = {turn["id"]: turn for turn in turns}
    if len(by_id) != len(turns):
        raise ValueError("轮次 UUID 重复")

    children: dict[str | None, list[dict]] = defaultdict(list)
    for turn in turns:
        turn_id = turn.get("id")
        parent = turn.get("parent")
        if not UUID_RE.fullmatch(turn_id or ""):
            raise ValueError(f"轮次 UUID 无效：{turn_id}")
        if parent and parent not in by_id:
            raise ValueError(f"轮次 {turn_id} 的父节点不存在：{parent}")
        children[parent].append(turn)

    key = lambda turn: (turn.get("ts") or "", turn["id"])
    for values in children.values():
        values.sort(key=key)

    ordered: list[dict] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def walk(root: dict) -> None:
        turn_id = root["id"]
        if turn_id in visiting:
            raise ValueError(f"轮次图存在环：{turn_id}")
        if turn_id in visited:
            return
        visiting.add(turn_id)
        ordered.append(root)
        for child in children.get(turn_id, []):
            walk(child)
        visiting.remove(turn_id)
        visited.add(turn_id)

    for root in children.get(None, []):
        walk(root)
    if len(ordered) != len(turns):
        raise ValueError(f"有 {len(turns) - len(ordered)} 个轮次无法从根节点到达")
    return ordered


def build_records(session: dict) -> tuple[list[dict], dict]:
    session_id = session.get("id") or ""
    if not UUID_RE.fullmatch(session_id):
        raise ValueError(f"session UUID 无效：{session_id}")

    turns = topological_turns(session.get("turns") or [])
    cwd = session.get("cwd") or ""
    snapshots = {turn["id"]: assistant_snapshot(turn) for turn in turns}
    assistant_ids = {
        turn["id"]: recovered_assistant_id(session_id, turn["id"])
        for turn in turns
        if snapshots[turn["id"]]
    }

    records: list[dict] = []
    truncated_steps = 0
    for turn in turns:
        turn_id = turn["id"]
        parent_turn = turn.get("parent")
        parent_uuid = None
        if parent_turn:
            parent_uuid = assistant_ids.get(parent_turn, parent_turn)

        common = {
            "sessionId": session_id,
            "cwd": turn.get("cwd") or cwd,
            "gitBranch": turn.get("gitBranch") or "",
            "version": turn.get("version") or "2.1.231",
            "userType": "external",
            "isSidechain": False,
            "entrypoint": "claude-vscode",
        }
        user_record = {
            **common,
            "type": "user",
            "uuid": turn_id,
            "parentUuid": parent_uuid,
            "timestamp": turn.get("ts") or "",
            "promptId": recovered_prompt_id(session_id, turn_id),
            "message": {
                "role": "user",
                "content": user_snapshot(turn),
            },
        }
        if turn.get("kind") == "compact":
            user_record["isCompactSummary"] = True
        records.append(user_record)

        text = snapshots[turn_id]
        if not text:
            continue
        assistant_id = assistant_ids[turn_id]
        models = turn.get("models") or []
        output_tokens = int(turn.get("outputTokens") or 0)
        records.append({
            **common,
            "type": "assistant",
            "uuid": assistant_id,
            "parentUuid": turn_id,
            "timestamp": add_millisecond(turn.get("ts") or ""),
            "requestId": f"recovered-{turn_id}",
            "message": {
                "id": f"msg_recovered_{assistant_id.replace('-', '')}",
                "type": "message",
                "role": "assistant",
                "model": models[-1] if models else "claude-sonnet-5",
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": output_tokens,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                },
            },
        })
        truncated_steps += sum(bool(step.get("truncated")) for step in turn.get("steps") or [])

    title = session.get("title") or session_id[:8]
    records.append({
        "type": "ai-title",
        "sessionId": session_id,
        "slug": f"[恢复] {title}",
    })
    records.append({
        "type": "custom-title",
        "sessionId": session_id,
        "customTitle": f"[恢复] {title}",
    })

    report = {
        "sessionId": session_id,
        "title": title,
        "cwd": cwd,
        "turns": len(turns),
        "assistantMessages": len(assistant_ids),
        "records": len(records),
        "roots": sum(not turn.get("parent") for turn in turns),
        "truncatedSteps": truncated_steps,
    }
    return records, report


def main() -> None:
    parser = argparse.ArgumentParser(description="从 claude-graph HTML 恢复 Claude Code JSONL")
    parser.add_argument("html", type=Path, help="claude-graph.html 路径")
    parser.add_argument("session", help="session UUID 或唯一前缀")
    parser.add_argument("-o", "--out", type=Path, required=True, help="恢复 JSONL 输出路径")
    args = parser.parse_args()

    if args.out.exists():
        sys.exit(f"拒绝覆盖已有文件：{args.out}")
    payload = load_payload(args.html)
    session = find_session(payload, args.session)
    records, report = build_records(session)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({**report, "output": str(args.out.resolve())}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
