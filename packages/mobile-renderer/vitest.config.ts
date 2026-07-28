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
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@xyz-agent/shared': resolve(__dirname, '../shared/src'),
    },
  },
})
