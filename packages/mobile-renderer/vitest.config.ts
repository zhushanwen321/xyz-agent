import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// mobile-renderer Vitest 配置（对齐 renderer：happy-dom + alias @）。
// AC12: cd packages/mobile-renderer && npx vitest run 全绿。
// w2 copy i18n 后补 setupFiles（renderer 的 vitest-i18n-setup.ts 模式）。
export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: ['./src/__tests__/vitest-i18n-setup.ts'],
    // App.test.ts 用 await import('@/App.vue') 冷启动整个 app 模块树（MobileShell →
    // SessionsTab → useSidebar → 多个 stores），CI/冷启下 import + transform 可 >5s。
    // 提高单测超时到 15s 避免 flaky 超时（全量跑时 import 段最慢，见 transform/import 统计）。
    testTimeout: 15000,
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@xyz-agent/shared': resolve(__dirname, '../shared/src'),
    },
  },
})
