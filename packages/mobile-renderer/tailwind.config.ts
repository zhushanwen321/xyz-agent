import type { Config } from 'tailwindcss'

/**
 * mobile-renderer Tailwind 配置（copy 自 renderer，content globs 改为 mobile-renderer 路径）。
 * 色值映射到 style.css 的 CSS 变量（SSOT: docs/page-design/design-tokens.md）。
 * w1 仅落骨架，w2 copy 组件后此配置保证样式 design-tokens 对齐。
 */
export default {
  content: ['./src/**/*.{vue,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--bg)',
          elevated: 'var(--bg-elevated)',
          input: 'var(--bg-input)',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
          2: 'var(--surface-2)',
        },
        fg: 'var(--fg)',
        muted: 'var(--muted)',
        subtle: 'var(--subtle)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
          ring: 'var(--accent-ring)',
          foreground: 'var(--accent-foreground)',
        },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        warning: { DEFAULT: 'var(--warning)', soft: 'var(--warning-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        reasoning: { DEFAULT: 'var(--reasoning)', soft: 'var(--reasoning-soft)' },
        diff: {
          'add-bg': 'color-mix(in oklch, var(--success) 18%, transparent)',
          'add-strong': 'color-mix(in oklch, var(--success) 45%, transparent)',
          'del-bg': 'color-mix(in oklch, var(--danger) 18%, transparent)',
          'del-strong': 'color-mix(in oklch, var(--danger) 45%, transparent)',
        },
        // ── shadcn-vue 命名空间（别名映射到 v3 值，components/ui copy 后依赖）──
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        'muted-foreground': 'var(--muted-foreground)',
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Display', 'PingFang SC', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'IBM Plex Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: '3px',
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
        glow: 'var(--shadow-glow)',
      },
    },
  },
  plugins: [],
} satisfies Config
