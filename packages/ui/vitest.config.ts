import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// ui 包测试：原语组件为纯组件渲染（mount + props 断言），无 i18n 依赖
// （W1 re-home 时 ListTree 已去 vue-i18n，STATUS_LABEL 硬编码中文）。
// @xyz-agent/extension-protocol 的 exports 直接指 src/index.ts，无需 alias。
export default defineConfig({
  test: {
    environment: 'happy-dom',
    // 无 setupFiles：原语组件不依赖全局 mock；如有需要后续追加。
  },
  plugins: [vue()],
})
