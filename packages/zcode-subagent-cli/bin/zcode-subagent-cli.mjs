#!/usr/bin/env node
// bin/zcode-subagent-cli.mjs
//
// zcode 引擎 CLI 入口（manifest bin）。直接运行 src/main.ts：node ≥23.6 原生
// type-stripping；workspace 依赖解析经 pnpm symlink（realpath 在 node_modules 外，
// .ts 加载不受 node_modules 剥离限制）。npm 发布形态（dist/）由 W9 打包单元接线；
// 本文件是发现器可执行检查（§2.4 bin 解析）的目标。

await import("../src/main.ts");
