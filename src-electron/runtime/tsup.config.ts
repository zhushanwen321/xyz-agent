import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: '../dist/runtime',
  format: ['cjs'],
  platform: 'node',  // 自动将所有 Node.js 内置模块标为 external
  target: 'node20',   // 匹配 Electron 33 内置 Node 20.18.x
  bundle: true,
  clean: true,
  // ══════════════════════════════════════════════════════════════
  // 打包规则（违反必出 bug）
  // ──────────────────────────────────────────────────────────────
  // noExternal：纯 JS 包、无 native addon、体积合理，必须打包
  // 规则：新增 npm 依赖时必须加入此列表，否则 asar.unpacked 运行时找不到
  // 检查：scripts/validate-runtime-bundle.sh（pre-commit 自动触发）
  // ══════════════════════════════════════════════════════════════
  noExternal: ['ws', 'semver', 'fast-glob'],
  // platform: 'node' 已自动处理所有 node:* 内置模块，无需手动 external
  external: [],
  splitting: false,
  sourcemap: false,
  minify: false,
  // 打包后验证：检查产物存在 + 体积合理（不执行模块，避免启动 sidecar）
  onSuccess: async () => {
    const { existsSync, statSync } = await import('node:fs')
    const path = await import('node:path')
    const bundlePath = path.join('..', 'dist', 'runtime', 'index.cjs')
    if (!existsSync(bundlePath)) {
      throw new Error(`Runtime bundle not found: ${bundlePath}`)
    }
    const sizeKB = Math.round(statSync(bundlePath).size / 1024)
    console.log(`[tsup] Runtime bundle: ${bundlePath} (${sizeKB}KB)`)
    if (sizeKB < 100) {
      throw new Error(`Runtime bundle too small (${sizeKB}KB), likely missing dependencies`)
    }
    console.log('[tsup] Runtime bundle validated ✓')
  },
})
