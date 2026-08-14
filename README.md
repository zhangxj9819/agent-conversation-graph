# Conversation Graph

把 Claude Code 与 OpenAI Codex 的本地对话历史，呈现为清晰的 git-graph 风格分支图。

## 项目定位

Conversation Graph 是一个面向 AI 编程代理的本地对话可视化工具，用来解决三个问题：

- 一段对话经过回退、改写和继续后，很难看清真实的分支关系。
- 同一个对话可能分散在多个 session 或 rollout 文件中，容易在列表里重复出现。
- 想从某一轮重新尝试时，通常只能继续最新上下文，不能直观地选择历史节点。

项目提供两种使用方式：

| 方式 | 支持的数据 | 适合场景 |
|---|---|---|
| VS Code 扩展 | Claude Code、Codex | 在当前工作区中浏览、搜索并创建或继续对话分支 |
| Python 导出器 | Claude Code | 生成可离线打开的单文件 HTML 分支图 |

VS Code 扩展在同一个活动栏入口中提供 Claude Code 和 Codex 两个独立视图，只显示当前
工作区对应的对话。它会把同一谱系的文件合并为一个会话标识，并以“每轮真实提问”为图节点，
避免工具调用和系统事件产生伪分支。

对话读取、解析和渲染均在本地完成。只有主动创建或继续分支时，扩展才会启动对应的
Claude Code 或 Codex CLI；这些操作不会切换 Git 分支，也不会回滚工作区文件。
删除对话时会再次确认，并把整个对话谱系移到系统废纸篓，而不是永久删除。

## 安装

### VS Code 扩展

在 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=adscaboli.claude-conversation-graph)
安装，或运行：

```bash
code --install-extension adscaboli.claude-conversation-graph
```

要求：

- VS Code 1.85 或更高版本。
- 已安装 Claude Code 和/或 Codex CLI，并至少在目标项目中产生过一次对话。

### Python 单文件导出器

```bash
git clone https://github.com/zhangxj9819/claude-conversation-graph.git
cd claude-conversation-graph
python3 claude_graph.py --help
```

导出器只依赖 Python 3 标准库，无需安装第三方包。

## 快速开始

### 在 VS Code 中使用

1. 用 VS Code 打开一个使用过 Claude Code 或 Codex 的项目目录。
2. 点击活动栏中的“对话分支图”。
3. 在“Claude Code 会话”或“Codex 会话”中选择一个对话。
4. 点击图中的节点查看提问、回复、思考、工具调用和工具结果。
5. 选中历史节点创建新分支，或从 `HEAD` / `tip` 继续已有分支。
6. 在会话条目上点击垃圾桶，确认后将整个对话谱系移到系统废纸篓。

如果扩展找不到 CLI，可在 VS Code 设置中填写可执行文件的绝对路径：

```text
claudeGraph.claudeCommand
claudeGraph.codexCommand
```

### 导出 Claude 对话为 HTML

```bash
python3 claude_graph.py --list                  # 列出项目和会话
python3 claude_graph.py --open                  # 导出当前目录并打开
python3 claude_graph.py --project my-project    # 按项目名导出
python3 claude_graph.py --session 1fce10c5      # 按会话 ID 前缀导出
python3 claude_graph.py --all -o graph.html     # 导出全部项目
```

生成的 HTML 会内嵌对话内容、工具输出和本地路径。它适合离线查看，但在分享前请先检查并脱敏。
