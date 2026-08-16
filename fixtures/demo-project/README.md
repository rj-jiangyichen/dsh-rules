# Demo project for dsh-rules

打开 DSH Desktop 会话时把工作目录选到本项目（`fixtures/demo-project`），
然后读取 `src/app.ts`，即可看到 `typescript` 规则与 `# Path:` 段落激活。

规则文件：
- `.dsh/rules/typescript.md` — `path: src/**/*.ts`
- `.dsh/rules/docs.md` — `path: docs/**`
- `.dsh/rules/global.md` — 无 path，全局常驻
- `CLAUDE.md` — 内含 `# Path:` 段落（需 `includeClaudeSections: true`）
