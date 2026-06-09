# Plan 02: Foundation Layer v3

> **Task 2**: Design Tokens + Theme System + i18n + taste-lint + Git Hooks + Markdown + Toast + Virtual Scroll + rAF Batching + Tool Renderer Registry + Slash Command Registry
> **Prerequisite**: Task 1 (scaffold) complete — `src/`, `src-tauri/`, `sidecar/`, `shared/` skeleton exists.
> **Based on**: plan-02-foundation.md + plan-patches.md §1 + arch-optimization-v2.md §2.2/2.4
> **Supersedes**: plan-02-foundation.md + plan-patches.md §1

---

## Goal

Install all independent foundation modules that every subsequent UI task depends on:

1. **Design Tokens** — CSS custom properties for colors, spacing, typography, radii
2. **Tailwind v3 Config** — JS config (not v4 CSS-first), colors via CSS variables
3. **Theme System** — Light/dark toggle with system-preference detection, `.dark` class
4. **i18n** — vue-i18n v10 with type-safe zh-CN / en-US translations
5. **taste-lint + Git Hooks** — ESLint custom rules + pre-commit checks
6. **Markdown Pipeline** — markdown-it + dompurify rendering utility
7. **Toast System** — vue-sonner + useToast composable
8. **Virtual Scroll** — @tanstack/vue-virtual dependency
9. **Pinia Persist** — pinia-plugin-persistedstate
10. **rAF Batching** — requestAnimationFrame batching utility for stream deltas
11. **Tool Renderer Registry** — Map<string, Component> for extensible tool rendering
12. **Slash Command Registry** — register pattern for `/` commands

---

## Verification Commands

```bash
npm run dev          # App renders, tokens applied, theme toggleable, text shows in Chinese
npm run lint         # taste-lint rules load without errors
npm run build        # vue-tsc + vite build passes
git commit --allow-empty -m "test: hooks"  # pre-commit hook fires
```

---

## Sub-Task 2A: Design Tokens

**Directory:** `src/design-system/tokens/`

### Step 2A-1: Create `src/design-system/tokens/colors.ts`

- [ ] Create color tokens file with oklch light/dark variants

```ts
// src/design-system/tokens/colors.ts

export interface ColorToken {
  light: string
  dark: string
}

export const colorTokens: Record<string, ColorToken> = {
  'bg-base': {
    light: 'oklch(97% 0.018 70)',
    dark: 'oklch(20% 0.015 50)',
  },
  surface: {
    light: 'oklch(99% 0.008 70)',
    dark: 'oklch(25% 0.015 50)',
  },
  'text-primary': {
    light: 'oklch(22% 0.02 50)',
    dark: 'oklch(92% 0.008 70)',
  },
  'text-muted': {
    light: 'oklch(50% 0.018 50)',
    dark: 'oklch(65% 0.015 50)',
  },
  border: {
    light: 'oklch(90% 0.014 70)',
    dark: 'oklch(35% 0.015 50)',
  },
  accent: {
    light: 'oklch(64% 0.13 28)',
    dark: 'oklch(68% 0.13 28)',
  },
  'accent-light': {
    light: 'oklch(92% 0.04 28)',
    dark: 'oklch(30% 0.06 28)',
  },
  success: {
    light: 'oklch(70% 0.18 145)',
    dark: 'oklch(70% 0.18 145)',
  },
  warning: {
    light: 'oklch(78% 0.15 85)',
    dark: 'oklch(78% 0.15 85)',
  },
  danger: {
    light: 'oklch(62% 0.2 25)',
    dark: 'oklch(62% 0.2 25)',
  },
}
```

### Step 2A-2: Create `src/design-system/tokens/spacing.ts`

- [ ] Create spacing scale tokens

```ts
// src/design-system/tokens/spacing.ts

export const spacingTokens: Record<string, string> = {
  'radius-lg': '12px',
  'radius-md': '8px',
  'radius-sm': '4px',
  'sidebar-width': '260px',
  'header-height': '48px',
  'statusbar-height': '32px',
}
```

### Step 2A-3: Create `src/design-system/tokens/typography.ts`

- [ ] Create typography tokens

```ts
// src/design-system/tokens/typography.ts

export const typographyTokens: Record<string, string> = {
  'font-display': "'Tiempos Headline', 'Newsreader', Georgia, serif",
  'font-body': "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  'font-mono': "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace",
}
```

### Step 2A-4: Create `src/design-system/tokens/animation.ts`

- [ ] Create animation/easing tokens

```ts
// src/design-system/tokens/animation.ts

export const animationTokens: Record<string, string> = {
  'ease-standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
}
```

### Step 2A-5: Create `src/design-system/tokens/index.ts` (aggregator only — no CSS injection)

- [ ] Create token aggregator. CSS custom properties are defined statically in `src/assets/main.css`.

```ts
// src/design-system/tokens/index.ts

/**
 * Token aggregator — re-exports all token modules.
 * CSS custom properties are defined in src/assets/main.css (Tailwind v3 approach).
 * tailwind.config.ts references these CSS variables via theme.extend.colors.
 */
export { colorTokens } from './colors'
export type { ColorToken } from './colors'
export { spacingTokens } from './spacing'
export { typographyTokens } from './typography'
export { animationTokens } from './animation'
```

### Step 2A-6: Create `tailwind.config.ts` (Tailwind v3 JS config)

- [ ] Create Tailwind v3 config at project root — colors reference CSS variables

```ts
// tailwind.config.ts
import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        'bg-base': 'var(--color-bg-base)',
        'surface': 'var(--color-surface)',
        'text-primary': 'var(--color-text-primary)',
        'text-muted': 'var(--color-text-muted)',
        'border': 'var(--color-border)',
        accent: {
          DEFAULT: 'var(--color-accent)',
          light: 'var(--color-accent-light)',
        },
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',

        // shadcn-vue standard color name aliases
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
        border: 'var(--color-border)',
      },
      fontFamily: {
        display: 'var(--font-display)',
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
        sm: 'var(--radius-sm)',
      },
    },
  },
  plugins: [],
} satisfies Config
```

### Step 2A-7: Create `src/assets/main.css` (CSS custom properties)

- [ ] Create CSS entry with all design tokens as CSS custom properties + `.dark` overrides

```css
/* src/assets/main.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* Design token colors — light */
  --color-bg-base: oklch(97% 0.018 70);
  --color-surface: oklch(99% 0.008 70);
  --color-text-primary: oklch(22% 0.02 50);
  --color-text-muted: oklch(50% 0.018 50);
  --color-border: oklch(90% 0.014 70);
  --color-accent: oklch(64% 0.13 28);
  --color-accent-light: oklch(92% 0.04 28);
  --color-success: oklch(70% 0.18 145);
  --color-warning: oklch(78% 0.15 85);
  --color-danger: oklch(62% 0.2 25);

  /* shadcn-vue aliases — light */
  --color-primary-foreground: oklch(98% 0.005 70);
  --color-destructive-foreground: oklch(98% 0.005 70);
  --color-muted: oklch(96% 0.01 70);
  --color-muted-foreground: oklch(50% 0.018 50);

  /* Typography */
  --font-display: 'Tiempos Headline', 'Newsreader', Georgia, serif;
  --font-body: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;

  /* Radii */
  --radius-lg: 12px;
  --radius-md: 8px;
  --radius-sm: 4px;

  /* Layout */
  --sidebar-width: 260px;
  --header-height: 48px;
  --statusbar-height: 32px;

  /* Animation */
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
}

.dark {
  --color-bg-base: oklch(20% 0.015 50);
  --color-surface: oklch(25% 0.015 50);
  --color-text-primary: oklch(92% 0.008 70);
  --color-text-muted: oklch(65% 0.015 50);
  --color-border: oklch(35% 0.015 50);
  --color-accent: oklch(68% 0.13 28);
  --color-accent-light: oklch(30% 0.06 28);
  --color-danger: oklch(62% 0.2 25);

  --color-primary-foreground: oklch(22% 0.02 50);
  --color-destructive-foreground: oklch(98% 0.005 70);
  --color-muted: oklch(25% 0.015 50);
  --color-muted-foreground: oklch(65% 0.015 50);
}

/* Markdown rendered content */
.prose pre {
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.75rem 1rem;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.875rem;
}

.prose code {
  font-family: var(--font-mono);
  font-size: 0.875em;
  background-color: var(--color-surface);
  padding: 0.125rem 0.25rem;
  border-radius: var(--radius-sm);
}

.prose pre code {
  background: none;
  padding: 0;
  border-radius: 0;
}

.prose blockquote {
  border-left: 3px solid var(--color-border);
  padding-left: 1rem;
  color: var(--color-text-muted);
  margin-left: 0;
}
```

### Step 2A-8: Verify tokens render

- [ ] Temporarily add a test div to `src/App.vue` to confirm Tailwind utilities work with CSS variables

```vue
<!-- Add inside <template> of App.vue for verification only -->
<div class="p-4">
  <p class="text-text-primary">Token test: text-primary</p>
  <p class="text-accent">Token test: accent</p>
  <p class="font-mono">Token test: mono font</p>
  <div class="rounded-md border border-border p-2">
    Token test: border + radius
  </div>
</div>
```

### Step 2A-9: Commit

- [ ] `git add -A && git commit -m "feat(p2): design tokens — oklch CSS variables + Tailwind v3 config"`

---

## Sub-Task 2B: Theme System

**Directory:** `src/design-system/theme/`

### Step 2B-1: Create `src/design-system/theme/useTheme.ts`

- [ ] Create theme composable. Applies theme via `.dark` class on `<html>` (matching `darkMode: 'class'`).

```ts
// src/design-system/theme/useTheme.ts
import { ref, watch, onMounted } from 'vue'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'xyz-agent-theme'

const theme = ref<Theme>('light')
let initialized = false

function getSystemPreference(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(t: Theme): void {
  if (t === 'dark') {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
}

function initTheme(): void {
  if (initialized) return
  initialized = true

  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
  if (stored === 'light' || stored === 'dark') {
    theme.value = stored
  } else {
    theme.value = getSystemPreference()
  }

  applyTheme(theme.value)

  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (e) => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        theme.value = e.matches ? 'dark' : 'light'
        applyTheme(theme.value)
      }
    })
}

watch(theme, (val) => {
  localStorage.setItem(STORAGE_KEY, val)
  applyTheme(val)
})

export function useTheme() {
  onMounted(() => initTheme())

  function toggleTheme(): void {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
  }

  function setTheme(t: Theme): void {
    theme.value = t
  }

  return { theme, toggleTheme, setTheme }
}
```

### Step 2B-2: Create `src/design-system/theme/ThemeProvider.vue`

- [ ] Create root ThemeProvider component

```vue
<!-- src/design-system/theme/ThemeProvider.vue -->
<script setup lang="ts">
import { useTheme } from './useTheme'

const { theme, toggleTheme } = useTheme()
</script>

<template>
  <slot :theme="theme" :toggle-theme="toggleTheme" />
</template>
```

### Step 2B-3: Create `src/design-system/theme/index.ts`

- [ ] Create barrel export

```ts
// src/design-system/theme/index.ts
export { default as ThemeProvider } from './ThemeProvider.vue'
export { useTheme } from './useTheme'
export type { Theme } from './useTheme'
```

### Step 2B-4: Wire ThemeProvider into `src/App.vue`

- [ ] Wrap App.vue content with ThemeProvider (verification stage)

```vue
<!-- src/App.vue (verification) -->
<script setup lang="ts">
import { ThemeProvider } from './design-system/theme'
</script>

<template>
  <ThemeProvider v-slot="{ theme, toggleTheme }">
    <div class="min-h-screen bg-bg-base text-text-primary font-body">
      <header class="flex items-center justify-between p-4">
        <h1 class="text-lg font-semibold">xyz-agent</h1>
        <button
          class="rounded-sm px-3 py-1 text-sm border border-border bg-surface text-text-primary"
          @click="toggleTheme"
        >
          {{ theme === 'light' ? 'Dark' : 'Light' }}
        </button>
      </header>
      <main class="p-4">
        <p>Theme: {{ theme }}</p>
        <p class="mt-2 text-text-muted">Foundation layer active.</p>
        <!-- Token verification -->
        <div class="p-4 mt-4">
          <p class="text-text-primary">Token test: text-primary</p>
          <p class="text-accent">Token test: accent</p>
          <p class="font-mono">Token test: mono font</p>
          <div class="rounded-md border border-border p-2">
            Token test: border + radius
          </div>
        </div>
      </main>
    </div>
  </ThemeProvider>
</template>
```

### Step 2B-5: Verify theme switching

- [ ] Run `npm run dev`, click theme toggle:
  - `.dark` class added/removed on `<html>`
  - Background and text colors change via CSS variables
  - Refresh persists selected theme
  - System preference change auto-applies when no stored preference

### Step 2B-6: Commit

- [ ] `git add -A && git commit -m "feat(p2): theme system — light/dark toggle, .dark class, localStorage persistence"`

---

## Sub-Task 2C: i18n

**Directory:** `src/i18n/`

### Step 2C-1: Install vue-i18n

- [ ] `npm install vue-i18n@^10`

### Step 2C-2: Create `src/i18n/types.ts`

- [ ] Create schema type for type-safe key autocomplete

```ts
// src/i18n/types.ts
export interface MessageSchema {
  common: {
    send: string
    cancel: string
    save: string
    delete: string
    edit: string
    confirm: string
    close: string
    retry: string
    copy: string
    copied: string
  }
  header: {
    newChat: string
    settings: string
    toggleSidebar: string
    standardView: string
    focusView: string
    toggleTheme: string
    notifications: string
  }
  sidebar: {
    sessions: string
    search: string
    noSessions: string
    today: string
    yesterday: string
    last7Days: string
    older: string
    empty: string
    newSession: string
    justNow: string
    minutesAgo: string
    hoursAgo: string
    daysAgo: string
  }
  chat: {
    placeholder: string
    thinking: string
    toolCall: string
    error: string
    rateLimit: string
    emptyState: string
    emptyTitle: string
    emptySubtitle: string
    inputPlaceholder: string
    send: string
    approve: string
    deny: string
    alwaysAllow: string
  }
  settings: {
    title: string
    language: string
    theme: string
    themeLight: string
    themeDark: string
    themeSystem: string
    providers: string
    defaultModel: string
  }
  status: {
    connected: string
    disconnected: string
    connecting: string
    sending: string
    receiving: string
    idle: string
    error: string
    reconnecting: string
  }
  statusbar: {
    standard: string
    focus: string
  }
}
```

### Step 2C-3: Create `src/i18n/locales/zh-CN.ts`

- [ ] Create Chinese translations

```ts
// src/i18n/locales/zh-CN.ts
import type { MessageSchema } from '../types'

export const zhCN: MessageSchema = {
  common: {
    send: '发送',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    confirm: '确认',
    close: '关闭',
    retry: '重试',
    copy: '复制',
    copied: '已复制',
  },
  header: {
    newChat: '新对话',
    settings: '设置',
    toggleSidebar: '切换侧边栏',
    standardView: '标准模式',
    focusView: '专注模式',
    toggleTheme: '切换主题',
    notifications: '通知',
  },
  sidebar: {
    sessions: '会话',
    search: '搜索会话...',
    noSessions: '暂无会话',
    today: '今天',
    yesterday: '昨天',
    last7Days: '最近 7 天',
    older: '更早',
    empty: '暂无会话',
    newSession: '新建会话',
    justNow: '刚刚',
    minutesAgo: '{n} 分钟前',
    hoursAgo: '{n} 小时前',
    daysAgo: '{n} 天前',
  },
  chat: {
    placeholder: '输入消息... (Enter 发送，Shift+Enter 换行)',
    thinking: '思考中...',
    toolCall: '工具调用',
    error: '发生错误',
    rateLimit: '请求过于频繁，请稍后再试',
    emptyState: '开始一段新对话',
    emptyTitle: '开始新对话',
    emptySubtitle: '输入消息与 AI 助手对话，或使用左侧面板新建会话。',
    inputPlaceholder: '输入消息… (Enter 发送, Shift+Enter 换行)',
    send: '发送',
    approve: '允许',
    deny: '拒绝',
    alwaysAllow: '始终允许',
  },
  settings: {
    title: '设置',
    language: '语言',
    theme: '主题',
    themeLight: '浅色',
    themeDark: '深色',
    themeSystem: '跟随系统',
    providers: '服务提供商',
    defaultModel: '默认模型',
  },
  status: {
    connected: '已连接',
    disconnected: '已断开',
    connecting: '连接中...',
    sending: '发送中...',
    receiving: '接收中...',
    idle: '就绪',
    error: '连接错误',
    reconnecting: '重连中...',
  },
  statusbar: {
    standard: '标准',
    focus: '专注',
  },
}
```

### Step 2C-4: Create `src/i18n/locales/en-US.ts`

- [ ] Create English translations

```ts
// src/i18n/locales/en-US.ts
import type { MessageSchema } from '../types'

export const enUS: MessageSchema = {
  common: {
    send: 'Send',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    confirm: 'Confirm',
    close: 'Close',
    retry: 'Retry',
    copy: 'Copy',
    copied: 'Copied',
  },
  header: {
    newChat: 'New Chat',
    settings: 'Settings',
    toggleSidebar: 'Toggle sidebar',
    standardView: 'Standard view',
    focusView: 'Focus view',
    toggleTheme: 'Toggle theme',
    notifications: 'Notifications',
  },
  sidebar: {
    sessions: 'Sessions',
    search: 'Search sessions...',
    noSessions: 'No sessions yet',
    today: 'Today',
    yesterday: 'Yesterday',
    last7Days: 'Last 7 Days',
    older: 'Older',
    empty: 'No sessions yet',
    newSession: 'New session',
    justNow: 'just now',
    minutesAgo: '{n}m ago',
    hoursAgo: '{n}h ago',
    daysAgo: '{n}d ago',
  },
  chat: {
    placeholder: 'Type a message... (Enter to send, Shift+Enter for new line)',
    thinking: 'Thinking...',
    toolCall: 'Tool Call',
    error: 'An error occurred',
    rateLimit: 'Rate limited, please try again later',
    emptyState: 'Start a new conversation',
    emptyTitle: 'Start a new conversation',
    emptySubtitle: 'Send a message to chat with the AI assistant, or create a new session from the sidebar.',
    inputPlaceholder: 'Type a message… (Enter to send, Shift+Enter for new line)',
    send: 'Send',
    approve: 'Approve',
    deny: 'Deny',
    alwaysAllow: 'Always Allow',
  },
  settings: {
    title: 'Settings',
    language: 'Language',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System',
    providers: 'Providers',
    defaultModel: 'Default Model',
  },
  status: {
    connected: 'Connected',
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    sending: 'Sending...',
    receiving: 'Receiving...',
    idle: 'Ready',
    error: 'Connection Error',
    reconnecting: 'Reconnecting...',
  },
  statusbar: {
    standard: 'Standard',
    focus: 'Focus',
  },
}
```

### Step 2C-5: Create `src/i18n/index.ts`

- [ ] Create vue-i18n instance with Composition API mode

```ts
// src/i18n/index.ts
import { createI18n } from 'vue-i18n'
import type { MessageSchema } from './types'
import { zhCN } from './locales/zh-CN'
import { enUS } from './locales/en-US'

export type SupportedLocale = 'zh-CN' | 'en-US'
export const messages = { 'zh-CN': zhCN, 'en-US': enUS }

const STORAGE_KEY = 'xyz-agent-locale'

function detectLocale(): SupportedLocale {
  const stored = localStorage.getItem(STORAGE_KEY) as SupportedLocale | null
  if (stored === 'zh-CN' || stored === 'en-US') return stored
  const browserLang = navigator.language
  if (browserLang.startsWith('zh')) return 'zh-CN'
  return 'en-US'
}

export const i18n = createI18n<[MessageSchema], SupportedLocale>({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en-US',
  messages,
})
```

### Step 2C-6: Register everything in `src/main.ts`

- [ ] Create final main.ts with Pinia + persist + i18n + CSS entry (no `injectTokens()`)

```ts
// src/main.ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import { messages } from './i18n'

// CSS entry — Tailwind directives + design token CSS custom properties
import './assets/main.css'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages,
})

const app = createApp(App)
app.use(pinia)
app.use(i18n)
app.mount('#app')
```

### Step 2C-7: Verify i18n

- [ ] `npm run dev` — text renders in Chinese
- [ ] `localStorage.setItem('xyz-agent-locale', 'en-US'); location.reload()` — shows English
- [ ] Fallback to English works

### Step 2C-8: Commit

- [ ] `git add -A && git commit -m "feat(p2): i18n — vue-i18n v10 with zh-CN and en-US translations"`

---

## Sub-Task 2D: taste-lint + Git Hooks

**Source:** `/Users/zhushanwen/Code/llm-simple-router/taste-lint/` and `.githooks/`

### Step 2D-1: Copy taste-lint rules

- [ ] Copy entire `taste-lint/` directory from llm-simple-router

```bash
cp -r /Users/zhushanwen/Code/llm-simple-router/taste-lint/ ./taste-lint/
```

### Step 2D-2: Adapt `taste-lint/vue.mjs` for `src/` file structure

- [ ] Update `files` glob patterns from `frontend/src/` to `src/`

### Step 2D-3: Copy and adapt `.githooks/`

- [ ] Copy githooks, update `frontend/` references to `src/`

```bash
cp -r /Users/zhushanwen/Code/llm-simple-router/.githooks/ .githooks/
rm -rf .githooks/__pycache__
```

Update all `frontend/` path references in both `install-hooks.sh` and `vue_rules_checker.py` to `src/`.

### Step 2D-4: Install ESLint dependencies

- [ ] `npm install -D eslint typescript-eslint eslint-plugin-vue`

### Step 2D-5: Create `eslint.config.mjs`

- [ ] Create ESLint config

```js
// eslint.config.mjs
import tasteConfig from './taste-lint/vue.mjs'

export default tasteConfig
```

### Step 2D-6: Update `package.json` scripts

- [ ] Ensure scripts include `lint`, `typecheck`, `prepare`

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "lint": "eslint .",
    "typecheck": "vue-tsc --noEmit",
    "prepare": "cd .githooks && ./install-hooks.sh"
  }
}
```

### Step 2D-7: Install hooks and verify

- [ ] `npm run prepare && ls -la .git/hooks/pre-commit`
- [ ] `npm run lint` — no config errors

### Step 2D-8: Commit

- [ ] `git add -A && git commit -m "feat(p2): taste-lint + git hooks — ESLint custom rules + pre-commit checks"`

---

## Sub-Task 2E: Markdown Rendering Pipeline

### Step 2E-1: Install dependencies

- [ ] `npm install markdown-it dompurify && npm install -D @types/markdown-it @types/dompurify`

### Step 2E-2: Create `src/lib/markdown.ts`

- [ ] Create markdown rendering utility

```ts
// src/lib/markdown.ts
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false,       // No raw HTML
  linkify: true,     // Auto-link URLs
  typographer: true, // Smart quotes
})

/**
 * Render markdown text to sanitized HTML.
 * P1: bold, italic, inline code, links, lists, blockquotes, code blocks.
 * No syntax highlighting (P3), no LaTeX (P3), no images (P3).
 */
export function renderMarkdown(text: string): string {
  const raw = md.render(text)
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'a', 'code', 'pre',
      'ul', 'ol', 'li', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'span',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  })
}
```

### Step 2E-3: Verify

- [ ] `import { renderMarkdown } from './lib/markdown'` compiles
- [ ] `renderMarkdown('**bold** and `code`')` produces expected sanitized HTML

### Step 2E-4: Commit

- [ ] `git add -A && git commit -m "feat(p2): markdown rendering pipeline — markdown-it + dompurify"`

---

## Sub-Task 2F: Toast Notification System

### Step 2F-1: Install vue-sonner

- [ ] `npm install vue-sonner`

### Step 2F-2: Create `src/composables/useToast.ts`

- [ ] Create toast wrapper composable

```ts
// src/composables/useToast.ts
import { toast } from 'vue-sonner'

/**
 * Toast notification wrapper.
 * Usage: useToast().success('Saved!') / error('Failed') / info('Tip')
 */
export function useToast() {
  return {
    success: (message: string) => toast.success(message),
    error: (message: string) => toast.error(message),
    info: (message: string) => toast.info(message),
    warning: (message: string) => toast.warning(message),
  }
}
```

### Step 2F-3: Commit

- [ ] `git add -A && git commit -m "feat(p2): toast system — vue-sonner + useToast composable"`

---

## Sub-Task 2G: Virtual Scroll + Pinia Persist Dependencies

### Step 2G-1: Install dependencies

- [ ] `npm install @tanstack/vue-virtual pinia pinia-plugin-persistedstate`

### Step 2G-2: Commit

- [ ] `git add -A && git commit -m "chore(p2): add @tanstack/vue-virtual, pinia, pinia-plugin-persistedstate"`

> Note: Pinia + persist registration is already in main.ts (Step 2C-6). This step installs the npm packages.

---

## Sub-Task 2H: rAF Batching Utility

> **Source**: arch-optimization-v2.md §2.2 (P0-2: rAF Batching)
> **Purpose**: Batch streaming text deltas into requestAnimationFrame flushes, reducing ~60% re-renders during streaming.

### Step 2H-1: Create `src/composables/useRafBatch.ts`

- [ ] Create rAF batching composable

```ts
// src/composables/useRafBatch.ts
import { ref, onUnmounted } from 'vue'

/**
 * RequestAnimationFrame batching for streaming text deltas.
 * Buffers incoming string fragments and flushes once per animation frame,
 * reducing reactive updates from ~100/s to ~60/s.
 *
 * Usage:
 *   const { flushed, append, reset } = useRafBatch()
 *   // On each delta:
 *   append(delta)
 *   // flushed.value accumulates the combined text
 *   // On new message:
 *   reset()
 */
export function useRafBatch() {
  let buffer = ''
  let rafId: number | null = null
  const flushed = ref('')

  function flush() {
    if (buffer.length > 0) {
      flushed.value += buffer
      buffer = ''
    }
    rafId = null
  }

  function append(delta: string) {
    buffer += delta
    if (rafId === null) {
      rafId = requestAnimationFrame(flush)
    }
  }

  function reset(value = '') {
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    buffer = ''
    flushed.value = value
  }

  onUnmounted(() => {
    if (rafId !== null) cancelAnimationFrame(rafId)
  })

  return { flushed, append, reset }
}
```

### Step 2H-2: Commit

- [ ] `git add -A && git commit -m "feat(p2): rAF batching utility — useRafBatch composable for stream delta batching"`

---

## Sub-Task 2I: Tool Renderer Registry

> **Source**: arch-optimization-v2.md §2.4 (P0-3: Tool Renderer Registry)
> **Purpose**: Map<string, Component> registry that ToolCallCard dispatches to, replacing monolithic rendering.

### Step 2I-1: Create `src/lib/tool-renderer-registry.ts`

- [ ] Create tool renderer registry

```ts
// src/lib/tool-renderer-registry.ts
import type { Component } from 'vue'

/**
 * Tool renderer registry — maps tool names to their Vue components.
 * ToolCallCard dispatches to the registered renderer.
 * Unregistered tools fall back to DefaultToolRenderer.
 *
 * Registration happens in plan-07 (chat features) when tool renderers are created.
 * This file provides the registry infrastructure.
 */

// Lazy component map — values are import() promises or already-resolved components
const registry = new Map<string, () => Promise<Component>>()
const resolvedCache = new Map<string, Component>()

/**
 * Register a tool renderer component.
 * @param toolName - tool identifier (e.g., 'bash', 'edit', 'read', 'write')
 * @param loader - async function returning the Vue component
 */
export function registerToolRenderer(toolName: string, loader: () => Promise<Component>): void {
  registry.set(toolName, loader)
}

/**
 * Get a resolved tool renderer component.
 * Returns undefined if not registered (caller uses DefaultToolRenderer).
 */
export async function getToolRenderer(toolName: string): Promise<Component | undefined> {
  // Check resolved cache
  const cached = resolvedCache.get(toolName)
  if (cached) return cached

  // Load and cache
  const loader = registry.get(toolName)
  if (!loader) return undefined

  const component = await loader()
  resolvedCache.set(toolName, component)
  return component
}

/**
 * Check if a tool has a registered renderer.
 */
export function hasToolRenderer(toolName: string): boolean {
  return registry.has(toolName)
}

/**
 * Get all registered tool names.
 */
export function getRegisteredToolNames(): string[] {
  return Array.from(registry.keys())
}
```

### Step 2I-2: Commit

- [ ] `git add -A && git commit -m "feat(p2): tool renderer registry — Map<string, Component> for extensible tool rendering"`

---

## Sub-Task 2J: Slash Command Registry

> **Source**: arch-optimization-v2.md §2.4 (P0-4: Slash Command Registry)
> **Purpose**: Register pattern for `/` commands (e.g., `/clear`, `/compact`, `/help`). SlashMenu.vue reads from this registry.

### Step 2J-1: Create `src/composables/useSlashCommands.ts`

- [ ] Create slash command registry composable

```ts
// src/composables/useSlashCommands.ts
import { ref, computed } from 'vue'

/**
 * Slash command definition.
 */
export interface SlashCommand {
  /** Command name without the leading `/` */
  name: string
  /** Short description shown in menu */
  description: string
  /** Execute the command */
  execute: (args: string) => void | Promise<void>
}

/**
 * Slash command registry — manages all registered `/` commands.
 * SlashMenu.vue reads `commands` to populate its list.
 * Commands are registered during app initialization.
 */
const commands = ref<SlashCommand[]>([])

export function useSlashCommands() {
  /**
   * Register a slash command. Idempotent — re-registering replaces.
   */
  function register(command: SlashCommand): void {
    const idx = commands.value.findIndex((c) => c.name === command.name)
    if (idx !== -1) {
      commands.value[idx] = command
    } else {
      commands.value = [...commands.value, command]
    }
  }

  /**
   * Unregister a slash command by name.
   */
  function unregister(name: string): void {
    commands.value = commands.value.filter((c) => c.name !== name)
  }

  /**
   * Find a command by name (without leading `/`).
   */
  function find(name: string): SlashCommand | undefined {
    return commands.value.find((c) => c.name === name)
  }

  /**
   * Filter commands by partial match (for search).
   */
  const filterByPrefix = computed(() => {
    return (prefix: string) =>
      commands.value.filter((c) =>
        c.name.toLowerCase().startsWith(prefix.toLowerCase()),
      )
  })

  return {
    commands,
    register,
    unregister,
    find,
    filterByPrefix,
  }
}
```

### Step 2J-2: Register built-in commands (P1: `/clear`, `/help`, `/compact`)

- [ ] Register P1 slash commands in `src/main.ts` or a dedicated init file

```ts
// src/lib/register-slash-commands.ts
import { useSlashCommands } from '../composables/useSlashCommands'

export function registerBuiltinSlashCommands(): void {
  const { register } = useSlashCommands()

  register({
    name: 'clear',
    description: 'Clear the current conversation',
    execute: () => {
      // Will be wired to chatStore.clearMessages() in plan-07
    },
  })

  register({
    name: 'compact',
    description: 'Manually trigger context compaction',
    execute: () => {
      // Will be wired to WS command in plan-05/07
    },
  })

  register({
    name: 'help',
    description: 'Show available commands',
    execute: () => {
      // Will show toast or inline help in plan-07
    },
  })
}
```

### Step 2J-3: Call registration in main.ts

- [ ] Add `registerBuiltinSlashCommands()` call in main.ts after Pinia setup

```ts
// Add to src/main.ts
import { registerBuiltinSlashCommands } from './lib/register-slash-commands'

// After app.use(pinia):
registerBuiltinSlashCommands()
```

### Step 2J-4: Commit

- [ ] `git add -A && git commit -m "feat(p2): slash command registry — useSlashCommands composable + built-in /clear /compact /help"`

---

## Sub-Task 2K: Shared Type Imports

> All type imports should use `@xyz-agent/shared` package (npm workspace).

### Step 2K-1: Verify shared workspace is configured

- [ ] Confirm `package.json` has `"workspaces": ["shared", "sidecar"]`
- [ ] Confirm `tsconfig.json` has `paths: { "@xyz-agent/shared": ["./shared/index.ts"] }` (or equivalent)

### Step 2K-2: Verify import pattern works

- [ ] Confirm `import type { Message, ToolCall } from '@xyz-agent/shared'` compiles

> Note: The actual shared type definitions are created in Task 1 (scaffold) and Task 4 (communication). Foundation layer just ensures the import path convention is established.

---

## Summary

| Sub-Task | Files Created | Key Dependencies |
|----------|--------------|------------------|
| 2A Tokens | `src/design-system/tokens/{colors,spacing,typography,animation,index}.ts`, `tailwind.config.ts`, `src/assets/main.css` | None |
| 2B Theme | `src/design-system/theme/{useTheme.ts,ThemeProvider.vue,index.ts}` | 2A |
| 2C i18n | `src/i18n/{index,types}.ts`, `src/i18n/locales/{zh-CN,en-US}.ts`, `src/main.ts` | vue-i18n |
| 2D Lint | `taste-lint/**`, `.githooks/**`, `eslint.config.mjs` | eslint, typescript-eslint, eslint-plugin-vue |
| 2E Markdown | `src/lib/markdown.ts` | markdown-it, dompurify |
| 2F Toast | `src/composables/useToast.ts` | vue-sonner |
| 2G Deps | (packages only) | @tanstack/vue-virtual, pinia, pinia-plugin-persistedstate |
| 2H rAF Batch | `src/composables/useRafBatch.ts` | None |
| 2I Tool Registry | `src/lib/tool-renderer-registry.ts` | None |
| 2J Slash Commands | `src/composables/useSlashCommands.ts`, `src/lib/register-slash-commands.ts` | None |
| 2K Shared Types | (verify import paths) | @xyz-agent/shared |

**Total new files:** ~25
**Commits:** 10 (one per sub-task)
**External deps added:** vue-i18n, markdown-it, dompurify, vue-sonner, @tanstack/vue-virtual, pinia, pinia-plugin-persistedstate, eslint, typescript-eslint, eslint-plugin-vue

---

## Integration Checklist

After completing all sub-tasks, verify:

- [ ] `npm run dev` — App shows "xyz-agent" with tokens applied, theme toggleable, text in Chinese
- [ ] `npm run lint` — ESLint runs with taste-lint rules, no config errors
- [ ] `npm run build` — vue-tsc + vite build passes
- [ ] `.git/hooks/pre-commit` exists and is executable
- [ ] Theme persists across page reloads
- [ ] `renderMarkdown('**bold**')` returns sanitized HTML
- [ ] `useRafBatch()`, `useToast()`, `useSlashCommands()` composables import cleanly
- [ ] `getToolRenderer('bash')` returns undefined (not yet registered)
- [ ] `import type { ... } from '@xyz-agent/shared'` compiles
