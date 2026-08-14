# Change Log

All notable changes to the Claude / Codex Conversation Graph extension are
documented in this file.

## 0.3.3 - 2026-08-14

- Prepare the extension for its first Visual Studio Marketplace release under
  publisher `adscaboli`.
- Add Marketplace metadata, a PNG listing icon, license, changelog, repository,
  support links, and free pricing metadata.

## 0.3.2 - 2026-08-14

- Add Codex rollout discovery, parsing, current-workspace filtering, and fork
  lineage merging while excluding subagent threads.
- Add exact historical Codex branching through app-server
  `thread/fork(lastTurnId)` and direct continuation with `codex resume`.
- Present Claude Code and Codex as two independent, collapsible views inside one
  Conversation Graph Activity Bar container.
- Expand the automated suite to 44 checks, including provider isolation and
  cross-view branch routing.

## 0.2.3 - 2026-08-14

- Merge every Claude branch session in one lineage into one sidebar entry.
- Keep one conversation entry per session lineage and preserve branch tips.
- Limit the sidebar to the current VS Code workspace.

[0.3.3]: https://github.com/zhangxj9819/claude-conversation-graph/compare/499e6b0...HEAD
[0.3.2]: https://github.com/zhangxj9819/claude-conversation-graph/compare/7ad1687...499e6b0
