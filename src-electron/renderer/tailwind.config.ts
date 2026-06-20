import type { Config } from 'tailwindcss'

/**
 * xyz-agent Tailwind 配置 · v3 重建中
 *
 * Warm 旧色板已清除（ADR-0001）。冷蓝暗色 token 待 P0 基础对齐阶段填充。
 * shadcn-vue 装机时会在此基础上补全 CSS 变量映射（components.json）。
 */
export default {
  content: ['./src/**/*.{vue,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // colors / fontFamily / borderRadius / boxShadow 待 P0 按 design-tokens.md 填充
    },
  },
  plugins: [],
} satisfies Config
