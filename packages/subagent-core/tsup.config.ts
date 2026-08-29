import { defineConfig } from 'tsup'

// D4（docs/design/subagent-core-package-extraction.md §3.3）：双形态构建——
// TS 源供 workspace 消费（main/exports 指向 src），dist 双格式供 npm 消费。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'node20',
  // D4 关键点：zsw 宿主是 CJS（node>=20），而 @xyz-agent/extension-protocol 的
  // npm dist 仅 ESM（.mjs），node 20 下 require() 加载 ESM 不可靠——
  // 运行时面仅常量的 protocol 必须 bundle 进产物（noExternal），
  // 不让它以外部 ESM 依赖形态出现在 CJS require 链上。
  // 降级路径（D4 既定）：bundle 边界出问题时改为全量 bundle 闭包内非 node 依赖。
  noExternal: ['@xyz-agent/extension-protocol'],
})
