import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin as EsbuildPlugin } from 'esbuild'

// XYZ_AGENT_VERSION 展示应用版本（与 electron 包一致），读 apps/electron/package.json。
// runtime 自己的 package.json version（0.4.7-beta）是包内部版本，不对外展示。
const pkgPath = resolve(__dirname, '../../apps/electron/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }

/**
 * qrcode-terminal 的 lib/main.js 用 legacy 八进制转义 `\033`（ANSI 颜色码），
 * 打包为 noExternal 时 esbuild 因 tsconfig strict 模式拒绝（strict 禁止 octal escape）。
 * 本 onLoad 插件把 `\033` 等价改写为 `\x1b`（hex escape，strict 允许），ANSI 语义不变。
 * 仅作用于 qrcode-terminal/lib 下的 .js 文件，不影响其它产物。
 */
const fixQrcodeTerminalOctal: EsbuildPlugin = {
  name: 'fix-qrcode-terminal-octal',
  setup(build) {
    build.onLoad({ filter: /qrcode-terminal[\\/]+lib[\\/]+.*\.js$/ }, async (args) => {
      const contents = readFileSync(args.path, 'utf-8')
      // \033 (octal ESC) → \x1b (hex ESC)，ANSI 转义语义完全等价
      const fixed = contents.replace(/\\033/g, '\\x1b')
      return {
        contents: fixed,
        loader: 'js',
      }
    })
  },
}

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugin-bootstrap': 'src/services/plugin-service/plugin-bootstrap.ts',
    cli: 'src/cli/index.ts',  // xyz-settings CLI 入口（打包后 packages/runtime/dist/cli.cjs）
    server: 'src/server/index.ts',  // wave4: xyz-agent-runtime server CLI 入口（打包后 packages/runtime/dist/server.cjs）
  },
  // 输出到 packages/runtime/dist（npm 发布产物自包含；Electron 通过 extraResources 拾取）
  outDir: 'dist',
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
  noExternal: ['ws', 'semver', 'fast-glob', 'tar', '@xyz-agent/shared', '@xyz-agent/extension-protocol', 'chokidar', 'qrcode-terminal', '@iarna/toml'],
  // platform: 'node' 已自动处理所有 node:* 内置模块，无需手动 external
  // node-pty 是 native module（含 .node 二进制），不能打包进 JS bundle：
  // 其 JS 入口用 node-gyp-build 动态 require prebuilds/<platform>/*.node，
  // bundle 后 __dirname 变 dist/runtime，找不到 prebuilds。
  // 保持 external，靠 electron-builder asarUnpack 解包 native binary（见 electron-builder.yml）。
  external: ['node-pty'],
  splitting: false,
  sourcemap: false,
  minify: false,
  esbuildPlugins: [fixQrcodeTerminalOctal],
  define: {
    'process.env.XYZ_AGENT_VERSION': JSON.stringify(pkg.version),
  },
  // Shebang 由源码自行管理：仅 server.cjs（npm bin 入口）的首行 `#!/usr/bin/env node`
  // 由 src/server/index.ts 提供，esbuild 保留首行 shebang。
  // 不用全局 banner：banner 会给所有 bundle（index.cjs/plugin-bootstrap.cjs/cli.cjs）加
  // shebang，而它们不是可执行文件；且与 server/index.ts 源码 shebang 叠加会产生
  // 双 shebang（第 2 行 `#!...` 是非法 JS，Node 报 SyntaxError）。
  // 打包后验证：检查产物存在 + 体积合理（不执行模块，避免启动 runtime）
  onSuccess: async () => {
    const { existsSync, statSync } = await import('node:fs')
    const path = await import('node:path')

    // 验证主 bundle（与 outDir 一致：dist）
    const bundlePath = path.join('dist', 'index.cjs')
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
    const bootstrapPath = path.join('dist', 'plugin-bootstrap.cjs')
    if (!existsSync(bootstrapPath)) {
      throw new Error(`Plugin bootstrap not found: ${bootstrapPath}`)
    }
    const bootstrapSizeKB = Math.round(statSync(bootstrapPath).size / BYTES_PER_KB)
    console.log(`[tsup] Plugin bootstrap: ${bootstrapPath} (${bootstrapSizeKB}KB)`)

    // 验证 CLI bundle（xyz-settings）
    const cliPath = path.join('dist', 'cli.cjs')
    if (!existsSync(cliPath)) {
      throw new Error(`CLI bundle not found: ${cliPath}`)
    }
    const cliSizeKB = Math.round(statSync(cliPath).size / BYTES_PER_KB)
    console.log(`[tsup] CLI bundle: ${cliPath} (${cliSizeKB}KB)`)

    // 验证 server CLI bundle（wave4: xyz-agent-runtime）
    const serverPath = path.join('dist', 'server.cjs')
    if (!existsSync(serverPath)) {
      throw new Error(`Server CLI bundle not found: ${serverPath}`)
    }
    const serverSizeKB = Math.round(statSync(serverPath).size / BYTES_PER_KB)
    console.log(`[tsup] Server CLI bundle: ${serverPath} (${serverSizeKB}KB)`)
    // Bug 4：server.cjs 体积下限校验（仿 index.cjs）。server.cjs 含 qrcode-terminal，
    // 体积通常 > index.cjs；下限取 100KB（与 index.cjs 同阈值，保守：低于此值几乎必然
    // 是 bundle 损坏/依赖缺失，如 qrcode-terminal 未打或 runtime main 未内联）。
    const MIN_SERVER_BUNDLE_SIZE_KB = 100
    if (serverSizeKB < MIN_SERVER_BUNDLE_SIZE_KB) {
      throw new Error(`Server CLI bundle too small (${serverSizeKB}KB < ${MIN_SERVER_BUNDLE_SIZE_KB}KB), likely missing dependencies`)
    }

    console.log('[tsup] Runtime bundle validated ✓')
  },
})
