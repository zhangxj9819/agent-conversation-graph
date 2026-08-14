# Claude 对话分支图 · VS Code 插件

把 Claude Code 的对话历史渲染成 git-graph 风格的分支图，直接开在编辑器里。

你回退到某条历史消息重新提问（`Esc Esc` 或编辑历史输入）时，对话就从那里分叉了 ——
这张图把分叉画出来，并让你并排对照同一个问题被改写成了什么样。

## 安装

```bash
npm test                      # 37 项检查，不需要开编辑器
npx @vscode/vsce package      # 产出 claude-conversation-graph-0.2.3.vsix
code --install-extension claude-conversation-graph-0.2.3.vsix
```

或者直接在这个目录按 `F5`，会拉起一个装好插件的 Extension Development Host 窗口。

## 用

活动栏里的分支图标打开「Claude 对话分支图」，树里只列出 **VS Code 当前工作区根目录**
对应的 Claude Code 对话，不会混入其他项目。同一次对话通过 `/branch` 产生的多个 session
文件会按第一条消息 UUID 合并为一个对话标识，不会在侧栏重复占位。带 `git-branch` 图标的
是**有分叉**的对话——那些才有东西可看。点一下开图。

命令面板还有：

| 命令 | 作用 |
|---|---|
| `Claude 分支图: 打开当前工作区最近的会话` | 按工作区路径自动定位 |
| `Claude 分支图: 重新扫描会话` | 清缓存重扫 |

图里：点节点看这一轮的提问原文、助手每一步动作（思考 / 回复 / 工具调用 / 返回值）、
模型、token 消耗、当时的真实 git 分支。`j` / `k` 或方向键上下移动，搜索框过滤提问。

分叉点会列出「从这里分出 N 条」，每条带 `tip/N` 标签；通向最新一轮的那条标 `HEAD`。

### 创建与继续分支

选中一个节点后，详情面板提供两个实际操作：

- **从此轮创建分支**：任意节点都可用。可选填名称，扩展会在新终端运行 Claude，复制截至
  该轮的上下文并创建新的 session ID，原会话不变。
- **从 tip/HEAD 继续**：仅分支尖端显示。把截至该尖端的上下文复制成独立 session，再在
  新终端继续，避免新消息误接到原会话当前的最新节点。

分支操作只处理 Claude 对话，不会切换 Git 分支，也不会恢复 checkpoint 对应的文件。
功能已用 Claude Code 2.1.231 验证。该版本的 `/branch` / `--fork-session` 只能从当前叶子
分支，不能接收图中历史消息的 UUID；扩展因此会在原文件旁新增一份只含所选祖先链的
JSONL，再调用 `claude --resume <新 session>`。原会话文件不会被修改或删除；若终端启动
失败，新建文件会立即回滚。

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

## 相比生成静态 HTML 的好处

- **跟着对话实时刷新**：监听 `~/.claude/projects/**/*.jsonl`，你在另一个窗口跟 Claude
  说话，图会跟着长。Claude Code 是逐行追加写的，一次回答触发很多次事件，所以做了
  500ms 去抖。
- **限定当前工作区**：侧栏和图面板都拒绝显示其他目录的会话；切换工作区或删除当前会话
  时，会关闭已经失效的旧图面板。
- **一个对话一个标识**：共享根消息 UUID 的原会话和全部分支 session 会合并成一个侧栏
  条目；打开后汇总各文件的独有轮次，重复祖先 UUID 只保留一份。
- **按需加载**：树视图只读文件元信息，选中某个会话才解析它，解析结果按 mtime + size
  缓存。全量导出成单文件 HTML 是 3.5 MB，这里不需要一次性吃进去。
- **跟随编辑器主题**：界面色全部走 `--vscode-*` 令牌。

## 结构

```
extension.js        扩展宿主：扫描、解析调度、文件监听、webview 生命周期
src/parser.js       多个同谱系 .jsonl → 去重后的轮次树
src/session-branch.js 精确复制到所选消息并创建独立 session
media/layout.js     轮次树 → 泳道布局（与仓库根的 layout.js 是同一份）
media/viewer.js     webview 渲染
test/mock-vscode.js 最小 vscode API 替身
test/smoke.js       无编辑器跑通 activate()
test/webview.js     无头 Chrome 渲染检查
```

### 为什么要先聚合成「轮次」

原始 JSONL 粒度太细：助手一次回复会被拆成若干条记录（thinking / text / 每个 tool_use
各一条），**并行工具调用还会让它们互为父子**。直接照搬 uuid 树，图上全是并行工具造成的
伪分支 —— 实测某个会话 24 个"分叉点"里，真实回退一个都没有。

所以以「真实用户提问」为锚点聚合：一次提问 + 其后的全部助手动作 = 一个 commit。

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
命令注册、树视图展开、webview 的 CSP 与 nonce、`localResourceRoots` 范围、数据投递、
去抖刷新、缓存、配置变更，以及创建/切换分支时生成的 Claude 参数。
替身只实现插件实际用到的 API —— 一旦用了没被 mock 的 API，测试立刻抛错而不是静默通过。

`test/webview.js` 把插件真正生成的 HTML 套上 VS Code 主题令牌，扔进无头 Chrome 渲染，
检查行数、连线、泳道换色、`HEAD` / `tip` 标签、详情面板。找不到 Chrome 时自动跳过。

其中一条是回归测试：**webview 被 VS Code 隐藏后会销毁重建**，扩展随即在 `ready` 时重投
数据，早期版本把这次重投误判成「切换会话」，把 `setState` 恢复出来的选中清掉了 ——
表现为每次切回标签页都丢失当前位置。把修复退回去，这条测试会失败。
