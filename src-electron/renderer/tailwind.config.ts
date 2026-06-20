import type { Config } from 'tailwindcss'

/**
 * xyz-agent Tailwind 配置 · v3 冷蓝暗色（ADR-0018）
 * 色值映射到 style.css 的 CSS 变量（SSOT: docs/designs/design-tokens.md）。
 * shadcn-vue 装机会在此基础上扩展，此处只落 design-tokens 对齐项。
 */
export default {
  content: ['./src/**/*.{vue,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
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
          foreground: 'var(--accent-foreground)', // shadcn text-accent-foreground
        },
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        info: 'var(--info)',
        // reasoning 紫（draft-message-stream 思考块 / composer 思考等级专属色相）
        reasoning: 'var(--reasoning)',

        // ── shadcn-vue 命名空间（别名映射到 v3 值，不引入新色）──────────
        // 本地 components/ui（shadcn copy）依赖 shadcn 命名约定，补全 utility
        // 映射。同名冲突项维持 v3 语义不覆盖：
        //   • accent.DEFAULT = v3 主色蓝（shadcn hover 软底语义降级，ghost hover 蓝）
        //   • muted = v3 次级文字色（shadcn 背景色语义降级，bg-muted 仅用于 1px 分隔线，视觉正确）
        // 见 design-tokens.md「shadcn 命名映射」节。
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
