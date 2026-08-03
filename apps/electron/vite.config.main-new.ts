import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

// P0 coexistence spike 方案 B 实证：双 Electron 入口的独立 main 构建配置。
// 与 vite.config.main.ts 完全独立（纯新增，不改现有文件）：
// - entry 指向 main/main-new.ts（独立 main 入口骨架）
// - outDir=dist/main-new（与现有 dist/main 物理隔离，ES2）
// - external 复用 vite.config.main.ts 的 builtinModules 动态生成逻辑
//   （electron + 所有 Node 内置模块，带/不带 node: 前缀；第三方 npm 包打进 bundle）
//
// 生产形态的 electron-builder files 双份包含静态评估见
// docs/architecture/coexistence-spike-manifests/dual-entry-builder-assessment.md
const nodeExternals = [
  'electron',
  ...builtinModules.flatMap((m) => [m, `node:${m}`]),
]

export default defineConfig({
  build: {
    outDir: 'dist/main-new',
    lib: {
      entry: resolve(__dirname, 'main/main-new.ts'),
      formats: ['cjs'],
      fileName: () => 'main.cjs',
    },
    rollupOptions: {
      external: nodeExternals,
    },
    minify: false,
  },
})
