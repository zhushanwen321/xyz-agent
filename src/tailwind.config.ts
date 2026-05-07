import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{vue,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg-base)',
        surface: 'var(--color-surface)',
        'text-primary': 'var(--color-text-primary)',
        'text-muted': 'var(--color-text-muted)',
        border: 'var(--color-border)',
        accent: 'var(--color-accent)',
        'accent-light': 'var(--color-accent-light)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',
        // shadcn-vue / Radix Vue standard aliases
        primary: {
          DEFAULT: 'var(--color-accent)',
          foreground: 'var(--color-primary-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--color-danger)',
          foreground: 'var(--color-destructive-foreground)',
        },
        muted: {
          DEFAULT: 'var(--color-muted)',
          foreground: 'var(--color-muted-foreground)',
        },
        background: 'var(--color-bg-base)',
        foreground: 'var(--color-text-primary)',
        ring: 'var(--color-accent)',
        input: 'var(--color-border)',
        // Note: 'border' is already defined above, but Tailwind needs it as a color too
      },
      fontFamily: {
        display: ['Tiempos Headline', 'Newsreader', 'Georgia', 'serif'],
        body: ['system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'IBM Plex Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        lg: '12px',
        md: '8px',
        sm: '4px',
      },
      spacing: {
        sidebar: '180px',
        header: '40px',
        statusbar: '28px',
      },
    },
  },
  plugins: [],
} satisfies Config
