import type { Config } from 'tailwindcss'

/**
 * xyz-agent Tailwind 配置 · v3 冷蓝暗色（ADR-0019）
 * 色值映射到 style.css 的 CSS 变量（SSOT: docs/page-design/design-tokens.md）。
 * shadcn-vue 装机会在此基础上扩展，此处只落 design-tokens 对齐项。
 */
export default {
  content: ['./src/**/*.{vue,ts,tsx}', '../ui/src/**/*.{vue,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--bg)',
          elevated: 'var(--bg-elevated)',
          input: 'var(--bg-input)',
          card: 'var(--bg-card)', // v6 新增：设置分组卡片
        },
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
          2: 'var(--surface-2)',
        },
        neutral: {
          fg: 'var(--neutral-fg)',
          mid: 'var(--neutral-mid)',
          dim: 'var(--neutral-dim)',
          faint: 'var(--neutral-faint)',
          ico: 'var(--neutral-ico)',
          'ico-hover': 'var(--neutral-ico-hover)',
        },
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        // v6 §4.3：hairline 0.05 弱分隔（drawer L1 栏底线 / 行分隔）。settings wave followup「hairline 语义类补映射」的映射部分。
        'border-hairline': 'var(--hairline)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
          ring: 'var(--accent-ring)', // inset 内描边（Card-Active/Input focus/SessionItem 激活）
          // v6 §3.5.1：accent 实色上的前景（深字 #1a1a1c）。与下方 foreground（shadcn 别名=neutral-fg，
          // 服务 ghost hover 蓝底）语义独立，accent 实色 badge/icon 前景必须用 fg 非 foreground。
          fg: 'var(--accent-fg)',
          foreground: 'var(--accent-foreground)', // shadcn text-accent-foreground
        },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        // reasoning 紫（draft-message-stream 思考块 / composer 思考等级专属色相）
        reasoning: { DEFAULT: 'var(--reasoning)', soft: 'var(--reasoning-soft)' },
        // ── diff 行/字符级背景（引用 style.css 新增 token，v6 §4.5 柔化 12%）──
        // 行背景中饱和(12%) + 字符级高饱和(45%)，双层亮度差锁定肉眼可辨。
        // 真值源在 style.css（--diff-* token），config 只做映射不重复定义色值。
        // canvas 用 bg-bg-input（暗 #17171a / 亮 #f1f3f6 自动跟随主题），色块叠加其上。
        diff: {
          'add-bg': 'var(--diff-add-bg)',
          'add-strong': 'var(--diff-add-strong)',
          'del-bg': 'var(--diff-del-bg)',
          'del-strong': 'var(--diff-del-strong)',
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
      // [HISTORICAL] 修复潜伏配置 bug：colors 键 'border-hairline' 生成的工具类是
      // border-border-hairline（无人使用），而代码里 10 处 border-hairline 用法从未
      // 生成过规则——一直静默落到 preflight 灰 200 兜底。borderColor.hairline 才能产出
      // .border-hairline（v6 §4.3 hairline 0.05 弱分隔语义类，2026-08-21 由 trace 左侧
      // 轨道竖线暴露并修复；既有用法边框由灰 200 回归 0.05 弱分隔的设计本意）。
      borderColor: {
        hairline: 'var(--hairline)',
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Display', 'PingFang SC', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'IBM Plex Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: '6px', // v6 升档（对应 --radius-sm）
        DEFAULT: '8px', // 按钮/卡片默认档（对应 --radius）
        md: '8px',
        lg: '12px', // 面板/弹层（对应 --radius-lg）
        card: '10px', // v6 新增：卡片容器（对应 --radius-card）
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
        glow: 'var(--shadow-glow)',
      },
      // keyframes SSOT 已迁移至 style.css 全局（v6 §5.9：只在全局定义一次；
      // pulse-accent 改用 CSS 变量派生，跟随主题，不再硬编码 rgba）。
      // 此处仅保留 animation 简写，引用全局 @keyframes 名。
      animation: {
        'pulse-accent': 'pulse-accent 2s var(--ease) infinite',
        // [chat-flow-polish] sidebar running/waiting badge 呼吸（复用全局 pulse-dot keyframes）
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
        blink: 'blink 1s step-end infinite',
        'loader-spin': 'loader-spin 1.4s linear infinite',
        'ask-user-slide-up': 'ask-user-slide-up var(--duration-slow) var(--ease)',
        'pulse-strong': 'pulse-strong 1.4s ease-in-out infinite',
        'notice-in': 'notice-in 200ms var(--ease)',
        // 品牌旋转（太极「周而复始」）：静态简写注册供 JIT 生成；TaijiLogo 用 inline
        // animation-duration 覆盖时长（default 8s，可传 prop）。motion-reduce:animate-none
        // 在 class 层覆盖 animation 简写（name 置 none），inline duration 不影响 name。
        'taiji-spin': 'taiji-spin 8s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
