import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

// external 数组：标记为「不打包进 bundle」的模块。
//
// electron main 进程运行在 Node.js 环境，所有 Node 内置模块（node:*）由运行时提供，
// 必须标记为 external，否则 vite 会把它们打成空 stub，运行时 createHash / spawn 等会崩。
//
// 历史问题：external 数组手工维护，新增依赖用到新的 node: 模块时极易漏（漏掉后打包不报错、
// 运行时才炸，回归成本高）。这里改用 node:module 的 builtinModules 动态生成，自动覆盖
// 当前 Node 版本所有内置模块（含子路径如 node:stream/promises、node:stream/web）。
// builtinModules 仅返回不带前缀的模块名（如 'stream'、'fs'），需手动拼 'node:' 前缀。
const nodeExternals = [
  'electron',
  // undici：Electron 内置 Node 运行时已自带 undici（fetch 底层依赖），
  // 且本仓库把它作为根依赖安装。标记为 external 让 main bundle 运行时 require 解析
  // 已安装的 undici，而非打进 bundle——避免重复打包、减小体积，并保证 ProxyAgent 等
  // named export 在运行时可用（gateway/update-handlers 用它构造代理 dispatcher）。
  'undici',
  // builtinModules 不含 'node:' 前缀；为兼容 `import 'node:fs'` 与 `import 'fs'` 两种写法，
  // 同时映射带前缀和不带前缀两种形式。
  ...builtinModules.flatMap((m) => [m, `node:${m}`]),
]

export default defineConfig({
  build: {
    outDir: 'dist/main',
    lib: {
      entry: resolve(__dirname, 'main/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.cjs',
    },
    rollupOptions: {
      external: nodeExternals,
    },
    minify: false,
  },
})
