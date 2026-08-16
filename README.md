# dsh-rules

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH Plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

**English** | [中文](./README.zh.md)

Glob-activated rule prompts for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — a Claude Code `rules.md` / `# Path:`-style mechanism. Each rule declares glob patterns; when the agent **reads or edits** a matching file, the rule activates and its content (any prompt or markdown document) is injected into the conversation as a superseding `<rules>` snapshot.

> Works in **every DSH deployment**: desktop / web / tui / headless / custom profiles — nothing about this plugin is desktop-specific.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Rule format](#rule-format)
- [Configuration](#configuration)
- [Discoverability](#discoverability)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Features

- **Glob activation** — rules activate per file the agent touches: `**`, `*`, `?`, `{a,b}`, `[abc]`, and `!` negation (picomatch).
- **Claude Code compatible** — plain rule files (`.dsh/rules/*.md`) *and* `# Path:` sections inside `CLAUDE.md` / `AGENTS.md`.
- **Visible & durable** — active rules are injected as a user message the UI shows and the session log persists; each snapshot supersedes earlier ones, so the model always sees the current set.
- **Budget-bounded** — byte-budget rendering (32 KB default): low-priority rules are dropped first, then the last rule is truncated; content is escaped so it can never break out of the framing tags.
- **Resume-friendly** — on session resume the last snapshot and its matched files are restored from the log, preventing duplicate injection.
- **Per-session tracking** — every agent/session tracks its own touched files (subagents included); global rules (no `path:`) are always active.

## How it works

```
workspace
  .dsh/rules/*.md    ← rule definitions (frontmatter declares globs)
  ~/.dsh/rules/*.md  ← user-level rules (optional)
  CLAUDE.md          ← optional: # Path: sections (Claude Code compatible)

agent reads/edits a file (fs/observed) → record per-session touched path
  ↓ every step (agent/pre-step)
match touched paths against globs → collect active rules → render a <rules> snapshot into the conversation
```

- **Injection point**: an `agent/pre-step` waterfall listener appends a `<rules>`-framed user message; a new message is only appended when the snapshot text changes.
- **Discovery & caching**: rule sources are re-probed per step with version caching (`fs.stat().version`, or `mtimeMs:size` on the Node fallback) — edits to rule files take effect on the next step.
- **Reads**: prefer the harness `fs` service (containment-aware); fall back to Node's filesystem when no `fs` service is mounted.

## Installation

### Any DSH deployment (generic)

Published on the npm registry — `dsh plugin` installs **and activates** the plugin in one step:

```powershell
# Adjust the profile name: desktop / web / tui / headless
dsh plugin --profile desktop add dsh-rules
```

The package declares `dsh.bundle.patch`, so the reconcile pass of `dsh plugin add` appends `dsh-rules` to the profile's `dsh.profile.bundles` layer list automatically — **no manual `cordis.patch.yml` edits are needed**. Restart DSH (restart the desktop app; restart the web/headless process) and the plugin loads with the next Cordis composition.

Updates: `dsh plugin --profile desktop update dsh-rules` (or remove + add).

Installing from a local checkout (development):

```powershell
# From the repo root — activates the bundle automatically, same as the registry install
dsh plugin --profile desktop add .
```

> ⚠️ pnpm splits `add` arguments on spaces, so a repository **path containing spaces** must be installed through a no-space junction (see below).

### DSH Desktop (Windows) one-click script

```powershell
# 1. Clone this repository, then from the repo root:
node scripts\install-desktop.mjs

# 2. Restart DSH Desktop — the plugin loads with the next Cordis composition
```

The script creates a no-space junction to the repo and runs the desktop app's own `dsh plugin add` through it (pnpm splits `add` arguments on spaces, so a repository path containing spaces must go through the junction):

```powershell
# 0) Create a no-space junction to the repository (needed when the path contains spaces)
mklink /J "C:\code_repos\dsh-rules" "C:\code_repos\dsh rules plugin"

# 1) Install via the desktop's own dsh command (through the junction path)
& "C:\Program Files\DSH Desktop\DSH Desktop.exe" --expose-internals `
  "C:\Program Files\DSH Desktop\resources\app.asar.unpacked\lib\desktop-cli.js" `
  plugin --profile desktop add "C:\code_repos\dsh-rules"
```

Per-profile configuration (optional): the plugin loads with its code defaults; to customize, override the entry's `config` in `<profile>/cordis.patch.yml`:

```yaml
- id: dsh-rules
  name: dsh-rules
  config:
    includeClaudeSections: true
    projectRootMarkers: [".git", ".dsh"]
```

**Uninstall**: `node scripts\install-desktop.mjs --uninstall` (or `dsh plugin --profile desktop remove dsh-rules`), then restart the app. Installing/uninstalling never touches the DSH installation directory (`resources\app.asar.unpacked`) — only profile configuration, fully reversible.

## Rule format

### Source A: rule files (`.dsh/rules/*.md` and `~/.dsh/rules/*.md`)

```markdown
---
path:
  - "src/**/*.ts"
  - "!src/**/*.test.ts"
---
Rule body (markdown, injected verbatim when active — any prompt content works)
```

| Frontmatter field | Description |
| --- | --- |
| `path` | String or list of globs, relative to the project root, `/` separators; `!` prefixes mark exclusion patterns. **Absent or empty = always-active global rule** (active for any session in the workspace). |
| `name` | Optional; rule identity (used for same-name deduplication). Defaults to the file name without `.md`. |

### Source B: `# Path:` sections (requires `includeClaudeSections: true`)

Parses `# Path: <globs…>` headings out of `AGENTS.md` / `CLAUDE.md` (including `.local.md` variants and `~/.dsh/AGENTS.md`):

```markdown
# Project notes (content before the first heading is handled by the built-in agent-instructions baseline, not by this plugin)

# Path: src/**/*.ts, scripts/**
This section activates only when a file under src/**/*.ts or scripts/ is touched
```

- Each `# Path:` heading starts a rule that runs until the next heading (or end of file).
- Globs may be comma- or space-separated.
- Content before the first `# Path:` heading is intentionally **not** injected by this plugin — DSH's built-in `agent-instructions` already injects the full AGENTS.md/CLAUDE.md baseline.

### Precedence & deduplication

Project rules (rank 100) > user rules (rank 200) > `# Path:` sections (rank 300). Same-name rules keep the highest-priority entry; rendering order is (rank, name) — deterministic across steps.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `dshHome` | `$DSH_HOME` / `~/.dsh` | Root for user rules and `~/.dsh/AGENTS.md` |
| `projectRootMarkers` | `[".git"]` | Marker files/dirs used to find the project root by walking up |
| `ruleDirNames` | `[".dsh/rules"]` | Rule directories inside the project (relative to the project root, multiple allowed) |
| `includeUserRules` | `true` | Enable `~/.dsh/rules/*.md` |
| `includeClaudeSections` | `false` | Parse `# Path:` sections |
| `instructionFileCandidates` | `["AGENTS.md", "CLAUDE.md"]` | Candidate file names for `# Path:` sections |
| `localInstructionFileCandidates` | `["AGENTS.local.md", "CLAUDE.local.md"]` | Per-directory candidate file names |
| `maxBytes` | `32768` | Per-injection render budget (UTF-8 bytes); `<= 0` disables the plugin |
| `maxSourceBytes` | `1048576` | Per-rule source size cap; larger files are skipped |
| `maxTouchedPaths` | `512` | Touched-path cap per session (FIFO eviction) |

## Discoverability

This plugin is discoverable through the GitHub [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic — the channel recommended by the [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness) ("Community and support": *Add the `dsh-plugin` topic to your plugin repository for discoverability*). Community plugin lists and marketplaces (e.g. awesome-dsh-plugin, dsh-plugin-marketplace) scan that topic to pick up new plugins; the tag can be viewed/edited in the repository's About section.

## Limitations

- Only files **inside the project root** can activate rules; reads outside the root never trigger (avoids `../` false positives).
- The touched-path set is in-memory: after resuming a session, rules re-activate as the agent re-reads files (the previously matched list is restored from the log).
- Deployments with `includeRuntimeContext: false` are unaffected — this plugin injects its own message and does not depend on the runtime-context snapshot.
- Rules are injected as "superseding snapshot" messages; the session log retains historical snapshots, but each snapshot is the complete current set and the model follows the latest one.

## Development

```powershell
pnpm install
pnpm test        # node --test: parsing / glob matching / precedence / budget / determinism / fs fallback
```

Layout:

- `lib/index.js` — plugin entry (`name` / `Config` / `apply`): `fs/observed` touch tracking, `agent/pre-step` injection, `agent/disposed` cleanup.
- `lib/rules.js` — pure logic: frontmatter and `# Path:` parsing, glob compilation/matching, precedence merging, budget rendering.
- `lib/fs.js` — versioned discovery/reads: harness `fs` service first, Node fallback.
- `test/rules.test.mjs` — unit tests.
- `examples/.dsh/rules/` — sample rules (copy into your project to get started).
- `fixtures/demo-project/` — a ready-made project for trying the plugin out.

## License

[MIT](LICENSE)
