# Plan 02: Foundation Layer

> Phase 1 rewrite — Task 2: Design Tokens + Theme System + i18n + taste-lint + Git Hooks
> Prerequisite: Task 1 (scaffold) complete — `src/`, `src-tauri/`, `sidecar/` skeleton exists.
> This task builds the foundation layer that all subsequent UI tasks depend on.

## Goal

Install four independent but complementary foundation modules:

1. **Design Tokens** — CSS custom properties for colors, spacing, typography, radii, and animation easing
2. **Theme System** — Light/dark theme toggle with system-preference detection and localStorage persistence
3. **i18n** — vue-i18n v10 with type-safe Chinese/English translations
4. **taste-lint + Git Hooks** — ESLint custom rules + pre-commit hooks copied from llm-simple-router

After this task, every subsequent UI task can reference semantic tokens, switch themes, display localized text, and is guarded by lint rules.

## Verification Commands

```bash
npm run dev          # App renders, tokens applied, theme toggleable, text shows in Chinese
npm run lint         # taste-lint rules load without errors
git commit --allow-empty -m "test: hooks"  # pre-commit hook fires
```

---

## Sub-Task 2A: Design Tokens

**Directory:** `src/design-system/tokens/`

### Step 2A-1: Create `src/design-system/tokens/colors.ts`

- [ ] Create color tokens file with oklch light/dark variants

```ts
// src/design-system/tokens/colors.ts

/**
 * Color design tokens — oklch color space.
 * Each token has a light and dark variant.
 * Values are raw strings consumed by index.ts to generate CSS custom properties.
 */

export interface ColorToken {
  light: string
  dark: string
}

export const colorTokens: Record<string, ColorToken> = {
  /* ── Background & Surface ── */
  'bg-base': {
    light: 'oklch(97% 0.018 70)',
    dark: 'oklch(20% 0.015 50)',
  },
  surface: {
    light: 'oklch(99% 0.008 70)',
    dark: 'oklch(25% 0.015 50)',
  },

  /* ── Text ── */
  'text-primary': {
    light: 'oklch(22% 0.02 50)',
    dark: 'oklch(92% 0.008 70)',
  },
  'text-muted': {
    light: 'oklch(50% 0.018 50)',
    dark: 'oklch(65% 0.015 50)',
  },

  /* ── Borders ── */
  border: {
    light: 'oklch(90% 0.014 70)',
    dark: 'oklch(35% 0.015 50)',
  },

  /* ── Accent ── */
  accent: {
    light: 'oklch(64% 0.13 28)',
    dark: 'oklch(68% 0.13 28)',
  },
  'accent-light': {
    light: 'oklch(92% 0.04 28)',
    dark: 'oklch(30% 0.06 28)',
  },

  /* ── Semantic ── */
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

/**
 * Spacing & layout design tokens.
 * Values use px for layout-critical dimensions (sidebar, header, statusbar).
 * Tailwind spacing scale (p-2, gap-4, etc.) covers general spacing.
 */

export const spacingTokens: Record<string, string> = {
  /* ── Radii ── */
  'radius-lg': '12px',
  'radius-md': '8px',
  'radius-sm': '4px',

  /* ── Layout ── */
  'sidebar-width': '260px',
  'header-height': '48px',
  'statusbar-height': '32px',
}
```

### Step 2A-3: Create `src/design-system/tokens/typography.ts`

- [ ] Create typography tokens (font families)

```ts
// src/design-system/tokens/typography.ts

/**
 * Typography design tokens — font family stacks.
 */

export const typographyTokens: Record<string, string> = {
  'font-display': "'Tiempos Headline', 'Newsreader', Georgia, serif",
  'font-body':
    "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  'font-mono':
    "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace",
}
```

### Step 2A-4: Create `src/design-system/tokens/animation.ts`

- [ ] Create animation/easing tokens

```ts
// src/design-system/tokens/animation.ts

/**
 * Animation & easing design tokens.
 */

export const animationTokens: Record<string, string> = {
  'ease-standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
}
```

### Step 2A-5: Create `src/design-system/tokens/index.ts`

- [ ] Create the aggregator that generates CSS custom properties on `:root` and `[data-theme="dark"]`

```ts
// src/design-system/tokens/index.ts

/**
 * Token aggregator — injects CSS custom properties into the document.
 *
 * Light tokens → :root
 * Dark tokens  → [data-theme="dark"]
 *
 * Import this file once in main.ts (or App.vue) to activate tokens.
 */
import { colorTokens } from './colors'
import { spacingTokens } from './spacing'
import { typographyTokens } from './typography'
import { animationTokens } from './animation'

function buildCSS(): string {
  const lightRules: string[] = []
  const darkRules: string[] = []

  // Color tokens — light on :root, dark on [data-theme="dark"]
  for (const [name, value] of Object.entries(colorTokens)) {
    lightRules.push(`  --color-${name}: ${value.light};`)
    darkRules.push(`  --color-${name}: ${value.dark};`)
  }

  // Spacing, typography, animation — only on :root (theme-independent)
  const staticRules: string[] = []
  for (const [name, value] of Object.entries(spacingTokens)) {
    staticRules.push(`  --${name}: ${value};`)
  }
  for (const [name, value] of Object.entries(typographyTokens)) {
    staticRules.push(`  --${name}: ${value};`)
  }
  for (const [name, value] of Object.entries(animationTokens)) {
    staticRules.push(`  --${name}: ${value};`)
  }

  return [
    `:root {`,
    ...lightRules,
    ...staticRules,
    `}`,
    ``,
    `[data-theme="dark"] {`,
    ...darkRules,
    `}`,
  ].join('\n')
}

let injected = false

export function injectTokens(): void {
  if (injected) return
  const style = document.createElement('style')
  style.setAttribute('data-token-styles', '')
  style.textContent = buildCSS()
  document.head.prepend(style)
  injected = true
}

// Re-export for direct access if needed
export { colorTokens } from './colors'
export { spacingTokens } from './spacing'
export { typographyTokens } from './typography'
export { animationTokens } from './animation'
```

### Step 2A-6: Register tokens in `src/main.ts`

- [ ] Import and call `injectTokens()` in main.ts (add before `app.mount()`)

Add these lines to the existing `src/main.ts`:

```ts
// Add to imports section:
import { injectTokens } from './design-system/tokens'

// Add before app.mount('#app'):
injectTokens()
```

### Step 2A-7: Verify tokens render

- [ ] Temporarily add a test div to `src/App.vue` to confirm tokens work

```vue
<!-- Add inside <template> of App.vue for verification only -->
<div class="p-4">
  <p class="text-[var(--color-text-primary)]">Token test: text-primary</p>
  <p class="text-[var(--color-accent)]">Token test: accent</p>
  <p style="font-family: var(--font-mono)">Token test: mono font</p>
  <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] p-2">
    Token test: border + radius
  </div>
</div>
```

### Step 2A-8: Commit

- [ ] `git add -A && git commit -m "feat(p2): design tokens — oklch colors, spacing, typography, animation easing"`

---

## Sub-Task 2B: Theme System

**Directory:** `src/design-system/theme/`

### Step 2B-1: Create `src/design-system/theme/useTheme.ts`

- [ ] Create the theme composable with system-preference detection and localStorage persistence

```ts
// src/design-system/theme/useTheme.ts

import { ref, watch, onMounted } from 'vue'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'xyz-agent-theme'

const theme = ref<Theme>('light')
let initialized = false

function getSystemPreference(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t)
}

function initTheme(): void {
  if (initialized) return
  initialized = true

  // 1. Read persisted preference
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
  if (stored === 'light' || stored === 'dark') {
    theme.value = stored
  } else {
    // 2. Fall back to system preference
    theme.value = getSystemPreference()
  }

  applyTheme(theme.value)

  // 3. Listen for system preference changes
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (e) => {
      // Only auto-switch if user hasn't explicitly set a preference
      if (!localStorage.getItem(STORAGE_KEY)) {
        theme.value = e.matches ? 'dark' : 'light'
        applyTheme(theme.value)
      }
    })
}

// Persist on change
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

  return {
    theme,
    toggleTheme,
    setTheme,
  }
}
```

### Step 2B-2: Create `src/design-system/theme/ThemeProvider.vue`

- [ ] Create the root ThemeProvider component

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

- [ ] Wrap App.vue content with ThemeProvider

Update `src/App.vue` to use ThemeProvider:

```vue
<!-- src/App.vue (after token test verified) -->
<script setup lang="ts">
import { injectTokens } from './design-system/tokens'
import { ThemeProvider } from './design-system/theme'

injectTokens()
</script>

<template>
  <ThemeProvider v-slot="{ theme, toggleTheme }">
    <div
      class="min-h-screen"
      :style="{
        backgroundColor: 'var(--color-bg-base)',
        color: 'var(--color-text-primary)',
        fontFamily: 'var(--font-body)',
      }"
    >
      <header class="flex items-center justify-between p-4">
        <h1 class="text-lg font-semibold">xyz-agent</h1>
        <button
          class="rounded-[var(--radius-sm)] px-3 py-1 text-sm"
          :style="{
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-text-primary)',
          }"
          @click="toggleTheme"
        >
          {{ theme === 'light' ? '🌙' : '☀️' }}
        </button>
      </header>
      <main class="p-4">
        <p>Theme: {{ theme }}</p>
        <p class="mt-2 text-[var(--color-text-muted)]">Foundation layer active.</p>
      </main>
    </div>
  </ThemeProvider>
</template>
```

### Step 2B-5: Verify theme switching

- [ ] Run `npm run dev`, click the theme toggle button, confirm:
  - `data-theme` attribute flips on `<html>`
  - Background and text colors change
  - Refresh persists the selected theme
  - System preference change auto-applies when no stored preference

### Step 2B-6: Commit

- [ ] `git add -A && git commit -m "feat(p2): theme system — light/dark toggle with system preference + localStorage"`

---

## Sub-Task 2C: i18n

**Directory:** `src/i18n/`

### Step 2C-1: Install vue-i18n

- [ ] `npm install vue-i18n@^10`

### Step 2C-2: Create `src/i18n/types.ts`

- [ ] Create the schema type for type-safe key autocomplete

```ts
// src/i18n/types.ts

/**
 * i18n message schema — defines all translation keys.
 * Used by vue-i18n for type-safe `t()` calls.
 */
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
  }
  sidebar: {
    sessions: string
    search: string
    noSessions: string
    today: string
    yesterday: string
    last7Days: string
    older: string
  }
  chat: {
    placeholder: string
    thinking: string
    toolCall: string
    error: string
    rateLimit: string
    emptyState: string
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
  },
  sidebar: {
    sessions: '会话',
    search: '搜索会话...',
    noSessions: '暂无会话',
    today: '今天',
    yesterday: '昨天',
    last7Days: '最近 7 天',
    older: '更早',
  },
  chat: {
    placeholder: '输入消息... (Enter 发送，Shift+Enter 换行)',
    thinking: '思考中...',
    toolCall: '工具调用',
    error: '发生错误',
    rateLimit: '请求过于频繁，请稍后再试',
    emptyState: '开始一段新对话',
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
  },
  sidebar: {
    sessions: 'Sessions',
    search: 'Search sessions...',
    noSessions: 'No sessions yet',
    today: 'Today',
    yesterday: 'Yesterday',
    last7Days: 'Last 7 Days',
    older: 'Older',
  },
  chat: {
    placeholder: 'Type a message... (Enter to send, Shift+Enter for new line)',
    thinking: 'Thinking...',
    toolCall: 'Tool Call',
    error: 'An error occurred',
    rateLimit: 'Rate limited, please try again later',
    emptyState: 'Start a new conversation',
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

const STORAGE_KEY = 'xyz-agent-locale'

function detectLocale(): SupportedLocale {
  const stored = localStorage.getItem(STORAGE_KEY) as SupportedLocale | null
  if (stored === 'zh-CN' || stored === 'en-US') return stored

  const browserLang = navigator.language
  if (browserLang.startsWith('zh')) return 'zh-CN'
  return 'en-US'
}

export const i18n = createI18n<[MessageSchema], SupportedLocale>({
  legacy: false, // Composition API mode
  locale: detectLocale(),
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
})

export function setLocale(locale: SupportedLocale): void {
  localStorage.setItem(STORAGE_KEY, locale)
  i18n.global.locale.value = locale
}

export function useLocale() {
  return {
    locale: i18n.global.locale,
    setLocale,
    t: i18n.global.t,
  }
}
```

### Step 2C-6: Register i18n in `src/main.ts`

- [ ] Add i18n plugin to the Vue app

Add to `src/main.ts` imports and app setup:

```ts
// Add to imports:
import { i18n } from './i18n'

// Add before app.mount('#app'):
app.use(i18n)
```

The full `src/main.ts` should now look like:

```ts
import { createApp } from 'vue'
import App from './App.vue'
import { injectTokens } from './design-system/tokens'
import { i18n } from './i18n'

injectTokens()

const app = createApp(App)
app.use(i18n)
app.mount('#app')
```

### Step 2C-7: Add i18n usage to `src/App.vue`

- [ ] Use `$t()` or `t()` in App.vue to verify translations work

Update App.vue to use i18n for visible labels:

```vue
<!-- src/App.vue — update with i18n -->
<script setup lang="ts">
import { injectTokens } from './design-system/tokens'
import { ThemeProvider } from './design-system/theme'
import { useI18n } from 'vue-i18n'

injectTokens()
const { t } = useI18n()
</script>

<template>
  <ThemeProvider v-slot="{ theme, toggleTheme }">
    <div
      class="min-h-screen"
      :style="{
        backgroundColor: 'var(--color-bg-base)',
        color: 'var(--color-text-primary)',
        fontFamily: 'var(--font-body)',
      }"
    >
      <header class="flex items-center justify-between p-4">
        <h1 class="text-lg font-semibold">xyz-agent</h1>
        <button
          class="rounded-[var(--radius-sm)] px-3 py-1 text-sm"
          :style="{
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-text-primary)',
          }"
          @click="toggleTheme"
        >
          {{ theme === 'light' ? '🌙' : '☀️' }}
        </button>
      </header>
      <main class="p-4">
        <p>{{ t('status.idle') }}</p>
        <p class="mt-2 text-[var(--color-text-muted)]">{{ t('chat.emptyState') }}</p>
      </main>
    </div>
  </ThemeProvider>
</template>
```

### Step 2C-8: Verify i18n

- [ ] Run `npm run dev`, confirm:
  - Text renders in Chinese (default for zh-CN browser)
  - Open browser console, run `localStorage.setItem('xyz-agent-locale', 'en-US'); location.reload()` to test English
  - Fallback to English works

### Step 2C-9: Commit

- [ ] `git add -A && git commit -m "feat(p2): i18n — vue-i18n v10 with zh-CN and en-US translations"`

---

## Sub-Task 2D: taste-lint + Git Hooks

**Source:** `/Users/zhushanwen/Code/llm-simple-router/taste-lint/` and `.githooks/`

### Step 2D-1: Copy taste-lint rules

- [ ] Copy the entire `taste-lint/` directory from llm-simple-router

```bash
cp -r /Users/zhushanwen/Code/llm-simple-router/taste-lint/ ./taste-lint/
```

This copies:
- `taste-lint/base.mjs` — Base TypeScript ESLint config with 5 taste rules
- `taste-lint/vue.mjs` — Vue 3 + TypeScript config extending base
- `taste-lint/rules/no-hardcoded-colors.mjs` — Bans non-semantic Tailwind colors
- `taste-lint/rules/no-magic-spacing.mjs` — Bans arbitrary spacing values (p-[17px])
- `taste-lint/rules/no-silent-catch.mjs` — Bans empty catch or console-only catch
- `taste-lint/rules/no-unsafe-object-entries.mjs` — Requires whitelist filter on Object.entries
- `taste-lint/rules/prefer-allsettled.mjs` — Prefers Promise.allSettled over Promise.all

### Step 2D-2: Adapt `taste-lint/vue.mjs` for this project's file structure

- [ ] Update the design-system token rules section to match `src/` instead of `frontend/src/`

In `taste-lint/vue.mjs`, change:

```diff
-  // 设计系统 token 规则 — 仅作用于前端源码
   {
-    files: ['frontend/src/**/*.vue'],
+    files: ['src/**/*.vue'],
     plugins: {
       taste: tastePlugin,
     },
     rules: {
       'taste/no-hardcoded-colors': 'error',
       'taste/no-magic-spacing': 'error',
     },
   },
```

### Step 2D-3: Copy .githooks

- [ ] Copy the githooks directory from llm-simple-router

```bash
cp -r /Users/zhushanwen/Code/llm-simple-router/.githooks/ .githooks/
rm -rf .githooks/__pycache__
```

This copies:
- `.githooks/install-hooks.sh` — Generates pre-commit hook with ESLint + type check + rules checker
- `.githooks/vue_rules_checker.py` — Python script checking native HTML elements, emoji, custom CSS

### Step 2D-4: Adapt `.githooks/install-hooks.sh` for this project

- [ ] Update file path references from `frontend/` to `src/`

In `.githooks/install-hooks.sh`, in the generated pre-commit hook section, change all `frontend/` references:

```diff
- FRONTEND_FILES=$(echo "$STAGED_FILES" | grep "^frontend/" || true)
+ FRONTEND_FILES=$(echo "$STAGED_FILES" | grep -E "^(src|sidecar)/" || true)

- CHANGED_VUE_TS=$(echo "$FRONTEND_FILES" | grep -E "\.(vue|ts)$" || true)
+ CHANGED_VUE_TS=$(echo "$FRONTEND_FILES" | grep -E "\.(vue|ts)$" || true)

- FIXED_FILES=$(git diff --name-only --diff-filter=M | grep "^frontend/" || true)
+ FIXED_FILES=$(git diff --name-only --diff-filter=M | grep -E "^(src|sidecar)/" || true)

- STAGED_FRONTEND_FILES=$(echo "$STAGED_FILES" | grep -E "^frontend/src/.*\.(vue|ts)$" || true)
+ STAGED_FRONTEND_FILES=$(echo "$STAGED_FILES" | grep -E "^src/.*\.(vue|ts)$" || true)

- ABSOLUTE_FILES="$ABSOLUTE_FILES $PROJECT_ROOT/$FILE"
+ ABSOLUTE_FILES="$ABSOLUTE_FILES $PROJECT_ROOT/$FILE"
```

Also update the vue-tsc section:

```diff
- rm -rf frontend/node_modules/.tmp/tsconfig.app.tsbuildinfo 2>/dev/null || true
+ rm -rf node_modules/.tmp/tsconfig.app.tsbuildinfo 2>/dev/null || true

- if ! (cd frontend && npx vue-tsc -b 2>&1); then
+ if ! (npx vue-tsc -b 2>&1); then
```

### Step 2D-5: Adapt `.githooks/vue_rules_checker.py` for this project

- [ ] Update `frontend/` path references and component whitelist

In `vue_rules_checker.py`, change:

```diff
- elif rel_path.endswith('.ts') and 'frontend/' in rel_path:
+ elif rel_path.endswith('.ts') and 'src/' in rel_path:
```

Also in `check_ts_file`:

```diff
- if '/components/ui/' in relative_path:
+ if '/components/ui/' in relative_path:
```

And in `run_all_checks`:

```diff
- elif rel_path.endswith('.ts') and 'frontend/' in rel_path:
+ elif rel_path.endswith('.ts') and 'src/' in rel_path:
```

### Step 2D-6: Install ESLint dependencies

- [ ] Install ESLint and required plugins

```bash
npm install -D eslint typescript-eslint eslint-plugin-vue
```

### Step 2D-7: Create `eslint.config.mjs`

- [ ] Create ESLint config importing from taste-lint

```js
// eslint.config.mjs
import tasteConfig from './taste-lint/vue.mjs'

export default tasteConfig
```

### Step 2D-8: Update `package.json`

- [ ] Add `prepare` script and `lint` script

Ensure `package.json` has these scripts:

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

### Step 2D-9: Run `npm run prepare` to install git hooks

- [ ] Execute the install script

```bash
npm run prepare
```

Verify the pre-commit hook is installed:
```bash
ls -la .git/hooks/pre-commit
```

### Step 2D-10: Run ESLint to verify rules load

- [ ] Run lint check

```bash
npm run lint
```

Should complete without config errors. May show warnings on existing files — that's expected.

### Step 2D-11: Test commit hook

- [ ] Make a test commit to verify the hook fires

```bash
git add -A
SKIP_TYPE_CHECK=1 git commit -m "test: verify pre-commit hook fires"
```

The hook should run ESLint checks. If it fails due to existing code, use `SKIP_FRONTEND_LINT=1` to skip just that check.

### Step 2D-12: Commit all taste-lint + hooks files

- [ ] Final commit for this sub-task

```bash
git add -A
git commit -m "feat(p2): taste-lint + git hooks — ESLint custom rules + pre-commit checks"
```

---

## Summary

| Sub-Task | Files Created | Dependencies |
|----------|--------------|-------------|
| 2A Tokens | `src/design-system/tokens/{colors,spacing,typography,animation,index}.ts` | None |
| 2B Theme | `src/design-system/theme/{useTheme.ts,ThemeProvider.vue,index.ts}` | 2A (tokens) |
| 2C i18n | `src/i18n/{index,types.ts}`, `src/i18n/locales/{zh-CN,en-US}.ts` | None |
| 2D Lint | `taste-lint/**`, `.githooks/**`, `eslint.config.mjs`, `package.json` updates | None |

**Total new files:** ~16
**Commits:** 4 (one per sub-task)
**External deps added:** `vue-i18n@^10`, `eslint`, `typescript-eslint`, `eslint-plugin-vue`

---

## Integration Checklist

After completing all 4 sub-tasks, verify:

- [ ] `npm run dev` — App shows "xyz-agent" with tokens applied, theme toggleable, text in Chinese
- [ ] `npm run lint` — ESLint runs with taste-lint rules loaded, no config errors
- [ ] `npm run build` — Builds without errors
- [ ] `.git/hooks/pre-commit` exists and is executable
- [ ] Theme persists across page reloads
- [ ] Switching locale via `localStorage.setItem('xyz-agent-locale', 'en-US')` works
