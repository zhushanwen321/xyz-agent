---
verdict: pass
---

# Statusline Frontend Design

> Covers Tasks 6–10 from the master plan: plugin store extension, InputToolbar, SessionStrip, AppStatusbar refactor, and ChatInput integration.

---

## §1 Task 6: Extend Plugin Store + usePlugin Composable

### 1.1 PluginStatusItem Type Extension

**File:** `src-electron/renderer/src/types/plugin.ts`

**Current interface (line ~9):**

```ts
export interface PluginStatusItem {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  commandId?: string
  priority: number
}
```

**Add two optional fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scope` | `'per-session' \| 'global'` | `'global'` | Routing scope for chip display |
| `sessionId` | `string \| undefined` | `undefined` | Session binding for per-session items |

**Resulting interface:**

```ts
export interface PluginStatusItem {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  commandId?: string
  priority: number
  scope?: 'per-session' | 'global'
  sessionId?: string
}
```

**Edge cases:** Existing items without `scope`/`sessionId` default to `scope='global'` — backward compatible.

---

### 1.2 Plugin Store Computed Additions

**File:** `src-electron/renderer/src/stores/plugin.ts`

**Add after `allStatusBarItems` computed (~line 76):**

#### `getSessionStatusBarItems(sessionId: string): ComputedRef<PluginStatusItem[]>`

- **Signature:** `(sessionId: string) => ComputedRef<PluginStatusItem[]>`
- **Returns:** Items where `scope === 'per-session'` AND `sessionId === input` , sorted by `priority` ascending.
- **Edge cases:** No matching items → `[]`. Items without `scope` field excluded (default to global).
- **Implementation pattern:** Use a factory function returning a computed, since Pinia `setup()` syntax doesn't support parameterized computed directly. Alternative: a getter function that filters `statusBarItems.value` on each call.

```ts
function getSessionStatusBarItems(sessionId: string): PluginStatusItem[] {
  return statusBarItems.value
    .filter(item => (item.scope ?? 'global') === 'per-session' && item.sessionId === sessionId)
    .sort((a, b) => a.priority - b.priority)
}
```

#### `globalStatusBarItems: ComputedRef<PluginStatusItem[]>`

- **Signature:** `computed(() => PluginStatusItem[])`
- **Returns:** Items where `scope === 'global'` (or `scope` is undefined, for backward compat), sorted by `priority` ascending. De-duplicate by `id` (keep last update).
- **Edge cases:** No global items → `[]`.

```ts
const globalStatusBarItems = computed(() =>
  statusBarItems.value
    .filter(item => (item.scope ?? 'global') === 'global')
    .sort((a, b) => a.priority - b.priority),
)
```

**Expose in return statement:** Add `getSessionStatusBarItems` and `globalStatusBarItems`.

---

### 1.3 usePlugin Composable Handler Update

**File:** `src-electron/renderer/src/composables/usePlugin.ts`

**Current handler (~line 60):**

```ts
'plugin:statusBarUpdate': (msg: ServerMessage) => {
  const { items } = msg.payload as { items: PluginStatusItem[] }
  store.setStatusBarItems(items)
},
```

**No logic change needed.** The handler already casts to `PluginStatusItem[]` and passes through. Since `PluginStatusItem` type is extended with optional fields, the existing cast is backward compatible. New fields (`scope`, `sessionId`) flow through automatically.

**Verification point:** Ensure the `PluginStatusItem` import resolves to the updated type (it's a local re-export, not from shared).

---

### 1.4 Data Flow (AC-5: Scope Routing)

```
plugin:statusBarUpdate WS message
  → usePlugin handler
    → pluginStore.setStatusBarItems(items)
      → getSessionStatusBarItems(sessionId)  → SessionStrip (per-session chips)
      → globalStatusBarItems computed        → AppStatusbar (global chips)
```

Items are routed **by `scope` field**, not by source. Both pi-extension-originated items (via statusline plugin) and xyz-agent plugin items share the same routing logic.

---

## §2 Task 7: InputToolbar.vue

### 2.1 Component Contract

**File (create):** `src-electron/renderer/src/components/chat/InputToolbar.vue`

**Location in tree:** Same directory as `ChatInput.vue`, `ModelPicker.vue`

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `sessionId` | `string` | yes | Current panel's session ID |
| `isStreaming` | `boolean` | yes | Whether a stream is active |
| `canSend` | `boolean` | yes | Whether send is allowed |

#### Emits

| Event | Payload | Description |
|-------|---------|-------------|
| `select-model` | `modelId: string` | User picked a new model |
| `select-thinking-level` | `level: string` | User picked a thinking level |
| `send` | — | User clicked send button |
| `cancel` | — | User clicked stop button |

#### External Dependencies (stores, not props)

| Data | Store | Field/Method | Notes |
|------|-------|-------------|-------|
| `currentModelId` | `settingsStore` | `defaultModel` | Current model identifier |
| `models` | `providerStore` | `models` | `ModelInfo[]` — all available models |
| `currentModel` | derived | computed from `providerStore.models` | Find by `defaultModel`, fallback to `[0]` |
| `thinkingLevelMap` | derived | `currentModel.thinkingLevelMap` | `Record<string, string \| null>` |
| `contextUsagePercent` | `chatStore` | `getSessionState(sessionId).contextUsagePercent` | `number` (0–100) |
| `contextInputTokens` | `chatStore` | `getSessionState(sessionId).contextInputTokens` | `number` |
| `contextLimit` | `chatStore` | `getSessionState(sessionId).contextLimit` | `number` |
| `tokenUsage` | `chatStore` | `getSessionState(sessionId).tokenUsage` | `number` — used as output tokens proxy |

**Note on output tokens:** `chatStore.ChatSessionState` has `tokenUsage` but no dedicated `contextOutputTokens` field. Plan's Context Discovery Notes flagged this. Use `tokenUsage` as output token display until a dedicated field is added upstream.

---

### 2.2 Template Structure

```
<div class="flex items-center gap-1 px-2 pb-1.5">
  ├── ModelPicker         ← reuse existing ModelPicker.vue, emit('select-model')
  ├── ThinkingLevelPicker  ← inline template block (see §2.3)
  ├── ContextBar           ← inline template block (see §2.4)
  ├── TokenStats           ← inline template block (see §2.5)
  ├── <div class="flex-1"> ← spacer
  └── Send/CancelButton    ← stop or send button
</div>
```

**Total estimated lines:** ~120 template, ~100 script. Within limits (400/300).

---

### 2.3 Thinking Level Picker

**Data source:** `currentModel.thinkingLevelMap` — `Record<string, string | null>`

**Computed:**

| Name | Signature | Returns | Description |
|------|-----------|---------|-------------|
| `thinkingLevels` | `computed` | `string[]` | `Object.keys(thinkingLevelMap ?? {})` — dynamic keys |
| `showThinkingPicker` | `computed` | `boolean` | `thinkingLevels.length > 0` |
| `currentThinkingLevel` | `ref<string>` | — | Selected level, default to first key |

**Template structure:**

```
<div v-if="showThinkingPicker" ref="thinkingRef" class="relative">
  <Button variant="ghost" @click="thinkingOpen = !thinkingOpen"
    class="inline-flex items-center gap-[5px] px-1.5 h-7 rounded-xs">
    ├── Signal bars SVG (inline, 5 bars, dynamic heights based on level index)
    └── Level label text (font-mono text-[11px])
  </Button>
  <div v-if="thinkingOpen"
    class="absolute bottom-[calc(100%+6px)] left-0 min-w-[200px] ...dropdown-panel classes...">
    <Button v-for="level in thinkingLevels" variant="ghost" @click="pickThinking(level)"
      class="flex items-center gap-2.5 w-full py-2 px-3 ...">
      ├── Signal bars SVG for each level
      ├── Level label
      ├── Description (from thinkingLevelMap value or generated)
      └── Check mark (v-if level === currentThinkingLevel)
    </Button>
  </div>
</div>
```

**Style reference:** `views_statusline-v2.html` `.tb-thinking` + `.tl-dropdown` + `.tl-bars`

**Signal bars SVG:** 5 bars, heights interpolated by level index (0=flat, max=tallest). Colors from CSS variables `--tl-*` or computed from level name.

**Edge cases:**
- `thinkingLevelMap` is `undefined` or `{}` → picker hidden (`v-if="showThinkingPicker"`)
- Single level → still show picker (user can see current level)
- Level names are dynamic — no hardcoded enum. Keys come from the map.

---

### 2.4 Context Bar

**Data source:** `chatStore.getSessionState(sessionId).contextUsagePercent`

**Computed:**

| Name | Signature | Returns | Description |
|------|-----------|---------|-------------|
| `contextSeverity` | `computed` | `'ok' \| 'warn' \| 'danger'` | `<60%` → `'ok'`, `60-85%` → `'warn'`, `>85%` → `'danger'` |
| `contextColor` | `computed` | `string` | CSS variable: `ok→var(--accent)`, `warn→var(--warning)`, `danger→var(--danger)` |

**Template structure:**

```
<div class="inline-flex items-center gap-1 px-1.5 h-7 text-[11px] font-mono text-muted shrink-0">
  <div class="w-10 h-1 bg-border rounded-sm overflow-hidden">
    <div class="h-full rounded-sm transition-all duration-300 ease-ease"
      :style="{ width: contextUsagePercent + '%', background: contextColor }" />
  </div>
  <span>{{ contextUsagePercent }}%</span>
</div>
```

**Style reference:** `views_statusline-v2.html` `.tb-ctx`, `.tb-ctx__track`, `.tb-ctx__fill`

**Edge cases:**
- `contextUsagePercent === 0` → bar at 0%, still visible (shows track)
- `contextUsagePercent > 100` → clamp display to `Math.min(pct, 100)`
- `contextUsagePercent` is `undefined` → default to `0`

---

### 2.5 Token Stats

**Data source:** `chatStore.getSessionState(sessionId).contextInputTokens`, `chatStore.getSessionState(sessionId).tokenUsage`

**Helper function:**

```ts
function formatTokenCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}
```

**Template structure:**

```
<span class="inline-flex items-center gap-0.5 px-1 h-7 font-mono text-[10px] text-muted whitespace-nowrap">
  <span class="text-accent">↑</span><span>{{ formatTokenCount(inputTokens) }}</span>
  <span class="text-muted">↓</span><span>{{ formatTokenCount(outputTokens) }}</span>
</span>
```

**Style reference:** `views_statusline-v2.html` `.tb-tokens`

**Edge cases:**
- Both tokens are `0` → show `↑0 ↓0` (expected initial state)
- `tokenUsage` is used as output tokens proxy (per plan discovery notes)

---

### 2.6 Send/Stop Button

**Already exists in current ChatInput.vue** (lines 62-79). This logic moves into InputToolbar.

**Template:**

```
<Button v-if="isStreaming" variant="ghost"
  class="...stop-button classes..."
  @click="emit('cancel')">■</Button>
<Button v-else variant="primary"
  class="...send-button classes..."
  :disabled="!canSend"
  @click="emit('send')">
  ↑ arrow SVG
</Button>
```

---

## §3 Task 8: SessionStrip.vue

### 3.1 Component Contract

**File (create):** `src-electron/renderer/src/components/chat/SessionStrip.vue`

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `sessionId` | `string` | yes | Current panel's session ID |

#### Emits

| Event | Payload | Description |
|-------|---------|-------------|
| *(none)* | — | Pure display component |

#### External Dependencies

| Data | Store | Field/Method | Notes |
|------|-------|-------------|-------|
| `branch` | `sessionStore` | Find session by `sessionId`, read `.cwd` → extract branch name | SessionSummary has `cwd` but no `gitBranch` field. Use `cwd` directory name as branch proxy, or extract from session label. |
| `extensionChips` | `pluginStore` | `getSessionStatusBarItems(sessionId)` | `PluginStatusItem[]` with `scope='per-session'` |

**Branch name resolution:** `SessionSummary` does not have a `gitBranch` field. The `cwd` field contains the working directory path. For the branch name display:
- Option A: Extract the worktree directory name from `cwd` (e.g., `/path/to/feat-statusline` → `feat-statusline`)
- Option B: Add a WS command to query git branch from sidecar
- **Recommended:** Option A for MVP — display the last path segment of `cwd`. If `cwd` is `/Users/x/xyz-agent-workspace/feat-statusline`, display `feat-statusline`.

---

### 3.2 Template Structure

```
<div class="flex items-center gap-1.5 px-2 pt-1 pb-2 text-[10px] font-mono text-muted min-h-[22px] flex-wrap">
  ├── Branch item
  │   ├── Branch icon (inline SVG, git-branch)
  │   └── <span class="text-accent">{{ branchName }}</span>
  │
  ├── Separator `<span class="text-border">|</span>` (v-if="hasChips")
  │
  └── Extension chips (v-for="chip in extensionChips")
      └── <span class="inline-flex items-center gap-[3px] px-1.5 py-px rounded-sm text-[10px] font-semibold">
            ├── Dot (4px rounded-full, background by chip type)
            └── {{ chip.text }}
          </span>
</div>
```

**Estimated lines:** ~40 template, ~30 script. Well within limits.

---

### 3.3 Chip Styling

**Style reference:** `views_statusline-v2.html` `.session-strip`, `.ss-ext-chip`

Chip colors determined by `chip.id` prefix (heuristic from statusline plugin mapping):

| Chip ID prefix | Background | Text color | Dot color |
|----------------|-----------|------------|-----------|
| `goal*` | `var(--accent-light)` | `var(--accent)` | `var(--accent)` |
| `todo*` | `var(--success-light)` | `var(--success)` | `var(--success)` |
| `workflow*` | `var(--warning-light)` | `var(--warning)` | `var(--warning)` |
| *(other)* | `var(--accent-light)` | `var(--muted)` | `var(--muted)` |

**Computed for chip style:**

```ts
function getChipStyle(id: string) {
  if (id.startsWith('goal')) return { bg: 'bg-accent-light', text: 'text-accent', dot: 'bg-accent' }
  if (id.startsWith('todo')) return { bg: 'bg-success-light', text: 'text-success', dot: 'bg-success' }
  if (id.startsWith('workflow')) return { bg: 'bg-warning-light', text: 'text-warning', dot: 'bg-warning' }
  return { bg: 'bg-accent-light', text: 'text-muted', dot: 'bg-muted' }
}
```

---

### 3.4 Edge Cases

| Case | Behavior |
|------|----------|
| `sessionId` is empty string | Show empty strip (no branch, no chips) |
| No session found for `sessionId` | Show empty strip |
| `extensionChips` is empty `[]` | Show only branch name, no separator |
| Split panel | Each panel passes its own `sessionId`, gets independent data |
| `tooltip` on chip | Use `:title="chip.tooltip"` for hover |
| `commandId` on chip | Add `cursor-pointer` class + click handler that calls `pluginStore.executeCommand(chip.pluginId, chip.commandId)` |

---

## §4 Task 9: Refactor AppStatusbar.vue

### 4.1 Current State (89 lines)

**File:** `src-electron/renderer/src/components/layout/AppStatusbar.vue`

Current layout:
- **Left:** Connection dot + status text + plugin status bar items (from `pluginStore.allStatusBarItems`)
- **Right:** `modelId` + `tokenDisplay`

**What moves out:**
- `modelId` display → InputToolbar (via ModelPicker)
- `tokenDisplay` → InputToolbar (token stats)
- `formatTokens` helper → InputToolbar

**What stays:**
- Connection status (dot + text)
- Plugin status bar items → now filtered to `globalStatusBarItems` only

**What changes:**
- Replace `allStatusBarItems` with `globalStatusBarItems` (scope-filtered)
- Remove `tokenDisplay` computed, `formatTokens` function, `activeSession`/`activeSessionId` computed (no longer needed here)
- Remove `chatStore` import (no longer reading context data)

---

### 4.2 Refactored Template Structure

```
<footer class="flex items-center justify-between h-statusbar px-3.5 bg-surface border-t border-border text-[11px] text-muted shrink-0 font-mono">
  <!-- Left: connection + pi version -->
  <div class="inline-flex items-center gap-3 min-w-0">
    <span class="inline-flex items-center gap-1">
      <span class="w-[5px] h-[5px] rounded-full" :style="{ background: dotColor }" />
      {{ statusText }}
    </span>
    <span class="text-[10px]">{{ piVersion }}</span>
  </div>
  
  <!-- Right: global extension chips -->
  <div class="inline-flex items-center gap-2 min-w-0">
    <template v-for="(item, idx) in globalStatusBarItems" :key="item.id">
      <span v-if="idx > 0" class="w-px h-3 bg-border shrink-0" />
      <span
        role="button" tabindex="0"
        class="inline-flex items-center gap-1 text-[10px] hover:text-fg transition-colors"
        :class="item.commandId ? 'cursor-pointer' : 'cursor-default'"
        :title="item.tooltip ?? ''"
        @click="handleStatusItemClick(item)"
      >{{ item.text }}</span>
    </template>
  </div>
</footer>
```

---

### 4.3 Script Changes

**Removed imports:**
- `useChatStore` — no longer reads token/context data
- `usePanelStore` — no longer needs focused panel

**Added data source:**

| Name | Source | Type | Description |
|------|--------|------|-------------|
| `globalStatusBarItems` | `pluginStore.globalStatusBarItems` | `ComputedRef<PluginStatusItem[]>` | Only global-scope items, sorted by priority |
| `piVersion` | `connState` / WS getState | `string` | Pi version string. Currently not in `getState()`. Needs a new data source. |

**Pi version data source:** The current codebase doesn't expose pi version to the frontend. Options:
- **Option A (recommended):** Read from `settingsStore` or a new WS query `system.info` that returns `{ piVersion, ... }`.
- **Option B:** Hardcode from a known constant. Not maintainable.
- **MVP fallback:** If pi version is not available by implementation time, omit the version display entirely (no placeholder).

**Kept unchanged:**
- `dotColor` computed (connection status color)
- `statusText` computed (connection status text)
- `handleStatusItemClick` function (command execution)
- `connState = getState()` (WebSocket connection state)

**Estimated lines:** ~50 template, ~40 script. Reduced from 89 total.

---

### 4.4 Style Reference

**Design system tokens used:**

| Token | Usage |
|-------|-------|
| `var(--statusbar-h)` (= `32px`) | Footer height |
| `var(--surface)` | Background |
| `var(--border)` | Top border, dividers |
| `var(--muted)` | Text color |
| `var(--success)` | Connected dot |
| `var(--warning)` | Reconnecting dot |
| `var(--accent-light)` / `var(--accent)` | Chip hover |

**Reference:** `views_statusline-v2.html` `.global-statusbar`, `.gs-left`, `.gs-right`

---

## §5 Task 10: Integrate into ChatInput.vue

### 5.1 Current ChatInput Layout (324 lines)

**File:** `src-electron/renderer/src/components/chat/ChatInput.vue`

Current structure:
```
<div class="relative mx-auto mb-3 shrink-0 max-w-[960px] w-full px-6">
  <SlashMenu ... />
  <div class="chat-input-container ...">
    <div> Command/Skill tag bar (v-if activeCommand) </div>
    <Textarea ... />
    <div class="flex items-center gap-1 px-2 pb-1.5">
      <ModelPicker ... />
      <div class="flex-1" />
      <Button stop/send />
    </div>
  </div>
</div>
```

**What changes:**
1. Replace the inline toolbar row (`ModelPicker` + spacer + `Button`) with `<InputToolbar>` component
2. Add `<SessionStrip>` after the input container div
3. Remove direct `ModelPicker` import (now inside InputToolbar)
4. Pass `sessionId` prop down

---

### 5.2 New Template Structure

```
<div class="relative mx-auto mb-3 shrink-0 max-w-[960px] w-full px-6" data-chat-input>
  <SlashMenu ... />                                    <!-- unchanged -->
  <div class="...chat-input-container...">
    <div v-if="activeCommand" ...>                     <!-- unchanged: tag bar -->
    </div>
    <Textarea ... />                                   <!-- unchanged -->
    <InputToolbar                                      <!-- NEW: replaces inline toolbar -->
      :session-id="sessionId"
      :is-streaming="isStreaming"
      :can-send="canSend"
      @select-model="(id) => emit('select-model', id)"
      @select-thinking-level="(l) => emit('send-command', { type: 'session.setThinkingLevel', payload: { sessionId, level: l } })"
      @send="handleSend"
      @cancel="emit('cancel')"
    />
  </div>
  <SessionStrip                                        <!-- NEW: below input box -->
    :session-id="sessionId"
  />
</div>
```

---

### 5.3 Import Changes

**Add:**

```ts
import InputToolbar from './InputToolbar.vue'
import SessionStrip from './SessionStrip.vue'
```

**Remove:**

```ts
import ModelPicker from './ModelPicker.vue'  // now inside InputToolbar
```

**Note:** `ModelPicker` import removal means the `currentModel` computed and the direct `emit('select-model', id)` wiring in ChatInput's old toolbar row are gone. InputToolbar handles this internally.

---

### 5.4 Emit Wiring

InputToolbar emits are wired to ChatInput's existing emits and handlers:

| InputToolbar Emit | ChatInput Action |
|-------------------|------------------|
| `select-model` | Forward to `emit('select-model', modelId)` |
| `select-thinking-level` | Forward to `emit('send-command', { type: 'session.setThinkingLevel', payload: { sessionId, level } })` |
| `send` | Call `handleSend()` |
| `cancel` | Forward to `emit('cancel')` |

**New emit on ChatInput:** No new emits needed. `send-command` already exists.

---

### 5.5 Thinking Level Command

The `session.setThinkingLevel` command needs to be handled in the parent component (likely `PaneSessionView.vue` or wherever `send-command` is consumed). The command payload:

```ts
{ type: 'session.setThinkingLevel', payload: { sessionId: string, level: string } }
```

This maps to a WS `send()` call with `type: 'session.setThinkingLevel'`. The sidecar handler will forward to pi RPC to set the thinking level for the session.

**Implementation note:** If the sidecar doesn't yet support `session.setThinkingLevel`, the command should be a no-op with a toast notification. This is a backend concern tracked separately.

---

### 5.6 Layout CSS

SessionStrip sits **outside** the input container border but **inside** the max-width wrapper:

```
<div class="max-w-[960px] w-full">
  <div class="chat-input-container border-2 ...">   ← border + focus ring
    <Textarea />
    <InputToolbar />                                 ← inside border
  </div>
  <SessionStrip />                                   ← outside border, below input
</div>
```

SessionStrip has no border, no background — it's part of the visual "input area" but outside the interactive border.

---

### 5.7 Edge Cases

| Case | Behavior |
|------|----------|
| `sessionId` is empty | InputToolbar uses fallback store data (defaultModel), SessionStrip shows nothing |
| Split panel (2 ChatInput instances) | Each gets its own `sessionId` prop, data is fully isolated via store `getSessionState(sessionId)` |
| Model switch failure | InputToolbar restores previous model display + shows toast. Toast via `useToast` composable or inline error message. |
| `contextUsagePercent` never updated (backend gap) | ContextBar shows `0%` with accent color. Known limitation per plan discovery. |
| `thinkingLevelMap` is empty | Thinking picker auto-hidden (`v-if="showThinkingPicker"`) |

---

## Appendix A: Design Token Reference

All CSS variables from `css_design-system.css`:

| Token | Value (light) | Usage |
|-------|---------------|-------|
| `--surface` | `oklch(99% 0.008 70)` | InputToolbar background, statusbar bg |
| `--bg` | `oklch(97% 0.018 70)` | App background |
| `--fg` | `oklch(22% 0.02 50)` | Primary text |
| `--muted` | `oklch(50% 0.018 50)` | Secondary text |
| `--border` | `oklch(90% 0.014 70)` | Borders, separators, tracks |
| `--accent` | `oklch(64% 0.13 28)` | Active states, accent color |
| `--accent-light` | `oklch(92% 0.04 28)` | Chip bg, hover states |
| `--success` | `oklch(62% 0.10 145)` | Connected dot, success chips |
| `--success-light` | `oklch(95% 0.04 145)` | Success chip background |
| `--warning` | `oklch(75% 0.10 85)` | Context bar 60-85%, reconnecting dot |
| `--warning-light` | `oklch(95% 0.04 85)` | Warning chip background |
| `--danger` | `oklch(55% 0.12 25)` | Context bar >85%, stop button hover |
| `--danger-light` | `oklch(93% 0.04 25)` | Danger chip background |
| `--font-mono` | `'JetBrains Mono', ...` | Model name, token stats, percentages |
| `--font-body` | `-apple-system, ...` | Labels, button text |
| `--radius-sm` | `8px` | Dropdown panels |
| `--radius-xs` | `4px` | Buttons, small chips |
| `--statusbar-h` | `32px` | Global statusbar height |
| `--ease` | `cubic-bezier(0.4,0,0.2,1)` | All transitions |

---

## Appendix B: Component Size Estimates

| Component | Template (lines) | Script (lines) | Total | Within Limits |
|-----------|-----------------|----------------|-------|---------------|
| InputToolbar.vue | ~120 | ~100 | ~220 | ✅ (<400/<300) |
| SessionStrip.vue | ~40 | ~30 | ~70 | ✅ (<400/<300) |
| AppStatusbar.vue | ~50 | ~40 | ~90 | ✅ (reduced from 89) |
| ChatInput.vue (delta) | -20 | -10 | net -30 | ✅ |

---

## Appendix C: xyz-ui Component Usage

Per project rules, **no native HTML form elements**. All interactive elements use xyz-ui design system:

| Element | xyz-ui Component | Usage |
|---------|-----------------|-------|
| Send button | `<Button variant="primary">` | InputToolbar send |
| Stop button | `<Button variant="ghost">` | InputToolbar cancel |
| Model picker trigger | `<Button variant="ghost">` | Inside ModelPicker (existing) |
| Thinking picker trigger | `<Button variant="ghost">` | ThinkingLevelPicker |
| Thinking level option | `<Button variant="ghost">` | ThinkingLevelPicker dropdown |
| Textarea | `<Textarea>` (xyz-ui) | ChatInput (existing) |

**Dropdowns** are custom-positioned `<div>` panels (not xyz-ui Dialog/Select) because the existing ModelPicker uses this pattern — floating panel positioned `absolute bottom-[calc(100%+6px)]`. Follow the same convention for consistency.

---

## Appendix D: File Modification Summary

| File | Action | Lines Changed | Task |
|------|--------|--------------|------|
| `src-electron/renderer/src/types/plugin.ts` | modify | +3 fields in `PluginStatusItem` | §1 |
| `src-electron/renderer/src/stores/plugin.ts` | modify | +2 computed/getter (~15 lines) | §1 |
| `src-electron/renderer/src/composables/usePlugin.ts` | no change | 0 | §1 |
| `src-electron/renderer/src/components/chat/InputToolbar.vue` | **create** | ~220 lines | §2 |
| `src-electron/renderer/src/components/chat/SessionStrip.vue` | **create** | ~70 lines | §3 |
| `src-electron/renderer/src/components/layout/AppStatusbar.vue` | modify | ~-30 net (simplify) | §4 |
| `src-electron/renderer/src/components/chat/ChatInput.vue` | modify | ~-10 net (replace toolbar) | §5 |
