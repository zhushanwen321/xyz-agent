/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // shadcn-vue 标准颜色 — CSS 变量引用
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        input: 'var(--input)',
        ring: 'var(--ring)',
        // 项目自定义颜色 — rgb 格式支持 /opacity
        base: 'rgb(10 10 11 / <alpha-value>)',
        surface: 'rgb(17 17 19 / <alpha-value>)',
        elevated: 'rgb(24 24 27 / <alpha-value>)',
        inset: 'rgb(31 31 35 / <alpha-value>)',
        ai: 'rgb(19 21 23 / <alpha-value>)',
        user: 'rgb(28 26 20 / <alpha-value>)',
        'border-default': 'rgb(39 39 42 / <alpha-value>)',
        'border-hover': 'rgb(63 63 70 / <alpha-value>)',
        tertiary: 'rgb(113 113 122 / <alpha-value>)',
        inverse: 'rgb(10 10 11 / <alpha-value>)',
        semantic: {
          green: 'rgb(34 197 94 / <alpha-value>)',
          'green-hover': 'rgb(22 163 74 / <alpha-value>)',
          'green-muted': 'rgb(34 197 94 / <alpha-value>)',
          blue: 'rgb(59 130 246 / <alpha-value>)',
          yellow: 'rgb(234 179 8 / <alpha-value>)',
          red: 'rgb(239 68 68 / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Text', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
