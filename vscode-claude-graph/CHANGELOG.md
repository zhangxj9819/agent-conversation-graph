# Change Log

All notable changes to the Claude / Codex Conversation Graph extension are
documented in this file.

## 0.4.1 - 2026-08-16

- Keep Claude Code `/compact` and automatic compaction on the existing conversation lane by
  following `compact_boundary.logicalParentUuid` across the compaction break.
- Preserve the pre-compaction ancestor chain when creating a branch from a post-compaction turn.
- Add regression coverage for the Claude Code 2.1.232 compaction transcript format.

## 0.4.0 - 2026-08-14

- Add a confirmed delete action to both Claude Code and Codex conversation trees.
- Move every session in the selected conversation lineage to the system trash instead of
  permanently unlinking files.
- Include hidden Codex subagent rollouts while keeping other conversations and workspaces intact.
- Close deleted graph panels, refresh both trees immediately, and report partial failures.

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

[0.4.1]: https://github.com/zhangxj9819/claude-conversation-graph/compare/e173724...HEAD
[0.4.0]: https://github.com/zhangxj9819/claude-conversation-graph/compare/375251a...e173724
[0.3.3]: https://github.com/zhangxj9819/claude-conversation-graph/compare/499e6b0...375251a
[0.3.2]: https://github.com/zhangxj9819/claude-conversation-graph/compare/7ad1687...499e6b0
