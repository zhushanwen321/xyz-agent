import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/__tests__/vitest-i18n-setup.ts'],
    // W1 i18n-frontend-p2：注入 VITE_MOCK=true，让 useSearch 等 mock-mode 分支在测试环境默认走 mock fixture。
    // （mock fixture 是 i18n-frontend-p2 U1 等用例的预期数据源；real 轨无 seed 数据会让 recents/suggested 全空导致断言失败。）
    env: {
      VITE_MOCK: 'true',
    },
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@xyz-agent/shared': resolve(__dirname, '../shared/src'),
    },
  },
})
