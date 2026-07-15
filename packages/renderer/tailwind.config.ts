import type { Config } from 'tailwindcss'

/**
 * xyz-agent Tailwind 配置 · v3 冷蓝暗色（ADR-0018）
 * 色值映射到 style.css 的 CSS 变量（SSOT: docs/page-design/design-tokens.md）。
 * shadcn-vue 装机会在此基础上扩展，此处只落 design-tokens 对齐项。
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
          ring: 'var(--accent-ring)', // inset 内描边（Card-Active/Input focus/SessionItem 激活）
          foreground: 'var(--accent-foreground)', // shadcn text-accent-foreground
        },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        warning: { DEFAULT: 'var(--warning)', soft: 'var(--warning-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        // reasoning 紫（draft-message-stream 思考块 / composer 思考等级专属色相）
        reasoning: 'var(--reasoning)',
        // ── diff 行/字符级背景（预混合色，color-mix 派生跟随 --success/--danger）──
        // 行背景中饱和(18%) + 字符级高饱和(45%)，双层亮度差锁定肉眼可辨。
        // canvas 用 bg-bg-input（暗 #1e1f24 / 亮 #f1f3f6 自动跟随主题），色块叠加其上。
        diff: {
          'add-bg': 'color-mix(in oklch, var(--success) 18%, transparent)',
          'add-strong': 'color-mix(in oklch, var(--success) 45%, transparent)',
          'del-bg': 'color-mix(in oklch, var(--danger) 18%, transparent)',
          'del-strong': 'color-mix(in oklch, var(--danger) 45%, transparent)',
        },

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
      // 状态点脉冲（SessionItem / SessionCard 共享，running=accent / waiting=warning）。
      // 原两组件各自 scoped 定义同一份 keyframes，收敛到 SSOT 避免漂移。
      keyframes: {
        'pulse-accent': {
          '0%': { 'box-shadow': '0 0 0 0 rgba(79, 142, 247, 0.5)' },
          '70%': { 'box-shadow': '0 0 0 5px rgba(79, 142, 247, 0)' },
          '100%': { 'box-shadow': '0 0 0 0 rgba(79, 142, 247, 0)' },
        },
        'pulse-warn': {
          '0%': { 'box-shadow': '0 0 0 0 rgba(245, 165, 36, 0.5)' },
          '70%': { 'box-shadow': '0 0 0 5px rgba(245, 165, 36, 0)' },
          '100%': { 'box-shadow': '0 0 0 0 rgba(245, 165, 36, 0)' },
        },
        // Composer S6 流式态呼吸 ring（steer 提交引导）
        'steer-breathe': {
          '0%, 100%': { 'box-shadow': '0 0 0 3px rgba(79, 142, 247, 0.22)' },
          '50%': { 'box-shadow': '0 0 0 4px rgba(79, 142, 247, 0.40)' },
        },
        // message-stream working-dot 脉冲（turn-meta working 态，draft .working-dot）
        'working-pulse': {
          '0%, 100%': { opacity: '1', 'box-shadow': '0 0 0 0 rgba(79, 142, 247, 0.4)' },
          '50%': { opacity: '0.55', 'box-shadow': '0 0 0 5px rgba(79, 142, 247, 0)' },
        },
        // 流式光标闪烁（turn-summary / trace-tool streaming）
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        // session status icons（方案 C 优化版 v3）
        wiggle: {
          '0%, 100%': { transform: 'rotate(-6deg)' },
          '50%': { transform: 'rotate(6deg)' },
        },
        'pulse-strong': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.65', transform: 'scale(0.92)' },
        },
        // ask-user inline overlay 入场（覆盖 composer 位置时滑入，对齐 demo v2 slideUp）
        'ask-user-slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-accent': 'pulse-accent 2s var(--ease) infinite',
        'pulse-warn': 'pulse-warn 2s var(--ease) infinite',
        'steer-breathe': 'steer-breathe 2.6s ease-in-out infinite',
        'working-pulse': 'working-pulse 1.4s ease-in-out infinite',
        blink: 'blink 1s step-end infinite',
        'ask-user-slide-up': 'ask-user-slide-up var(--duration-slow) var(--ease)',
        wiggle: 'wiggle 1.2s ease-in-out infinite',
        'pulse-strong': 'pulse-strong 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
