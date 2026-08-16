# dsh-rules

DeepSeek Harness（DSH）的 rules 插件：**通过 glob 匹配文件路径，激活对应的提示词 / markdown 文档**，对标 Claude Code 的 `rules.md` / `# Path:` 规则机制。

当会话中的 agent **读取或编辑**了某个文件，插件会找出 glob 命中该文件的规则，并把激活的规则内容作为一条"取代旧快照"的用户消息注入对话，让模型在后续步骤中始终携带当前文件对应的规则。

## 工作原理

```
项目/工作区
  .dsh/rules/*.md   ← 规则定义（frontmatter 声明 glob）
  ~/.dsh/rules/*.md ← 用户级规则（可选）
  CLAUDE.md         ← 可选：# Path: 段落（Claude Code 兼容）

agent 读取/编辑文件（fs/observed）→ 记录每会话触碰路径
  ↓ 每个 step（agent/pre-step）
按 glob 匹配触碰路径 → 收集激活规则 → 渲染成 <rules> 快照注入对话
```

- 注入点：`agent/pre-step` 瀑布监听器，注入一条带 `<rules>` 框架的用户消息；快照文本变化时才注入新消息，并声明"取代更早的 rules 快照"。
- 规则内容按字节预算（默认 32 KB）渲染：先按优先级丢弃低优先级规则，再截断最后一条规则；正文做转义，无法闭合框架标签。
- 会话恢复：从会话日志恢复最近一次注入的快照文本与已匹配文件列表，避免恢复后重复注入；未重新触碰的文件会随 agent 再次读取逐步重新激活。

## 规则格式

### 来源 A：规则文件（`.dsh/rules/*.md` 与 `~/.dsh/rules/*.md`）

```markdown
---
path:
  - "src/**/*.ts"
  - "!src/**/*.test.ts"
---
规则正文（markdown，激活时原样注入，可以是任意提示词内容）
```

| frontmatter 字段 | 说明 |
| --- | --- |
| `path` | 字符串或字符串数组；glob 相对项目根、使用 `/` 分隔符；`!` 前缀为排除模式。**缺省或为空 = 全局常驻规则**（工作区任意会话都激活）。 |
| `name` | 可选；规则标识（用于同名规则去重），缺省取文件名（去掉 `.md`）。 |

glob 语法：`*`（单段通配）、`**`（跨目录）、`?`、`{a,b}`、`[abc]`、`!` 取反（picomatch，`dot: true`）。

### 来源 B：`# Path:` 段落（需 `includeClaudeSections: true`）

从 `AGENTS.md` / `CLAUDE.md`（含 `.local.md`，以及 `~/.dsh/AGENTS.md`）中解析 `# Path: <glob…>` 标题段落：

```markdown
# 项目说明（此段之前的内容交给 agent-instructions 基线处理，本插件不注入）

# Path: src/**/*.ts, scripts/**
本段仅在触碰 src 下 .ts 或 scripts 下文件时激活
```

- 每个 `# Path:` 标题之后直到下一个标题（或文件尾）是一条规则。
- glob 支持逗号或空格分隔。
- 首个 `# Path:` 之前的内容**不**由本插件注入（DSH 内置的 `agent-instructions` 已负责注入 AGENTS.md/CLAUDE.md 基线全文）。

### 优先级与去重

项目规则（rank 100）> 用户规则（rank 200）> `# Path:` 段落（rank 300）。同名规则仅保留最高优先级者；渲染顺序按（rank, 名称）确定，保证跨 step 稳定。

## 安装

### 通用安装（任意 DSH 部署）

无需先克隆仓库，`dsh plugin` 会直接把 GitHub 上的包装进目标 profile：

```powershell
# 1) 安装包（profile 名按你的部署调整：desktop / web / tui / headless）
dsh plugin --profile desktop add "github:rj-jiangyichen/dsh-rules"

# 2) 在 <profile>/cordis.patch.yml 追加插件行
# - insert:
#     - id: dsh-rules
#       name: dsh-rules
#       config:
#         includeClaudeSections: true

# 3) 重启 DSH（桌面版重启应用；web/headless 重启进程），插件随 Cordis 组合加载
```

> 本插件尚未发布到 npm registry；发布后将可直接 `dsh plugin --profile desktop add dsh-rules`。
> 更新：代码推送到 GitHub 后，重新执行 `dsh plugin --profile desktop update dsh-rules`（或 remove 后 add）即可同步最新版本。

### DSH Desktop（Windows）一键脚本

```powershell
# 1. 克隆本仓库后，在仓库根目录执行：安装到 desktop profile 并写入 cordis.patch.yml
node scripts\install-desktop.mjs

# 2. 重启 DSH Desktop（插件在下次启动时随 Cordis 组合加载）
```

脚本等价于手动执行（注意：pnpm 会按空格拆分 `add` 参数，仓库路径含空格时必须通过无空格 junction 路径安装）：

```powershell
# 0) 为仓库创建无空格 junction（路径含空格时需要）
mklink /J "C:\code_repos\dsh-rules" "C:\code_repos\dsh rules plugin"

# 1) 用桌面自带的 dsh 命令把插件装进 profile（经 junction 路径）
& "C:\Program Files\DSH Desktop\DSH Desktop.exe" --expose-internals `
  "C:\Program Files\DSH Desktop\resources\app.asar.unpacked\lib\desktop-cli.js" `
  plugin --profile desktop add "C:\code_repos\dsh-rules"

# 2) 在 ~/.dsh/profiles/desktop/cordis.patch.yml 追加
# - insert:
#     - id: dsh-rules
#       name: dsh-rules
#       config:
#         includeClaudeSections: true
```

卸载：`node scripts\install-desktop.mjs --uninstall`，再重启应用。安装/卸载均不修改 DSH 安装目录（`resources\app.asar.unpacked`），只动 profile 配置，可随时回滚。

## 发现与收录

本插件通过 GitHub [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 被 DSH 生态发现——这是 [DeepSeek Harness 官方 README](https://github.com/deepseek-ai/deepseek-harness) "Community and support" 章节推荐的插件收录渠道（*Add the `dsh-plugin` topic to your plugin repository for discoverability*）。社区插件列表与市场（如 awesome-dsh-plugin、dsh-plugin-marketplace）据此自动扫描收录；仓库 About 栏可查看/添加该标签。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `dshHome` | `$DSH_HOME` / `~/.dsh` | 用户级规则与 `~/.dsh/AGENTS.md` 所在根目录 |
| `projectRootMarkers` | `[".git"]` | 向上寻找项目根的标记文件/目录 |
| `ruleDirNames` | `[".dsh/rules"]` | 项目内规则目录（相对项目根，可多个） |
| `includeUserRules` | `true` | 是否启用 `~/.dsh/rules/*.md` |
| `includeClaudeSections` | `false` | 是否解析 `# Path:` 段落 |
| `instructionFileCandidates` | `["AGENTS.md", "CLAUDE.md"]` | `# Path:` 段落候选文件名 |
| `localInstructionFileCandidates` | `["AGENTS.local.md", "CLAUDE.local.md"]` | 目录级候选文件名 |
| `maxBytes` | `32768` | 每次注入的渲染预算（UTF-8 字节），`<= 0` 关闭插件 |
| `maxSourceBytes` | `1048576` | 单条规则源文件大小上限，超出跳过 |
| `maxTouchedPaths` | `512` | 每会话记录的触碰路径上限（FIFO 淘汰） |

## 已知限制

- 只有**项目根内**的文件能激活规则；读取项目外文件不触发（避免 `../` 误匹配）。
- 触碰集合是内存态：恢复会话后，规则随 agent 重新读取文件逐步重新激活（已匹配文件列表会从日志恢复）。
- `includeRuntimeContext: false` 的部署不受影响（本插件注入独立消息，不依赖运行时上下文快照）。
- 规则注入为"取代旧快照"的消息流，会话日志中会保留历史快照；每个快照本身是完整集合，模型以最新快照为准。

## 开发

```powershell
pnpm install
pnpm test        # node --test，36 个用例：解析 / glob / 优先级 / 预算 / 确定性 / fs 回退
```

代码结构：

- `lib/index.js` — 插件入口（`name` / `Config` / `apply`）：`fs/observed` 触碰跟踪、`agent/pre-step` 注入、`agent/disposed` 清理。
- `lib/rules.js` — 纯函数：frontmatter 与 `# Path:` 解析、glob 编译匹配、优先级合并、预算渲染。
- `lib/fs.js` — 版本化发现/读取：优先 harness `fs` 服务，缺失时回退 Node fs。
- `test/rules.test.mjs` — 单元测试。
- `examples/.dsh/rules/` — 示例规则（可直接复制到项目使用）。
