# Demo project instructions

本文件头部内容由 DSH 内置 agent-instructions 注入（基线），
`# Path:` 段落由 dsh-rules 按 glob 激活。

# Path: src/**/*.ts, scripts/**

仅当读取或编辑 src 下 .ts 文件（或 scripts 下文件）时，本段落作为规则激活：
- 不要修改公开 API 签名。
- 提交前运行 `pnpm test`。
