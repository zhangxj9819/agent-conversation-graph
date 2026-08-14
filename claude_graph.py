#!/usr/bin/env python3
"""
claude-graph — 把 Claude Code 的对话历史渲染成 git-graph 风格的分支图。

对话记录 (~/.claude/projects/**/*.jsonl) 里每条消息都带 uuid / parentUuid，
天然构成一棵树。当你回退到某条历史消息重新提问（Esc Esc 或编辑），就会从
那个节点分出新的孩子 —— 结构上和 git 的分叉完全同构。

本工具把原始记录聚合成「轮次树」（一次用户提问 + 其后的助手工作 = 一个 commit），
计算 git-graph 的泳道布局，输出单文件 HTML。

用法:
    python3 claude_graph.py --list                 列出所有项目与会话
    python3 claude_graph.py                        当前目录所属项目
    python3 claude_graph.py --project FlowSched    按名字模糊匹配项目
    python3 claude_graph.py --all -o graph.html    全部项目
    python3 claude_graph.py --open                 生成后直接打开
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import webbrowser
from collections import defaultdict
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
PROJECTS_DIR = CONFIG_DIR / "projects"
TEMPLATE = Path(__file__).with_name("viewer_template.html")
LAYOUT_JS = Path(__file__).with_name("layout.js")   # 与 VS Code 插件共用的布局算法

# 单条消息正文的截断上限；工具返回值往往是整个文件，不截断会让 HTML 爆掉
DEFAULT_MAX_CHARS = 2000
DEFAULT_MAX_PROMPT = 20000


# ---------------------------------------------------------------- 读取与清洗

def read_jsonl(path: Path) -> list[dict]:
    out = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # 会话正在写入时最后一行可能是残缺的
    return out


def msg_blocks(rec: dict) -> list[dict]:
    """把 message.content 统一成 block 列表。"""
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


# 这些包装标签是 CLI 注入的，不是用户真的敲进去的内容
TAG_RE = re.compile(
    r"<(command-name|command-message|command-args|local-command-stdout|"
    r"local-command-stderr|system-reminder|task-notification|task-id|"
    r"tool-use-id|user-prompt-submit-hook)>(.*?)</\1>",
    re.S,
)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
# CLI 在用户按 Esc 打断时会写入的合成消息，不是真的提问
INTERRUPT_RE = re.compile(r"^\[Request interrupted by user")


def plain_text(blocks: list[dict]) -> str:
    parts = []
    for b in blocks:
        if b.get("type") == "text":
            parts.append(b.get("text") or "")
    return ANSI_RE.sub("", "\n".join(parts)).strip()


def classify_prompt(text: str, rec: dict) -> tuple[str, str]:
    """返回 (kind, title)。kind 决定这一轮在图上的样子和默认是否可见。"""
    stripped = text.strip()

    if INTERRUPT_RE.match(stripped):
        return "system-event", "⎋ 用户打断"

    if rec.get("isCompactSummary") or stripped.startswith(
        "This session is being continued from a previous conversation"
    ):
        return "compact", "／compact 上下文压缩续接"

    m = re.search(r"<command-name>\s*(.*?)\s*</command-name>", stripped, re.S)
    if m:
        name = m.group(1).strip()
        args = re.search(r"<command-args>\s*(.*?)\s*</command-args>", stripped, re.S)
        extra = (args.group(1).strip() if args else "")
        return "command", (f"{name} {extra}".strip() or name)

    if stripped.startswith("<task-notification>"):
        tid = re.search(r"<task-id>(.*?)</task-id>", stripped)
        return "system-event", f"子任务完成 {tid.group(1) if tid else ''}".strip()

    if stripped.startswith("<local-command-stdout>"):
        body = TAG_RE.sub(lambda m: m.group(2), stripped).strip()
        return "system-event", (body.splitlines() or [""])[0][:120]

    # 去掉夹杂的注入标签后再取首行做标题
    clean = TAG_RE.sub(lambda m: m.group(2), stripped).strip()
    clean = re.sub(r"\s+", " ", clean)
    return "prompt", clean[:160] if clean else "(空)"


def is_anchor(rec: dict) -> bool:
    """判断一条记录是不是「一轮对话的起点」——即真实的用户输入。"""
    if rec.get("type") != "user" or rec.get("isSidechain"):
        return False
    blocks = msg_blocks(rec)
    if not blocks:
        return False
    kinds = {b.get("type") for b in blocks}
    if "tool_result" in kinds:
        return False  # 工具返回值，不是用户说的话
    if rec.get("isMeta"):
        return False
    return bool(plain_text(blocks))


def truncate(s: str, limit: int) -> tuple[str, bool]:
    if s is None:
        return "", False
    if len(s) <= limit:
        return s, False
    return s[:limit], True


# ---------------------------------------------------------------- 轮次树构建

def summarize_tool(block: dict, max_chars: int) -> dict:
    name = block.get("name") or "tool"
    inp = block.get("input") or {}
    # 每种工具挑一个最能说明「做了什么」的字段做单行摘要
    for key in ("command", "file_path", "pattern", "path", "query", "prompt", "url", "skill"):
        if isinstance(inp.get(key), str) and inp[key].strip():
            head = re.sub(r"\s+", " ", inp[key].strip())
            break
    else:
        head = ""
    detail, cut = truncate(json.dumps(inp, ensure_ascii=False, indent=2), max_chars)
    return {
        "type": "tool",
        "name": name,
        "summary": head[:200],
        "detail": detail,
        "truncated": cut,
    }


def build_turns(records: list[dict], max_chars: int, max_prompt: int) -> dict:
    """把一个会话的原始记录聚合成轮次树。"""
    by_uuid: dict[str, dict] = {}
    for rec in records:
        u = rec.get("uuid")
        if u and not rec.get("isSidechain"):
            by_uuid[u] = rec

    # 子代表：注意要包含 system / attachment 等类型，parentUuid 链会穿过它们
    children: dict[str | None, list[str]] = defaultdict(list)
    for u, rec in by_uuid.items():
        children[rec.get("parentUuid")].append(u)
    for lst in children.values():
        lst.sort(key=lambda u: (by_uuid[u].get("timestamp") or "", u))

    anchors = {u for u, rec in by_uuid.items() if is_anchor(rec)}

    def nearest_anchor_above(u: str) -> str | None:
        p = by_uuid[u].get("parentUuid")
        seen = set()
        while p and p in by_uuid and p not in anchors and p not in seen:
            seen.add(p)
            p = by_uuid[p].get("parentUuid")
        return p if p in anchors else None

    # 子 agent（sidechain）按发起它的 tool_use 归属到某一轮
    sidechain_by_tool: dict[str, int] = defaultdict(int)
    for rec in records:
        if rec.get("isSidechain") and rec.get("sourceToolAssistantUUID"):
            sidechain_by_tool[rec["sourceToolAssistantUUID"]] += 1

    turns = []
    for anchor in anchors:
        rec = by_uuid[anchor]
        blocks = msg_blocks(rec)
        raw = plain_text(blocks)
        kind, title = classify_prompt(raw, rec)
        body, body_cut = truncate(TAG_RE.sub(lambda m: m.group(2), raw).strip(), max_prompt)

        # 收集这一轮的助手动作：从 anchor 往下走，遇到下一个 anchor 停
        steps_uuids = []
        stack = list(children.get(anchor, []))
        while stack:
            u = stack.pop()
            if u in anchors:
                continue
            steps_uuids.append(u)
            stack.extend(children.get(u, []))
        steps_uuids.sort(key=lambda u: (by_uuid[u].get("timestamp") or "", u))

        # Claude Code 的 --resume-session-at 需要原始消息 UUID。轮次节点本身是
        # 用户提问；若本轮已有助手工作，则恢复到最后一条对话记录，才能保留整轮上下文。
        resumable = [anchor] + [
            u for u in steps_uuids
            if by_uuid[u].get("type") in {"user", "assistant"}
        ]
        resume_at = resumable[-1]

        steps = []
        tools = []
        models = set()
        out_tokens = 0
        subagents = 0
        for u in steps_uuids:
            r = by_uuid[u]
            if r.get("type") == "assistant":
                m = r.get("message") or {}
                if m.get("model"):
                    models.add(m["model"])
                out_tokens += (m.get("usage") or {}).get("output_tokens") or 0
                for b in msg_blocks(r):
                    bt = b.get("type")
                    if bt == "text":
                        txt, cut = truncate(b.get("text") or "", max_chars)
                        if txt.strip():
                            steps.append({"type": "text", "detail": txt, "truncated": cut})
                    elif bt == "thinking":
                        txt, cut = truncate(b.get("thinking") or "", max_chars)
                        if txt.strip():
                            steps.append({"type": "thinking", "detail": txt, "truncated": cut})
                    elif bt == "tool_use":
                        st = summarize_tool(b, max_chars)
                        subagents += sidechain_by_tool.get(u, 0)
                        steps.append(st)
                        tools.append(st["name"])
            elif r.get("type") == "user":
                for b in msg_blocks(r):
                    if b.get("type") != "tool_result":
                        continue
                    c = b.get("content")
                    if isinstance(c, list):
                        c = "\n".join(
                            x.get("text", "") for x in c if isinstance(x, dict)
                        )
                    txt, cut = truncate(str(c or ""), max_chars)
                    steps.append({
                        "type": "result",
                        "detail": txt,
                        "truncated": cut,
                        "isError": bool(b.get("is_error")),
                    })

        turns.append({
            "id": anchor,
            "short": anchor[:7],
            "parent": nearest_anchor_above(anchor),
            "resumeAt": resume_at,
            "ts": rec.get("timestamp"),
            "kind": kind,
            "title": title,
            "body": body,
            "bodyTruncated": body_cut,
            "gitBranch": rec.get("gitBranch") or "",
            "cwd": rec.get("cwd") or "",
            "version": rec.get("version") or "",
            "models": sorted(models),
            "steps": steps,
            "toolCounts": {t: tools.count(t) for t in sorted(set(tools))},
            "outputTokens": out_tokens,
            "subagents": subagents,
        })

    turns.sort(key=lambda t: (t["ts"] or "", t["id"]))
    return {"turns": turns}


def session_meta(path: Path, records: list[dict], turns: list[dict]) -> dict:
    custom_title = ""
    ai_title = ""
    agent_name = ""
    cwd = ""
    for rec in records:
        if rec.get("type") == "custom-title" and rec.get("customTitle"):
            custom_title = rec["customTitle"]
        if rec.get("type") == "ai-title" and (rec.get("aiTitle") or rec.get("slug")):
            ai_title = rec.get("aiTitle") or rec["slug"]
        if rec.get("type") == "agent-name" and rec.get("agentName"):
            agent_name = rec["agentName"]
        if not cwd and rec.get("cwd"):
            cwd = rec["cwd"]
    title = custom_title or agent_name or ai_title
    if not title and turns:
        first = next((t for t in turns if t["kind"] == "prompt"), turns[0])
        title = first["title"][:60]
    stamps = [t["ts"] for t in turns if t["ts"]]
    return {
        "id": path.stem,
        "short": path.stem[:8],
        "file": str(path),
        "title": title or path.stem[:8],
        "cwd": cwd,
        "start": min(stamps) if stamps else "",
        "end": max(stamps) if stamps else "",
        "turnCount": len(turns),
    }


# ---------------------------------------------------------------- 项目发现

def decode_project(dirname: str, sessions: list[dict]) -> str:
    """目录名是把路径里的 / 换成 - 得来的，不可逆；优先用记录里的真实 cwd。"""
    for s in sessions:
        if s["cwd"]:
            return s["cwd"]
    return dirname


def discover(project_filter: str | None, session_filter: str | None,
             max_chars: int, max_prompt: int) -> list[dict]:
    if not PROJECTS_DIR.is_dir():
        sys.exit(f"找不到 {PROJECTS_DIR}")

    projects = []
    for pdir in sorted(PROJECTS_DIR.iterdir()):
        if not pdir.is_dir():
            continue
        if project_filter and project_filter.lower() not in pdir.name.lower():
            continue
        sessions = []
        for jf in sorted(pdir.glob("*.jsonl")):
            if session_filter and not jf.stem.startswith(session_filter):
                continue
            records = read_jsonl(jf)
            if not records:
                continue
            built = build_turns(records, max_chars, max_prompt)
            if not built["turns"]:
                continue
            meta = session_meta(jf, records, built["turns"])
            meta["turns"] = built["turns"]
            sessions.append(meta)
        if not sessions:
            continue
        sessions.sort(key=lambda s: s["end"], reverse=True)
        projects.append({
            "dir": pdir.name,
            "path": decode_project(pdir.name, sessions),
            "sessions": sessions,
        })
    projects.sort(
        key=lambda p: max((s["end"] for s in p["sessions"]), default=""), reverse=True
    )
    return projects


# ---------------------------------------------------------------- 命令行

def cmd_list() -> None:
    projects = discover(None, None, 200, 200)
    for p in projects:
        total = sum(s["turnCount"] for s in p["sessions"])
        print(f"\n\033[1m{p['path']}\033[0m  ({len(p['sessions'])} 会话 / {total} 轮)")
        for s in p["sessions"]:
            print(f"   {s['short']}  {s['end'][:16].replace('T', ' '):17}"
                  f" {s['turnCount']:>4} 轮  {s['title'][:56]}")


def main() -> None:
    ap = argparse.ArgumentParser(description="把 Claude 对话渲染成 git-graph 分支图")
    ap.add_argument("--list", action="store_true", help="列出项目与会话后退出")
    ap.add_argument("--project", help="按名字模糊匹配项目目录")
    ap.add_argument("--session", help="按 uuid 前缀匹配单个会话")
    ap.add_argument("--all", action="store_true", help="包含全部项目")
    ap.add_argument("-o", "--out", default="claude-graph.html", help="输出 HTML 路径")
    ap.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS,
                    help=f"单条工具输出/回复的截断长度（默认 {DEFAULT_MAX_CHARS}）")
    ap.add_argument("--max-prompt", type=int, default=DEFAULT_MAX_PROMPT,
                    help=f"用户提问的截断长度（默认 {DEFAULT_MAX_PROMPT}）")
    ap.add_argument("--open", action="store_true", help="生成后用浏览器打开")
    args = ap.parse_args()

    if args.list:
        cmd_list()
        return

    project_filter = args.project
    if not project_filter and not args.all and not args.session:
        # 默认只看当前工作目录对应的项目
        guess = str(Path.cwd()).replace("/", "-")
        if (PROJECTS_DIR / guess).is_dir():
            project_filter = guess
        else:
            print("当前目录没有对应的会话记录，改为导出全部项目。", file=sys.stderr)

    projects = discover(project_filter, args.session, args.max_chars, args.max_prompt)
    if not projects:
        sys.exit("没有匹配到任何会话。先跑 --list 看看有什么。")

    payload = {"projects": projects}
    for path in (TEMPLATE, LAYOUT_JS):
        if not path.exists():
            sys.exit(f"缺少文件 {path}")
    html = (
        TEMPLATE.read_text(encoding="utf-8")
        .replace("/*__LAYOUT__*/", LAYOUT_JS.read_text(encoding="utf-8"))
        .replace(
            "/*__DATA__*/null",
            json.dumps(payload, ensure_ascii=False).replace("</", "<\\/"),
        )
    )
    out = Path(args.out).resolve()
    out.write_text(html, encoding="utf-8")

    n_sessions = sum(len(p["sessions"]) for p in projects)
    n_turns = sum(s["turnCount"] for p in projects for s in p["sessions"])
    size = out.stat().st_size / 1024
    print(f"已生成 {out}")
    print(f"  {len(projects)} 个项目 · {n_sessions} 个会话 · {n_turns} 轮对话 · {size:.0f} KB")

    if args.open:
        webbrowser.open(out.as_uri())


if __name__ == "__main__":
    main()
