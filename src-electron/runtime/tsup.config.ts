import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkgPath = resolve(__dirname, '../package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugin-bootstrap': 'src/services/plugin-service/plugin-bootstrap.ts',
  },
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
  noExternal: ['ws', 'semver', 'fast-glob', 'tar'],
  // platform: 'node' 已自动处理所有 node:* 内置模块，无需手动 external
  external: [],
  splitting: false,
  sourcemap: false,
  minify: false,
  define: {
    'process.env.XYZ_AGENT_VERSION': JSON.stringify(pkg.version),
  },
  // 打包后验证：检查产物存在 + 体积合理（不执行模块，避免启动 runtime）
  onSuccess: async () => {
    const { existsSync, statSync } = await import('node:fs')
    const path = await import('node:path')

    // 验证主 bundle
    const bundlePath = path.join('..', 'dist', 'runtime', 'index.cjs')
    if (!existsSync(bundlePath)) {
      throw new Error(`Runtime bundle not found: ${bundlePath}`)
    }
    const BYTES_PER_KB = 1024
    const sizeKB = Math.round(statSync(bundlePath).size / BYTES_PER_KB)
    console.log(`[tsup] Runtime bundle: ${bundlePath} (${sizeKB}KB)`)
    const MIN_BUNDLE_SIZE_KB = 100
    if (sizeKB < MIN_BUNDLE_SIZE_KB) {
      throw new Error(`Runtime bundle too small (${sizeKB}KB), likely missing dependencies`)
    }

    // 验证 Worker bootstrap（plugin-host.ts 运行时依赖）
    const bootstrapPath = path.join('..', 'dist', 'runtime', 'plugin-bootstrap.cjs')
    if (!existsSync(bootstrapPath)) {
      throw new Error(`Plugin bootstrap not found: ${bootstrapPath}`)
    }
    const bootstrapSizeKB = Math.round(statSync(bootstrapPath).size / BYTES_PER_KB)
    console.log(`[tsup] Plugin bootstrap: ${bootstrapPath} (${bootstrapSizeKB}KB)`)

    console.log('[tsup] Runtime bundle validated ✓')
  },
})
