import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// XYZ_AGENT_VERSION 展示应用版本（与 electron 包一致），读 apps/electron/package.json。
// runtime 自己的 package.json version（0.4.7-beta）是包内部版本，不对外展示。
const pkgPath = resolve(__dirname, '../../apps/electron/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugin-bootstrap': 'src/services/plugin-service/plugin-bootstrap.ts',
    cli: 'src/cli/index.ts',  // xyz-settings CLI 入口（打包后 dist/runtime/cli.cjs）
  },
  // 输出到 apps/electron/dist/runtime（与 main/preload dist 同级，供 electron-builder 打包）
  outDir: '../../apps/electron/dist/runtime',
  format: ['cjs'],
  platform: 'node',  // 自动将所有 Node.js 内置模块标为 external
  target: 'node24',   // 匹配 Electron 42.3.3 内置 Node 24.15.0（ELECTRON_RUN_AS_NODE 实测）
  bundle: true,
  clean: true,
  // ══════════════════════════════════════════════════════════════
  // 打包规则（违反必出 bug）
  // ──────────────────────────────────────────────────────────────
  // noExternal：纯 JS 包、无 native addon、体积合理，必须打包
  // 规则：新增 npm 依赖时必须加入此列表，否则 asar.unpacked 运行时找不到
  // 检查：scripts/validate-runtime-bundle.sh（pre-commit 自动触发）
  // ══════════════════════════════════════════════════════════════
  // @xyz-agent/shared：workspace 包（纯 TS 类型 + 工具函数），必须打包进 bundle，
  // 否则打包后 require('@xyz-agent/shared') 找不到（runtime 子进程无 node_modules）
  noExternal: ['ws', 'semver', 'fast-glob', 'tar', '@xyz-agent/shared', '@xyz-agent/extension-protocol', 'chokidar'],
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

    // 验证主 bundle（与 outDir 一致：../../apps/electron/dist/runtime）
    const bundlePath = path.join('..', '..', 'apps', 'electron', 'dist', 'runtime', 'index.cjs')
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
    const bootstrapPath = path.join('..', '..', 'apps', 'electron', 'dist', 'runtime', 'plugin-bootstrap.cjs')
    if (!existsSync(bootstrapPath)) {
      throw new Error(`Plugin bootstrap not found: ${bootstrapPath}`)
    }
    const bootstrapSizeKB = Math.round(statSync(bootstrapPath).size / BYTES_PER_KB)
    console.log(`[tsup] Plugin bootstrap: ${bootstrapPath} (${bootstrapSizeKB}KB)`)

    // 验证 CLI bundle（xyz-settings）
    const cliPath = path.join('..', '..', 'apps', 'electron', 'dist', 'runtime', 'cli.cjs')
    if (!existsSync(cliPath)) {
      throw new Error(`CLI bundle not found: ${cliPath}`)
    }
    const cliSizeKB = Math.round(statSync(cliPath).size / BYTES_PER_KB)
    console.log(`[tsup] CLI bundle: ${cliPath} (${cliSizeKB}KB)`)

    console.log('[tsup] Runtime bundle validated ✓')
  },
})
