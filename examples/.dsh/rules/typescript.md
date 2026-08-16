---
path:
  - "src/**/*.ts"
  - "!src/**/*.test.ts"
---
# TypeScript 风格规则

本仓库的 TypeScript 源码遵循以下约定：

- 优先使用 `const` 与函数声明，避免不必要的类包装。
- 公共 API 必须带有 JSDoc 注释。
- 禁止使用 `any`；无法推断的类型显式标注。
- 文件名使用 kebab-case。

当 agent 读取或编辑 `src/` 下任意 `.ts` 文件（排除 `*.test.ts`）时，本规则自动激活。
