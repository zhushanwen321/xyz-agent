# Plan Patches: plan-02-foundation + plan-05-state-shell

**Date**: 2026-05-06 | **Based on**: spec-v2.md + review-report.md + spec-corrections.md
**Purpose**: Surgical corrections to plan-02 and plan-05 so they align with spec-v2.

---

## 1. plan-02-foundation.md Patches

### 1a. Tailwind v3 Configuration (replaces current CSS-first / JS-inject approach)

**Affected steps**: 2A-5, 2A-6, 2A-7, 2B-4

**Problem**: Plan-02 currently uses JS-based `injectTokens()` to create CSS custom properties at runtime, and the spec-corrections previously suggested Tailwind v4 `@theme` directives. Spec-v2 settles on **Tailwind CSS v3** with a JS config file. The `injectTokens()` approach, `data-theme` selector, and `@theme` directive are all wrong.

**What to change**:

#### Step 2A-5 — Replace `src/design-system/tokens/index.ts` entirely

The current `index.ts` builds a CSS string and injects it via JS. **Delete** this approach. The `tokens/` directory still exports the raw token values as TypeScript objects (single source of truth), but CSS custom properties are now defined statically in `src/assets/main.css` and consumed through `tailwind.config.ts`.

**New `src/design-system/tokens/index.ts`** (aggregator only — no CSS injection):

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

#### New file: `tailwind.config.ts`

Create at project root:

```ts
// tailwind.config.ts
import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        // Design token colors → CSS variable references
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

#### New file: `src/assets/main.css`

```css
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
```

#### Step 2A-6 — Replace `injectTokens()` registration

**Old**: Import and call `injectTokens()` in main.ts.

**New**: Import `./assets/main.css` in main.ts (standard Tailwind v3 entry). Remove `injectTokens()` call entirely.

```ts
// src/main.ts — updated
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

#### Step 2B-1 — Update `useTheme.ts`

Change theme application from `data-theme` attribute to `.dark` class (matching `darkMode: 'class'` in tailwind.config.ts):

```ts
// In useTheme.ts, replace applyTheme:
function applyTheme(t: 'light' | 'dark'): void {
  if (t === 'dark') {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
}
```

#### Step 2A-7 — Update verification div

Replace `var(--color-*)` inline styles with Tailwind utility classes:

```vue
<div class="p-4">
  <p class="text-text-primary">Token test: text-primary</p>
  <p class="text-accent">Token test: accent</p>
  <p class="font-mono">Token test: mono font</p>
  <div class="rounded-md border border-border p-2">
    Token test: border + radius
  </div>
</div>
```

---

### 1b. Markdown Rendering Pipeline (missing)

**Insert after**: Step 2D-12 (after taste-lint sub-task, before Summary)

**New sub-task 2E: Markdown Rendering Pipeline**

#### Step 2E-1: Install dependencies

```bash
npm install markdown-it dompurify
npm install -D @types/markdown-it @types/dompurify
```

#### Step 2E-2: Create `src/lib/markdown.ts`

```ts
// src/lib/markdown.ts
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false,       // No raw HTML
  linkify: true,     // Auto-link URLs
  typographer: true, // Smart quotes etc.
})

/**
 * Render markdown text to sanitized HTML.
 * Supports: bold, italic, inline code, links, lists, blockquotes, code blocks.
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

#### Step 2E-3: Add code block styles to `src/assets/main.css`

Append to the end of `src/assets/main.css`:

```css
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

#### Step 2E-4: Verify

- [ ] `import { renderMarkdown } from './lib/markdown'` compiles
- [ ] `renderMarkdown('**bold** and `code`')` produces expected HTML

#### Step 2E-5: Commit

```bash
git add -A && git commit -m "feat(p2): markdown rendering pipeline — markdown-it + dompurify"
```

---

### 1c. Toast System Setup (missing)

**Insert after**: Step 2E-5 (after markdown pipeline)

**New sub-task 2F: Toast Notification System**

#### Step 2F-1: Install vue-sonner

```bash
npm install vue-sonner
```

#### Step 2F-2: Add Toaster to App.vue

In the verification App.vue (Step 2B-4), add Toaster inside the root div:

```vue
<script setup lang="ts">
import { Toaster } from 'vue-sonner'
// ... other imports
</script>

<template>
  <ThemeProvider v-slot="{ theme, toggleTheme }">
    <Toaster position="top-right" :theme="theme === 'dark' ? 'dark' : 'light'" />
    <div class="min-h-screen bg-bg-base text-text-primary font-body">
      <!-- ... existing content ... -->
    </div>
  </ThemeProvider>
</template>
```

#### Step 2F-3: Create `src/composables/useToast.ts`

```ts
// src/composables/useToast.ts
import { toast } from 'vue-sonner'

/**
 * Toast notification wrapper.
 * Uses vue-sonner under the hood.
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

#### Step 2F-4: Commit

```bash
git add -A && git commit -m "feat(p2): toast system — vue-sonner integration + useToast composable"
```

---

### 1d. Virtual Scroll Setup (missing)

**Insert after**: Step 2F-4

**New sub-task 2G: Virtual Scroll Dependency**

#### Step 2G-1: Install @tanstack/vue-virtual

```bash
npm install @tanstack/vue-virtual
```

#### Step 2G-2: Commit

```bash
git add -A && git commit -m "chore(p2): add @tanstack/vue-virtual dependency"
```

> Note: Actual usage is in plan-05 (SessionGroup.vue) and plan-07 (MessageList.vue). This step just installs the dependency.

---

### 1e. Pinia Persist Plugin (missing)

**Affected step**: Step 2A-6 / Step 2C-6 (main.ts registration)

**Problem**: Plan-02's main.ts does not register Pinia or the persist plugin. This must happen here since it's the foundation layer.

**What to change**: The corrected main.ts from patch 1a already includes Pinia + persist registration. Confirm these lines are present:

```ts
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)
// ...
app.use(pinia)
```

Also install the dependency:

```bash
npm install pinia pinia-plugin-persistedstate
```

> Note: This install is listed in plan-05 Step 1. Move it here to the foundation layer.

---

### 1f. Shared Types Import Path

**Affected steps**: All code examples in plan-02 that reference `@/types/protocol` or `@/types/message`.

**Problem**: spec-v2 defines `shared/` as an npm workspace package (`@xyz-agent/shared`). All type imports should use this path.

**What to change**: Plan-02 does not directly import from `@/types/protocol` (it's a foundation layer), but if any verification code or token files reference shared types, update to:

```ts
// Old:
import type { ... } from '@/types/protocol'
// New:
import type { ... } from '@xyz-agent/shared'
```

> Note: The actual import path may be `@xyz-agent/shared/types` or `@xyz-agent/shared/protocol` depending on how the `shared/` package.json exports are configured. Follow the convention established in plan-01 (scaffold).

---

## 2. plan-05-state-shell.md Patches

### 2a. View Switching Mechanism (missing)

**Affected step**: Step 14 (App.vue)

**Problem**: Plan-05's App.vue uses local `showSettings` ref and `sidebarCollapsed` ref for view management. Spec-v2 requires the `useSettingsStore` to own `currentView` and `focusMode` state — these are the single source of truth, persisted where appropriate.

**What to change in Step 14 — `src/App.vue`**:

Replace the entire App.vue with a state-driven version:

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { Toaster } from 'vue-sonner'
import { ThemeProvider } from './design-system/theme'
import { useSettingsStore } from './stores/settings'
import { useI18n } from 'vue-i18n'
import AppHeader from './components/layout/AppHeader.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppStatusbar from './components/layout/AppStatusbar.vue'
import ChatView from './components/chat/ChatView.vue'

const settingsStore = useSettingsStore()
const { t } = useI18n()

// ── Keyboard shortcuts (P1: frontend keydown) ──
function handleKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey

  // Cmd+1 → standard mode
  if (mod && e.key === '1') {
    e.preventDefault()
    settingsStore.focusMode = false
  }
  // Cmd+3 → focus mode
  if (mod && e.key === '3') {
    e.preventDefault()
    settingsStore.focusMode = true
  }
  // Escape → exit settings or cancel generation
  if (e.key === 'Escape' && settingsStore.currentView === 'settings') {
    settingsStore.currentView = 'chat'
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <ThemeProvider>
    <Toaster position="top-right" />
    <div class="flex flex-col h-screen bg-bg-base text-text-primary font-body overflow-hidden">
      <!-- Header — hidden in focus mode -->
      <AppHeader
        v-if="!settingsStore.focusMode"
        @open-settings="settingsStore.currentView = 'settings'"
      />

      <!-- Main content area -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Sidebar — only in chat view + standard mode -->
        <AppSidebar
          v-if="settingsStore.currentView === 'chat' && !settingsStore.focusMode"
          @new-session="() => {}"
          @select-session="() => {}"
        />

        <!-- Chat view -->
        <ChatView v-if="settingsStore.currentView === 'chat'" />

        <!-- Settings view (full-screen overlay, replaces chat) -->
        <div
          v-if="settingsStore.currentView === 'settings'"
          class="flex-1 flex items-center justify-center bg-bg-base"
        >
          <div class="text-center">
            <h2 class="text-lg font-medium text-text-primary mb-2">
              {{ t('settings.title') }}
            </h2>
            <p class="text-sm text-text-muted mb-4">Task 9 实现完整设置页</p>
            <button
              class="text-sm text-accent hover:underline"
              @click="settingsStore.currentView = 'chat'"
            >
              {{ t('common.close') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Statusbar — hidden in focus mode -->
      <AppStatusbar v-if="!settingsStore.focusMode" />
    </div>
  </ThemeProvider>
</template>
```

**Also update Step 2 (`src/stores/settings.ts`)** to include `currentView` and `focusMode`:

```ts
// src/stores/settings.ts — updated with view state
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type Theme = 'light' | 'dark' | 'system'
export type Locale = 'zh-CN' | 'en-US'
export type AppView = 'chat' | 'settings'

export const useSettingsStore = defineStore('settings', () => {
  // ── Persisted state ──
  const theme = ref<Theme>('system')
  const locale = ref<Locale>('zh-CN')
  const defaultModel = ref<string>('')

  // ── Session state (not persisted) ──
  const currentView = ref<AppView>('chat')
  const focusMode = ref(false)

  // ── Computed ──
  const effectiveTheme = computed<'light' | 'dark'>(() => {
    if (theme.value !== 'system') return theme.value
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  })

  // ── Actions ──
  function setTheme(value: Theme) { theme.value = value }
  function setLocale(value: Locale) { locale.value = value }
  function setDefaultModel(modelId: string) { defaultModel.value = modelId }

  return {
    theme, locale, defaultModel,
    currentView, focusMode,
    effectiveTheme,
    setTheme, setLocale, setDefaultModel,
  }
}, {
  persist: {
    pick: ['theme', 'locale', 'defaultModel'],
    // currentView and focusMode NOT persisted — default to 'chat' + standard on each launch
  },
})
```

---

### 2b. Tauri Global Shortcuts (missing)

**Insert after**: Step 15 (i18n supplement)

**New Step 16: Tauri Global Shortcuts Registration**

> **Note**: P1 implementation uses frontend `keydown` listeners (already in patch 2a). This step prepares the Rust-side shortcut infrastructure for future phases. P1 ships with frontend-only shortcuts.

#### Step 16a: Add Cargo.toml dependencies

In `src-tauri/Cargo.toml`, ensure:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-global-shortcut = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
```

#### Step 16b: Create `src-tauri/src/shortcuts.rs` (placeholder)

```rust
// src-tauri/src/shortcuts.rs
// P1: Placeholder — shortcuts handled by frontend keydown listeners.
// Future phases will register Tauri global shortcuts here for
// system-wide hotkey support (even when app is not focused).

use tauri::App;

pub fn register_shortcuts(_app: &App) {
    // P4+: Register Cmd+1, Cmd+3, Cmd+J, Cmd+2, Cmd+4
    // Using tauri_plugin_global_shortcut
    // Each shortcut emits a Tauri event that the frontend listens for.
}
```

#### Step 16c: Create `src-tauri/src/main.rs`

```rust
// src-tauri/src/main.rs
mod shortcuts;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::init())
        .setup(|app| {
            shortcuts::register_shortcuts(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

#### Step 16d: Commit

```bash
git add -A && git commit -m "feat(p1): Tauri shortcut infrastructure — placeholder for global shortcuts"
```

---

### 2c. Shared Types Import

**Affected steps**: Steps 2–9 (all stores and composables)

**Problem**: Same as patch 1f. All stores and composables reference types from `../types/message`, `../types/session`, `../types/provider`. These should come from the shared package.

**What to change**: In every file that imports types:

```ts
// Old:
import type { Message, ToolCall } from '../types/message'
import type { SessionSummary } from '../types/session'
import type { ProviderInfo, ModelInfo } from '../types/provider'

// New:
import type { Message, ToolCall, SessionSummary, ProviderInfo, ModelInfo } from '@xyz-agent/shared'
```

Or if the shared package exports are fine-grained:

```ts
import type { Message, ToolCall } from '@xyz-agent/shared/message'
import type { SessionSummary } from '@xyz-agent/shared/session'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared/provider'
```

Apply this pattern to:
- `src/stores/chat.ts` (Step 3)
- `src/stores/session.ts` (Step 4)
- `src/composables/useChat.ts` (Step 6)
- `src/composables/useSession.ts` (Step 7)
- `src/composables/useProvider.ts` (Step 8)
- `src/composables/useModel.ts` (Step 9)

---

### 2d. Header Component Update

**Affected step**: Step 10 (AppHeader.vue)

**Problem**: AppHeader.vue is missing:
1. `Cmd+,` shortcut hint on settings button tooltip
2. Connection status indicator (from `useConnection`)
3. View mode button active states

**What to change in Step 10**:

Replace the header with an updated version:

```vue
<!-- src/components/layout/AppHeader.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { useConnection } from '../../composables/useConnection'
import { useToast } from '../../composables/useToast'
import { Tooltip } from '../../design-system'
import { cn } from '../../design-system/utils'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const { status, isConnected } = useConnection()

const emit = defineEmits<{
  toggleSidebar: []
  openSettings: []
}>()

function toggleTheme() {
  const current = settingsStore.theme
  settingsStore.setTheme(current === 'light' ? 'dark' : current === 'dark' ? 'light' : 'light')
}
</script>

<template>
  <header
    data-slot="app-header"
    :class="cn(
      'flex items-center justify-between h-12 px-4',
      'bg-surface border-b border-border',
      'select-none',
    )"
  >
    <!-- Left: Logo + sidebar toggle -->
    <div class="flex items-center gap-2">
      <button
        class="p-1 rounded-sm hover:bg-bg-base transition-colors"
        :aria-label="t('header.toggleSidebar')"
        @click="emit('toggleSidebar')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </svg>
      </button>
      <span class="font-display text-lg font-semibold text-text-primary">xyz-agent</span>
    </div>

    <!-- Center: Connection status indicator -->
    <div class="flex items-center gap-2">
      <span
        :class="cn(
          'w-2 h-2 rounded-full',
          isConnected ? 'bg-success' : 'bg-danger',
        )"
        :title="isConnected ? t('status.connected') : t('status.disconnected')"
      />
    </div>

    <!-- Right: View mode buttons + Settings + Theme -->
    <div class="flex items-center gap-1">
      <!-- Standard mode button -->
      <Tooltip :content="`${t('header.standardView')} (⌘1)`">
        <button
          :class="cn(
            'p-1.5 rounded-sm transition-colors',
            !settingsStore.focusMode ? 'bg-accent-light text-accent' : 'hover:bg-bg-base text-text-muted',
          )"
          @click="settingsStore.focusMode = false"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
      </Tooltip>

      <!-- Split mode placeholder (P4, disabled) -->
      <button
        class="p-1.5 rounded-sm opacity-30 cursor-not-allowed"
        disabled
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M12 3v18" />
        </svg>
      </button>

      <!-- Focus mode button -->
      <Tooltip :content="`${t('header.focusView')} (⌘3)`">
        <button
          :class="cn(
            'p-1.5 rounded-sm transition-colors',
            settingsStore.focusMode ? 'bg-accent-light text-accent' : 'hover:bg-bg-base text-text-muted',
          )"
          @click="settingsStore.focusMode = true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
          </svg>
        </button>
      </Tooltip>

      <!-- Divider -->
      <div class="w-px h-5 bg-border mx-1" />

      <!-- Settings — with shortcut hint -->
      <Tooltip :content="`${t('header.settings')} (⌘,)`">
        <button
          class="p-1.5 rounded-sm hover:bg-bg-base transition-colors text-text-muted"
          @click="emit('openSettings')"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </Tooltip>

      <!-- Theme toggle -->
      <button
        class="p-1.5 rounded-sm hover:bg-bg-base transition-colors text-text-muted"
        :aria-label="t('header.toggleTheme')"
        @click="toggleTheme"
      >
        <!-- Moon icon (click to go dark) -->
        <svg v-if="settingsStore.effectiveTheme === 'light'"
          xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        <!-- Sun icon (click to go light) -->
        <svg v-else
          xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      </button>
    </div>
  </header>
</template>
```

**Key additions**:
- Connection status dot in center area (green = connected, red = disconnected)
- View mode buttons show active state (`bg-accent-light text-accent` vs `text-text-muted`)
- Settings button tooltip shows `⌘,` shortcut hint
- Uses `Tooltip` component from design-system

---

### 2e. Statusbar Enhancement

**Affected step**: Step 12 (AppStatusbar.vue)

**Problem**: Current statusbar uses `useConnection()` composable but creates a new instance locally. It should receive connection status from a shared source. Also the connection status dot and text need proper color and i18n.

**What to change in Step 12**:

Replace the statusbar with an enhanced version:

```vue
<!-- src/components/layout/AppStatusbar.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useConnection, type ConnectionStatus } from '../../composables/useConnection'
import { useSessionStore } from '../../stores/session'
import { useModel } from '../../composables/useModel'
import { cn } from '../../design-system/utils'

const { t } = useI18n()
const { status, isConnected, statusText } = useConnection()
const sessionStore = useSessionStore()
const { currentModelLabel } = useModel()

function statusDotClass(s: ConnectionStatus): string {
  return cn(
    'w-2 h-2 rounded-full shrink-0',
    s === 'connected' && 'bg-success',
    s === 'reconnecting' && 'bg-warning',
    s === 'disconnected' && 'bg-danger',
  )
}

function shortCwd(): string {
  const cwd = sessionStore.currentSession?.cwd
  if (!cwd) return '~'
  const parts = cwd.split('/').filter(Boolean)
  return '~/' + parts.slice(-2).join('/')
}
</script>

<template>
  <footer
    data-slot="app-statusbar"
    :class="cn(
      'flex items-center justify-between h-8 px-4',
      'bg-surface border-t border-border',
      'text-xs text-text-muted',
    )"
  >
    <!-- Left: Connection + cwd + model -->
    <div class="flex items-center gap-3">
      <!-- Connection status with color dot -->
      <span class="flex items-center gap-1.5">
        <span :class="statusDotClass(status)" />
        <span>{{ statusText }}</span>
      </span>

      <!-- Working directory -->
      <span class="flex items-center gap-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        {{ shortCwd() }}
      </span>

      <!-- Current model -->
      <span>{{ currentModelLabel }}</span>
    </div>

    <!-- Right: Shortcut hints -->
    <div class="flex items-center gap-3 text-text-muted">
      <span>
        <kbd class="px-1 py-0.5 rounded bg-surface border border-border text-[10px]">⌘1</kbd>
        {{ t('statusbar.standard') }}
      </span>
      <span>
        <kbd class="px-1 py-0.5 rounded bg-surface border border-border text-[10px]">⌘3</kbd>
        {{ t('statusbar.focus') }}
      </span>
    </div>
  </footer>
</template>
```

**Key changes**:
- Connection status dot uses `statusDotClass()` helper with 3 states (connected=green, reconnecting=yellow, disconnected=red)
- `statusText` computed from `useConnection()` (already localized)
- `shortCwd()` helper shows last 2 path segments
- Uses design token classes (`bg-success`, `bg-warning`, `bg-danger`) instead of hardcoded colors

---

## Summary of All Patches

| Patch | Plan | Step | Type | Description |
|-------|------|------|------|-------------|
| 1a | plan-02 | 2A-5,6,7, 2B-1,4 | **Replace** | Tailwind v3 JS config + CSS variables in main.css; remove JS `injectTokens()` |
| 1b | plan-02 | new 2E | **Add** | Markdown rendering pipeline (`src/lib/markdown.ts`) |
| 1c | plan-02 | new 2F | **Add** | Toast system (vue-sonner + useToast composable) |
| 1d | plan-02 | new 2G | **Add** | Install @tanstack/vue-virtual dependency |
| 1e | plan-02 | 2A-6 | **Merge** | Pinia + persist plugin registered in main.ts (foundation layer) |
| 1f | plan-02 | all | **Update** | Import paths → `@xyz-agent/shared` |
| 2a | plan-05 | Step 2, 14 | **Replace** | State-driven view switching via `settingsStore.currentView` / `focusMode` + keyboard shortcuts |
| 2b | plan-05 | new 16 | **Add** | Tauri global shortcuts infrastructure (Rust-side placeholder) |
| 2c | plan-05 | Steps 2–9 | **Update** | Import paths → `@xyz-agent/shared` |
| 2d | plan-05 | Step 10 | **Replace** | Header with connection status dot, active view states, shortcut hints |
| 2e | plan-05 | Step 12 | **Replace** | Statusbar with proper connection status colors and i18n |

**Total new files**: 3 (`tailwind.config.ts`, `src/assets/main.css`, `src/lib/markdown.ts`, `src/composables/useToast.ts`, `src-tauri/src/shortcuts.rs`)
**Total modified files**: 5 (`src/main.ts`, `src/App.vue`, `src/stores/settings.ts`, `AppHeader.vue`, `AppStatusbar.vue`)
**Total new dependencies**: 5 (`markdown-it`, `dompurify`, `vue-sonner`, `@tanstack/vue-virtual`, `pinia-plugin-persistedstate`)
