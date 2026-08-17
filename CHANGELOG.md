# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] — 2026-08-16

Initial release.

### Added

- Glob-activated rule prompts for DeepSeek Harness (DSH): rules declare glob patterns in frontmatter; when the agent reads or edits a matching file, the rule activates and its content is injected into the conversation as a superseding `<rules>` snapshot.
- Claude Code compatibility: plain rule files (`.dsh/rules/*.md`, `~/.dsh/rules/*.md`) and `# Path:` sections inside `AGENTS.md` / `CLAUDE.md` (including `.local.md` variants).
- Byte-budget rendering (32 KB default) with priority-based dropping and truncation; content escaping prevents breaking out of the framing tags.
- Per-session touched-path tracking (subagents included), resume-friendly snapshot restoration from the session log.
- Versioned rule discovery and caching: edits to rule files take effect on the next agent step.
- Standard DSH plugin bundle (`dsh.bundle` manifest with `cordis.patch.yml`) — installable via `dsh plugin --profile <name> add dsh-rules`.

[0.1.0]: https://github.com/rj-jiangyichen/dsh-rules/releases/tag/v0.1.0
