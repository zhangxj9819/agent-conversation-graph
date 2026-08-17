# Claude / Codex 对话分支图

在 VS Code 中把 Claude Code 与 OpenAI Codex 的本地对话历史呈现为 git-graph 风格的分支图。

## 项目定位

这个扩展帮助你看清 AI 编程对话在回退、改写和继续之后形成的真实分支，并从任意历史轮次
开始新的尝试。

- **两个独立视图**：Claude Code 与 Codex 位于同一个活动栏入口，但会话列表彼此分离。
- **只看当前项目**：仅显示 VS Code 当前工作区根目录对应的对话。
- **一个对话一个标识**：自动合并同一 Claude session 谱系或 Codex fork 谱系，避免重复占位。
- **按真实轮次展示**：把一次提问及其后续回复、思考和工具调用聚合为一个图节点。
- **从历史节点分支**：支持从任意轮次创建新分支，也可以从 `HEAD` / `tip` 继续已有分支。
- **安全删除整个对话**：确认后把完整 session/fork 谱系移到系统废纸篓，可恢复且不误删其他项目。

对话读取、解析和渲染均在本地完成。只有主动创建或继续分支时，扩展才会启动对应的 CLI。
分支操作不会切换 Git 分支、回滚工作区文件或修改原始 Claude 会话；Codex 分支通过官方
app-server 的 `thread/fork` 接口创建。

## 安装

从 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=adscaboli.claude-conversation-graph)
安装，或者运行：

```bash
code --install-extension adscaboli.claude-conversation-graph
```

要求：

- VS Code 1.85 或更高版本。
- 已安装 Claude Code 和/或 Codex CLI。
- 已在当前项目目录中产生过至少一次对应的对话。

从源码构建本地 VSIX：

```bash
npm test
npx @vscode/vsce package --out conversation-graph.vsix
code --install-extension conversation-graph.vsix --force
```

## 快速开始

1. 用 VS Code 打开一个使用过 Claude Code 或 Codex 的项目目录。
2. 点击活动栏中的“对话分支图”。
3. 展开“Claude Code 会话”或“Codex 会话”，选择需要查看的对话。
4. 点击图节点查看该轮的提问、回复、思考、工具调用和工具结果。
5. 用顶部“分支”下拉框只查看 `HEAD` 或某个 `tip`；图会保留该分支到根节点的完整祖先链。
6. 选中历史节点创建新分支，或从 `HEAD` / `tip` 继续已有分支。
7. 在会话条目上点击垃圾桶，确认后将整个对话谱系移到系统废纸篓。

扩展默认只显示真实提问。需要查看 `/model`、`/compact`、用户打断等记录时，可在图中启用
“命令与系统事件”。使用 `j` / `k` 或方向键移动节点，使用搜索框过滤提问。

如果扩展宿主找不到 CLI，请在 VS Code 设置中填写对应可执行文件的绝对路径：

```text
claudeGraph.claudeCommand
claudeGraph.codexCommand
```
