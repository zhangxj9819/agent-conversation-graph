# Claude / Codex 对话分支图 · VS Code 插件

把 Claude Code 和 OpenAI Codex 的本地对话历史渲染成 git-graph 风格的分支图，直接开在
编辑器里。插件只有一个活动栏入口；其中 Claude 与 Codex 是两个独立可折叠 View，结构类似
资源管理器里的“资源管理器 / 大纲 / 时间线”，并共用泳道布局、搜索和详情面板。

你回退到某条历史消息重新提问（`Esc Esc` 或编辑历史输入）时，对话就从那里分叉了 ——
这张图把分叉画出来，并让你并排对照同一个问题被改写成了什么样。

## 安装

```bash
npm test                      # 44 项检查，不需要开编辑器
npx @vscode/vsce package      # 产出 claude-conversation-graph-0.3.2.vsix
code --install-extension claude-conversation-graph-0.3.2.vsix --force
```

或者直接在这个目录按 `F5`，会拉起一个装好插件的 Extension Development Host 窗口。

## 用

活动栏只有一个“对话分支图”入口。打开后，侧边栏中纵向排列两个可独立折叠、移动的 View；
两棵树都只列出 **VS Code 当前工作区根目录**对应的对话，不会混入其他项目或另一个提供方：

- **Claude 对话分支图**：同一对话的多个 session 文件按根消息 UUID 合并。
- **Codex 对话分支图**：`thread/fork` 产生的多个 rollout 按 `forked_from_id` 谱系合并；子 agent thread
  不会作为用户对话重复占位。

两个 View 的标题分别是“Claude Code 会话”和“Codex 会话”；会话说明只显示轮数和分支数。
带 `git-branch` 图标的是有分叉的对话。

命令面板还有：

| 命令 | 作用 |
|---|---|
| `Claude 分支图: 打开当前工作区最近的 Claude 会话` | 只在 Claude 会话中按更新时间定位 |
| `Claude 分支图: 重新扫描 Claude 会话` | 只重扫 Claude 会话树 |
| `Codex 分支图: 打开当前工作区最近的 Codex 会话` | 只在 Codex 会话中按更新时间定位 |
| `Codex 分支图: 重新扫描 Codex 会话` | 只重扫 Codex 会话树 |

图里：点节点看这一轮的提问原文、助手每一步动作（思考 / 回复 / 工具调用 / 返回值）、
模型、token 消耗、当时的真实 git 分支。`j` / `k` 或方向键上下移动，搜索框过滤提问。

分叉点会列出「从这里分出 N 条」，每条带 `tip/N` 标签；通向最新一轮的那条标 `HEAD`。

### 创建与继续分支

选中一个节点后，详情面板提供两个实际操作：

- **Claude：从此轮创建/继续**。扩展会把截至节点的祖先链物化为独立 session，再运行
  `claude --resume <新 session>`；原 JSONL 不变。
- **Codex：从此轮创建分支**。扩展短暂启动官方 app-server，调用
  `thread/fork({ threadId, lastTurnId })`，再运行 `codex resume <新 thread>`。
- **Codex：继续 tip/HEAD**。直接运行 `codex resume <现有 thread>`，不会额外创建 fork。

所有分支操作都只处理对话上下文，不会切换 Git 分支、回滚工作区文件或恢复 checkpoint。
Claude 路径已用 Claude Code 2.1.231 验证。该版本的 `/branch` / `--fork-session` 只能从当前叶子
分支，不能接收图中历史消息的 UUID；扩展因此会在原文件旁新增一份只含所选祖先链的
JSONL，再调用 `claude --resume <新 session>`。原会话文件不会被修改或删除；若终端启动
失败，新建文件会立即回滚。

Codex 路径已用 Codex CLI 0.147.0 验证。浏览时只读 `~/.codex/sessions/**/*.jsonl`；只有点击
创建分支时才调用 app-server。插件使用稳定的 `lastTurnId` 字段，不改写 Codex rollout。

默认只显示真实提问，勾选「命令与系统事件」可放出 `/model`、`/compact`、子任务通知、
用户打断等记录。

## 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `claudeGraph.maxChars` | 2000 | 单条工具输出 / 助手回复的截断长度 |
| `claudeGraph.maxPrompt` | 20000 | 提问原文的截断长度 |
| `claudeGraph.showSystemEvents` | false | 默认是否显示命令与系统事件 |
| `claudeGraph.autoRefresh` | true | 对话写入时自动刷新 |
| `claudeGraph.claudeCommand` | claude | Claude Code 可执行文件；找不到命令时填写绝对路径 |
| `claudeGraph.codexCommand` | codex | Codex CLI 可执行文件；找不到命令时填写绝对路径 |

## 相比生成静态 HTML 的好处

- **跟着对话实时刷新**：同时监听 `~/.claude/projects/**/*.jsonl` 与
  `~/.codex/sessions/**/*.jsonl`。两个 CLI 都逐行追加，一次回答会触发多次事件，所以统一
  做 500ms 去抖。
- **限定当前工作区**：侧栏和图面板都拒绝显示其他目录的会话；切换工作区或删除当前会话
  时，会关闭已经失效的旧图面板。
- **一个对话一个标识**：Claude 以根消息 UUID、Codex 以 fork 谱系合并；打开后汇总各
  文件的独有轮次，重复祖先 ID 只保留一份。
- **按需加载**：树视图只读文件元信息，选中某个会话才解析它，解析结果按 mtime + size
  缓存。全量导出成单文件 HTML 是 3.5 MB，这里不需要一次性吃进去。
- **跟随编辑器主题**：界面色全部走 `--vscode-*` 令牌。

## 结构

```
extension.js        扩展宿主：单容器双会话 View、解析调度、文件监听、webview 生命周期
src/parser.js       Claude：多个同谱系 .jsonl → 去重后的轮次树
src/session-branch.js 精确复制到所选消息并创建独立 session
src/codex-parser.js Codex：rollout 发现、轮次解析与 fork 谱系合并
src/codex-app-server.js 官方 thread/fork(lastTurnId) 客户端
media/layout.js     轮次树 → 泳道布局（与仓库根的 layout.js 是同一份）
media/viewer.js     webview 渲染
test/mock-vscode.js 最小 vscode API 替身
test/codex-app-server.js app-server JSONL 协议与错误处理
test/smoke.js       无编辑器跑通 activate()
test/webview.js     无头 Chrome 渲染检查
```

### 为什么要先聚合成「轮次」

原始 JSONL 粒度太细：助手一次回复会被拆成若干条记录（thinking / text / 每个 tool_use
各一条），**并行工具调用还会让它们互为父子**。直接照搬 uuid 树，图上全是并行工具造成的
伪分支 —— 实测某个会话 24 个"分叉点"里，真实回退一个都没有。

所以以「真实用户提问」为锚点聚合：一次提问 + 其后的全部助手动作 = 一个 commit。

Codex 的原始记录使用 `turn_context.turn_id` 标识一轮，并把消息、推理、命令、文件变更和
工具结果拆成多条事件。插件优先读取规范化的 `item_completed`，同时兼容旧版
`response_item`；同一 fork 复制出来的祖先 `turn_id` 去重后，分支结构自然恢复。

有一处容易踩：`parentUuid` 链会穿过 `system`、`attachment`、`file-history-snapshot`
等记录类型。构图时必须把它们都放进链里（只是不显示），否则链条断裂，一堆轮次会假装
成根节点。

### 两个解析器的一致性

`src/parser.js` 是 `../claude_graph.py` 的移植。移植正是最容易发生行为漂移的地方，
已用本机全部会话逐字段比对过（47 会话 / 480 轮 / 2956 步，零差异）。

踩到过一个真实的坑：Python 的 `s[:n]` 数 **Unicode 码点**，JS 的 `String.slice` 数
**UTF-16 码元**。文本里只要出现一个星平面字符（emoji 等），两边截断就会错开一位。
`parser.js` 里的 `cut()` 就是为此存在的，别改回 `slice`。

## 测试

```bash
npm test
```

`test/smoke.js` 用一个最小的 vscode API 替身和仓库内固定 JSONL fixture 真正跑 `activate()`：
单活动栏容器内双 View 与命令注册、两棵树的提供方隔离、webview 的 CSP 与 nonce、
`localResourceRoots` 范围、数据投递、
去抖刷新、缓存、配置变更、Claude 分支物化，以及 Codex 谱系合并和分支参数。
替身只实现插件实际用到的 API —— 一旦用了没被 mock 的 API，测试立刻抛错而不是静默通过。

`test/webview.js` 把插件真正生成的 HTML 套上 VS Code 主题令牌，扔进无头 Chrome 渲染，
检查行数、连线、泳道换色、`HEAD` / `tip` 标签、详情面板。找不到 Chrome 时自动跳过。

`test/codex-app-server.js` 用受控的 JSONL server 替身确认初始化握手、`lastTurnId`、命名和
错误传播；发布前还会用隔离的临时 `CODEX_HOME` 对本机 Codex CLI 做真实 fork 验收。

其中一条是回归测试：**webview 被 VS Code 隐藏后会销毁重建**，扩展随即在 `ready` 时重投
数据，早期版本把这次重投误判成「切换会话」，把 `setState` 恢复出来的选中清掉了 ——
表现为每次切回标签页都丢失当前位置。把修复退回去，这条测试会失败。
