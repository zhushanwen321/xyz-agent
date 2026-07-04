import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { readFileSync } from 'fs'

// __APP_VERSION__ 展示应用版本（与 electron 包一致），读 apps/electron/package.json（单一版本源）。
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../apps/electron/package.json'), 'utf-8')) as { version: string }

export default defineConfig(({ mode }) => {
  // loadEnv 读取 renderer 目录下的 .env + 按前缀过滤；同时并入 process.env 中已存在的 VITE_ 变量
  // （E2E 构建时由 e2e/fixtures 注入 VITE_MOCK / VITE_E2E）。
  const env = { ...loadEnv(mode, __dirname, ''), ...process.env }
  // E2E 构建期注入 sample-project 绝对路径（renderer 是浏览器环境读不到 process.env / __dirname）
  const e2eSampleCwd = resolve(__dirname, '../../e2e/fixtures/sample-project')
  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // 仅在 E2E 构建时注入真实路径，否则注入空串（mock/data.ts 检测 VITE_E2E 后才使用）。
      // 用 globalThis.__X__ 形式：vite define 会替换 globalThis 属性访问（vitest 不继承 build 的 define，
      // 但 data.ts 用可选链兜底，vitest 下为 undefined → 空串，不影响测试）。
      'globalThis.__E2E_SAMPLE_PROJECT_CWD__': JSON.stringify(env.VITE_E2E === 'true' ? e2eSampleCwd : ''),
    },
    // 打包后通过 file:// 协议加载，必须用相对路径，否则 /assets/ 解析到文件系统根目录
    base: './',
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 1420,
      strictPort: true,
    },
    build: {
      target: 'esnext',
      // 产物输出到 apps/electron/renderer/dist（与 main 进程 loadFile 路径一致，
      // electron-builder files 直接包含 renderer/dist/**/*）。dev 模式不读 outDir。
      outDir: resolve(__dirname, '../../apps/electron/renderer/dist'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
        },
      },
    },
    // mermaid ~3MB，显式预构建避免 dev 首次冷启动 esbuild 重新打包时慢 + warning。
    // (shiki 同为大体积库已验证该路径无需额外 build 配置)
    optimizeDeps: {
      include: ['mermaid'],
    },
  }
})
