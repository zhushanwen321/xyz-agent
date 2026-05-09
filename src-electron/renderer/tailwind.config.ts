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
        // Keep shadcn aliases but update variable refs
        primary: { DEFAULT: 'var(--accent)', foreground: '#fff' },
        destructive: { DEFAULT: 'var(--danger)', foreground: '#fff' },
        background: 'var(--bg)',
        foreground: 'var(--fg)',
        ring: 'var(--accent)',
        input: 'var(--border)',
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
      },
      spacing: {
        sidebar: '240px',
        header: '48px',
        statusbar: '32px',
        drawer: '380px',
      },
    },
  },
  plugins: [],
} satisfies Config
