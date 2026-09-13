# Changelog

All notable changes to this project are documented in this file.

## [0.1.3] — 2026-09-13

### Added

- UI-visible rule activation notice: each injected `<rules>` snapshot now uses the host's `notice` context form, so the DSH web UI shows a collapsed one-line row (same chrome as tool-call rows) — e.g. `dsh-rules · Active rules: typescript, docs` — with the full snapshot text behind the disclosure. Clearing the active set shows `No active rules`. No frontend changes required; the resume path (`seedFromSession`) accepts both the new `notice` form and the legacy `rules` form.

## [0.1.1] — 2026-08-29

### Fixed

- Project rules load again: the path sanitization that normalizes `ruleDirNames` (and instruction-file candidate lists) rejected every entry containing a path separator, so the built-in default `.dsh/rules` was silently filtered out and no project rule directories were ever scanned. Entries are now validated per segment instead — non-empty, without `.` / `..`, and not absolute — so multi-segment project-relative directories such as `.dsh/rules` work as documented. Dropped unsafe entries are reported through a warning rather than ignored silently.

## [0.1.0] — 2026-08-16

Initial release.

### Added

- Glob-activated rule prompts for DeepSeek Harness (DSH): rules declare glob patterns in frontmatter; when the agent reads or edits a matching file, the rule activates and its content is injected into the conversation as a superseding `<rules>` snapshot.
- Claude Code compatibility: plain rule files (`.dsh/rules/*.md`, `~/.dsh/rules/*.md`) and `# Path:` sections inside `AGENTS.md` / `CLAUDE.md` (including `.local.md` variants).
- Byte-budget rendering (32 KB default) with priority-based dropping and truncation; content escaping prevents breaking out of the framing tags.
- Per-session touched-path tracking (subagents included), resume-friendly snapshot restoration from the session log.
- Versioned rule discovery and caching: edits to rule files take effect on the next agent step.
- Standard DSH plugin bundle (`dsh.bundle` manifest with `cordis.patch.yml`) — installable via `dsh plugin --profile <name> add dsh-rules`.

[0.1.3]: https://github.com/rj-jiangyichen/dsh-rules/releases/tag/v0.1.3

[0.1.1]: https://github.com/rj-jiangyichen/dsh-rules/releases/tag/v0.1.1

[0.1.0]: https://github.com/rj-jiangyichen/dsh-rules/releases/tag/v0.1.0
