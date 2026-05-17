import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  test: {
  environment: 'happy-dom',
  },
  plugins: [vue()],
  resolve: {
  alias: {
    '@': resolve(__dirname, 'src'),
    '@xyz-agent/shared': resolve(__dirname, '../shared/src'),
  },
  },
})
