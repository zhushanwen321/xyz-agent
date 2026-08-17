import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// ui 包测试配置（w6 chat-ui-and-shell）。
// - happy-dom：组件渲染环境（对齐 renderer vitest）
// - self-alias：@xyz-agent/ui → src，支持包内自引用（features/chat import 同包原语）
// - shared alias：@xyz-agent/shared → ../shared/src（vitest 不走 workspace symlink）
// - i18n setup：vitest.setup.ts mock vue-i18n useI18n（ui 组件用 useI18n，测试环境需 t）
export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@xyz-agent/ui': resolve(__dirname, 'src'),
      '@xyz-agent/shared': resolve(__dirname, '../shared/src'),
      '@xyz-agent/core': resolve(__dirname, '../core/src'),
    },
  },
})
