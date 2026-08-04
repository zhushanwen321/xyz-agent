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
    // S3-W1 coverage gate（master-spec §8.1）。基线实测 Stmts72.34/Branch61.79/Funcs69.15/Lines74.84，
    // thresholds 设基线-2~3% 留 flake 缓冲，跌破即 vitest exit 非0（CI 强制 gate，D3）。
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 72,
        statements: 70,
        branches: 59,
        functions: 67,
      },
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      exclude: [
        'src/__tests__/**',
        'src/**/*.d.ts',
        'src/mock/**',
        'src/main.ts',
      ],
    },
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@xyz-agent/shared': resolve(__dirname, '../shared/src'),
      '@xyz-agent/core': resolve(__dirname, '../core/src'),
      '@xyz-agent/ui': resolve(__dirname, '../ui/src'),
    },
  },
})
