import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{vue,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        fg: 'var(--fg)',
        muted: 'var(--muted)',
        border: 'var(--border)',
        accent: {
          DEFAULT: 'var(--accent)',
          light: 'var(--accent-light)',
        },
        success: {
          DEFAULT: 'var(--success)',
          light: 'var(--success-light)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          light: 'var(--warning-light)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          light: 'var(--danger-light)',
        },
        agent: {
          DEFAULT: 'var(--agent)',
          light: 'var(--agent-light)',
        },
        // Keep shadcn aliases but update variable refs
        primary: { DEFAULT: 'var(--accent)', foreground: '#fff' },
        destructive: { DEFAULT: 'var(--danger)', foreground: '#fff' },
        background: 'var(--bg)',
        foreground: 'var(--fg)',
        ring: 'var(--accent)',
        input: 'var(--border)',
        'level-safe': 'var(--level-safe-bg)',
        'level-caution': 'var(--level-caution-bg)',
        'level-danger': 'var(--level-danger-bg)',
      },
      fontFamily: {
        display: ['Tiempos Headline', 'Newsreader', 'Iowan Old Style', 'Georgia', 'serif'],
        body: ['-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'IBM Plex Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '12px',
        sm: '8px',
        xs: '4px',
        lg: '12px',
        md: '8px',
        bubble: 'var(--radius-bubble)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
      },
      spacing: {
        sidebar: '240px',
        header: '48px',
        statusbar: '32px',
        drawer: '380px',
      },
      transitionTimingFunction: {
        ease: 'var(--ease)',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.15)' },
        },
        blink: {
          '50%': { opacity: '0' },
        },
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
        'thinking-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.3', transform: 'scale(0.85)' },
        },
        'pulse-bar': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 2s infinite',
        blink: 'blink 1s step-end infinite',
        spin: 'spin 0.6s linear infinite',
        'thinking-pulse': 'thinking-pulse 1.4s ease-in-out infinite',
        'pulse-bar': 'pulse-bar 1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
