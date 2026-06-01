---
verdict: pass
complexity: L1
---

# Global Navigation History Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `settingsStore.currentView` toggle with a browser-like navigation history stack that unifies Chat ↔ Settings view switching and wires the sidebar ◀▶ buttons.

**Architecture:** A new `NavigationStore` (Pinia) becomes the single source of truth for view state. It holds an array of `NavEntry` items + a pointer. All view-switching actions (session click, settings button, Cmd+,, ESC) call `push()`/`back()`/`forward()`. Components watch the store's computed `currentView` and `currentEntry` to render the correct view and restore Settings tab state. `settingsStore.currentView` and `setView()` are removed after migration.

**Tech Stack:** Vue 3 + Pinia + TypeScript (existing frontend stack). No new dependencies.

---

## AMBIGUOUS Resolution (from spec Phase 1)

| ID | Decision | Rationale |
|----|----------|-----------|
| ID-1 | **Option A** — `lastTab` = last Settings entry's activeTab in stack, fallback `'providers'` | Keeps tab info co-located in entries, no separate ref |
| ID-2 | **Option A** — allow consecutive same-session entries | Predictable button state; stack records true click trail |
| ID-3 | **Option A** — empty stack at startup, first user action pushes | No magic init; NavigationStore starts empty |
| ID-4 | **Option A** — pointer -= 1 when oldest discarded | Preserves logical position of pointer |
| ID-5 | **Option A** — use last Settings entry's activeTab | Same resolution as ID-1; consistent |

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/renderer/src/stores/navigation.ts` | create | FG1 | NavigationStore — history stack, push/back/forward, computed state |
| `src-electron/renderer/src/stores/__tests__/navigation.test.ts` | create | FG1 | Unit tests for NavigationStore |
| `src-electron/renderer/src/components/layout/AppSidebar.vue` | modify | FG2 | Wire ◀▶ buttons + update handleSessionClick |
| `src-electron/renderer/src/components/layout/SettingsView.vue` | modify | FG2 | ESC → back(), activeTab sync, remove local keydown for Cmd+, |
| `src-electron/renderer/src/App.vue` | modify | FG2 | Replace currentView with navStore, wire IPC shortcuts |
| `src-electron/renderer/src/components/layout/AppHeader.vue` | modify | FG2 | Settings button → navStore.push |
| `src-electron/renderer/src/stores/settings.ts` | modify | FG3 | Remove currentView + setView |
| `src-electron/renderer/src/stores/panel.ts` | read-only | — | Reference: openSessionSmart API |

## Interface Contracts

### Module: NavigationStore

**File:** `src-electron/renderer/src/stores/navigation.ts`

#### Types

| Type | Fields | Description |
|------|--------|-------------|
| `ChatEntry` | `{ view: 'chat', sessionId: string }` | Chat view entry |
| `SettingsEntry` | `{ view: 'settings', activeTab: string }` | Settings view entry with tab state |
| `NavEntry` | `ChatEntry \| SettingsEntry` | Discriminated union |

#### Store State

| Field | Type | Description |
|-------|------|-------------|
| `entries` | `NavEntry[]` | History stack |
| `pointer` | `number` | Index into entries, -1 when empty |

#### Computed

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `currentEntry` | `() => NavEntry \| null` | Entry at pointer | pointer < 0 → null; pointer >= length → null | FR-1 |
| `currentView` | `() => 'chat' \| 'settings'` | currentEntry?.view ?? 'chat' | empty stack → 'chat' | FR-1, C-3 |
| `canGoBack` | `() => boolean` | pointer > 0 | empty → false | AC-5 |
| `canGoForward` | `() => boolean` | pointer < entries.length - 1 | empty → false | AC-5 |

#### Actions

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `push` | `(entry: NavEntry) => void` | — | pointer not at end → truncate; overflow (>50) → shift + pointer-- | FR-1, C-4, AC-2 |
| `back` | `() => void` | — | canGoBack false → no-op | FR-1, AC-1 |
| `forward` | `() => void` | — | canGoForward false → no-op | FR-1, AC-1 |
| `updateCurrentTab` | `(activeTab: string) => void` | — | currentEntry not Settings → no-op | FR-2 |
| `getLastSettingsTab` | `() => string` | `'providers'` fallback | No Settings entry in stack → 'providers' | FR-3, ID-1 |

### Module: settingsStore (modifications)

**File:** `src-electron/renderer/src/stores/settings.ts`

| Change | Description | Spec Ref |
|--------|-------------|----------|
| Remove `currentView` ref | Line 11: `const currentView = ref<'chat' \| 'settings'>('chat')` deleted | C-3 |
| Remove `setView` function | Line 48: `function setView(v)` deleted | C-3 |
| Remove from return | Lines 54-58: remove currentView, setView from return | C-3 |
| Remove from persist.pick | Not in persist.pick already (verified in Phase 1) | — |

### Module: App.vue (modifications)

**File:** `src-electron/renderer/src/App.vue`

| Change | Location | Description | Spec Ref |
|--------|----------|-------------|----------|
| Import navStore | Script section | `import { useNavigationStore } from './stores/navigation'` | — |
| Template: view switch | Line 11 | `v-if="settingsStore.currentView === 'settings'"` → `v-if="navStore.currentView === 'settings'"` | FR-1 |
| Template: sidebar emit | Line 7 | Remove `@toggle-settings` handler, replace with navStore.push | FR-3 |
| IPC: settings shortcut | Line 245-247 | Toggle → push/fallback | FR-4 |
| IPC: standard shortcut | Line 237 | Direct currentView assignment → navStore.push or no-op | — |
| Panel focus watcher | After navStore init | Watch currentEntry.sessionId → panelStore.openSessionSmart | FR-5 |

### Module: AppSidebar.vue (modifications)

**File:** `src-electron/renderer/src/components/layout/AppSidebar.vue`

| Change | Location | Description | Spec Ref |
|--------|----------|-------------|----------|
| Import navStore | Script section | `import { useNavigationStore } from '../../stores/navigation'` | — |
| handleSessionClick | Line 59-62 | Add `navStore.push({ view: 'chat', sessionId })` | FR-3 |
| ◀ button | Line 90-91 | Add `@click="navStore.back()"` + `:disabled="!navStore.canGoBack"` | FR-3, AC-5 |
| ▶ button | Line 93-94 | Add `@click="navStore.forward()"` + `:disabled="!navStore.canGoForward"` | FR-3, AC-5 |
| isSettingsActive | Line 64 | `settingsStore.currentView === 'settings'` → `navStore.currentView === 'settings'` | — |

### Module: SettingsView.vue (modifications)

**File:** `src-electron/renderer/src/components/layout/SettingsView.vue`

| Change | Location | Description | Spec Ref |
|--------|----------|-------------|----------|
| Import navStore | Script section | `import { useNavigationStore } from '../../stores/navigation'` | — |
| ESC handler | Line 21-27 | `settingsStore.setView('chat')` → `navStore.back()` | FR-4, AC-6 |
| Cmd+, handler | Line 29-31 | Remove — moved to global (App.vue IPC) | FR-4 |
| activeTab watch | New | Watch navStore.currentEntry → restore activeTab from entry | FR-2 |
| activeTab → store sync | Line 57 `@click` | Call `navStore.updateCurrentTab(tab.key)` when tab clicked | FR-2 |

### Module: AppHeader.vue (modifications)

**File:** `src-electron/renderer/src/components/layout/AppHeader.vue`

| Change | Location | Description | Spec Ref |
|--------|----------|-------------|----------|
| Import navStore | Script section | `import { useNavigationStore } from '../../stores/navigation'` | — |
| openSettings | Line 94-96 | Replace toggle with `navStore.push({ view: 'settings', activeTab: navStore.getLastSettingsTab() })` | FR-3 |

## Data Flows

```
User Action                  →  NavigationStore         →  View Effect
─────────────────────────────────────────────────────────────────────────
Click session A              →  push({chat, A})         →  show Chat(A)
Click settings button        →  push({settings, tab})   →  show Settings(tab)
Press Cmd+,                  →  push({settings, tab})   →  show Settings(tab)
Press ESC (in Settings)      →  back()                  →  show previous view
Click ◀                     →  back()                  →  show previous view
Click ▶                     →  forward()               →  show next view
Switch Settings tab          →  updateCurrentTab(tab)   →  update entry in place
```

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 (basic nav sequence) | push / back / forward | all | Task 1 (store) + Task 2 (UI) |
| AC-2 (truncation) | push (truncate branch) | push | Task 1 |
| AC-3 (Settings tab restore) | updateCurrentTab + getLastSettingsTab | tab sync | Task 1 + Task 3 |
| AC-4 (back closes Settings) | back | back | Task 1 + Task 2 |
| AC-5 (button state) | canGoBack / canGoForward | computed | Task 1 + Task 2 |
| AC-6 (ESC shortcut) | back (via ESC) | back | Task 3 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-1 导航历史栈 | adopted | Task 1 |
| FR-2 Settings tab 状态保留 | adopted | Task 1, Task 3 |
| FR-3 侧边栏按钮映射 | adopted | Task 2 |
| FR-4 键盘快捷键对齐 | adopted | Task 3, Task 4 |
| FR-5 Panel 焦点同步 | adopted | Task 2 (watcher in App.vue) |
| AC-1 基本导航序列 | adopted | Task 1, Task 2 |
| AC-2 截断行为 | adopted | Task 1 |
| AC-3 Settings Tab 恢复 | adopted | Task 1, Task 3 |
| AC-4 后退关闭 Settings | adopted | Task 2 |
| AC-5 按钮状态 | adopted | Task 2 |
| AC-6 快捷键 ESC | adopted | Task 3 |
| C-1 PanelStore/SessionStore 不修改 | adopted | All (read-only) |
| C-2 PanelTreeRenderer 不修改 | adopted | All |
| C-3 currentView 可移除 | adopted | Task 5 |
| C-4 历史栈上限 50 | adopted | Task 1 |
| C-5 不持久化 | adopted | Task 1 |
| OS-1~OS-6 | adopted (by not doing) | — |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Create NavigationStore | frontend | — | FG1 |
| 2 | Wire AppSidebar ◀▶ + session click | frontend | 1 | FG2 |
| 3 | Update SettingsView ESC + activeTab sync | frontend | 1 | FG2 |
| 4 | Update App.vue view switching + IPC shortcuts | frontend | 1 | FG2 |
| 5 | Remove settingsStore.currentView + cleanup | frontend | 2,3,4 | FG3 |

---

### Task 1: Create NavigationStore

**Type:** frontend

**Files:**
- Create: `src-electron/renderer/src/stores/navigation.ts`
- Create: `src-electron/renderer/src/stores/__tests__/navigation.test.ts`

**Description:** Create the core navigation store with history stack, push/back/forward operations, and computed state. This is the foundation all other tasks depend on.

- [ ] **Step 1: Create NavigationStore type definitions and store**

Create `stores/navigation.ts` with:
- `ChatEntry` type: `{ view: 'chat', sessionId: string }`
- `SettingsEntry` type: `{ view: 'settings', activeTab: string }`
- `NavEntry` discriminated union
- Pinia store `useNavigationStore` with:
  - State: `entries: NavEntry[]` (init `[]`), `pointer: number` (init `-1`)
  - Computed: `currentEntry`, `currentView`, `canGoBack`, `canGoForward`
  - Actions: `push`, `back`, `forward`, `updateCurrentTab`, `getLastSettingsTab`
- `push(entry)`:
  - If `pointer >= 0 && pointer < entries.length - 1`: truncate `entries.splice(pointer + 1)`
  - `entries.push(entry)`
  - If `entries.length > 50`: `entries.shift()`, `pointer -= 1`
  - `pointer = entries.length - 1`
- `back()`: if `canGoBack` → `pointer -= 1`
- `forward()`: if `canGoForward` → `pointer += 1`
- `updateCurrentTab(activeTab)`: if currentEntry is Settings → replace entry's activeTab
- `getLastSettingsTab()`: reverse-iterate entries, return first Settings entry's activeTab, fallback `'providers'`

- [ ] **Step 2: Write unit tests**

Create `stores/__tests__/navigation.test.ts` covering:
- Empty stack: currentEntry=null, currentView='chat', canGoBack=false, canGoForward=false
- AC-1 sequence: push Chat(A) → push Settings → push Chat(B) → back → back → forward → forward
- AC-2 truncation: push 3 entries, back to pointer=1, push new → truncated
- C-4 capacity: push 51 entries → oldest discarded, pointer adjusted
- FR-2 tab sync: updateCurrentTab on Settings entry
- ID-1: getLastSettingsTab returns correct tab, fallback 'providers'
- No-op guards: back() on empty, forward() at end

Run: `npx vitest run src-electron/renderer/src/stores/__tests__/navigation.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/stores/navigation.ts src-electron/renderer/src/stores/__tests__/navigation.test.ts
git commit -m "feat: add NavigationStore with history stack, push/back/forward"
```

---

### Task 2: Wire AppSidebar ◀▶ buttons + session click

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/layout/AppSidebar.vue`

**Description:** Wire the existing ◀▶ buttons to NavigationStore.back()/forward() with disabled bindings. Update handleSessionClick to push navigation entry.

- [ ] **Step 1: Add navStore import and update script**

In `<script setup>`:
- Add `import { useNavigationStore } from '../../stores/navigation'`
- Add `const navStore = useNavigationStore()`
- Update `handleSessionClick` (line 59-62): add `navStore.push({ view: 'chat', sessionId })` after existing calls
- Update `isSettingsActive` (line 64): change to `navStore.currentView === 'settings'`

- [ ] **Step 2: Wire ◀▶ buttons in template**

Update ◀ button (line 90-91):
- Add `@click="navStore.back()"`
- Add `:disabled="!navStore.canGoBack"`

Update ▶ button (line 93-94):
- Add `@click="navStore.forward()"`
- Add `:disabled="!navStore.canGoForward"`

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/components/layout/AppSidebar.vue
git commit -m "feat: wire sidebar back/forward buttons + session click to NavigationStore"
```

---

### Task 3: Update SettingsView — ESC, activeTab sync, remove local Cmd+,

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/layout/SettingsView.vue`

**Description:** Replace ESC handler to call navStore.back(). Add activeTab ↔ NavigationStore synchronization. Remove local Cmd+, handler (moved to App.vue IPC in Task 4).

- [ ] **Step 1: Add navStore import and update keydown handler**

In `<script setup>`:
- Add `import { useNavigationStore } from '../../stores/navigation'`
- Add `const navStore = useNavigationStore()`

Update `onKeydown` (lines 20-33):
- ESC case (line 26): replace `settingsStore.setView('chat')` with `navStore.back()`
- Remove entire Cmd+, block (lines 29-31) — this will be handled globally in Task 4

- [ ] **Step 2: Add activeTab synchronization**

Add a watcher (with `{ immediate: true }`) that:
- When `navStore.currentEntry` changes and is a Settings entry → set `activeTab.value = entry.activeTab`
- `{ immediate: true }` is **required**: SettingsView re-mounts on every navigation back to Settings (v-if destroys/recreates it). Without immediate, the watcher won't fire because `currentEntry` is already the Settings entry at mount time.
- When user clicks a tab → call `navStore.updateCurrentTab(tab.key)` alongside `activeTab.value = tab.key`

Implementation:
```typescript
watch(
  () => navStore.currentEntry,
  (entry) => {
    if (entry?.view === 'settings') activeTab.value = entry.activeTab
  },
  { immediate: true }
)
```

Update tab click handler (line 57):
- Change `@click="activeTab = tab.key"` to `@click="activeTab = tab.key; navStore.updateCurrentTab(tab.key)"`

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/components/layout/SettingsView.vue
git commit -m "feat: SettingsView ESC→back(), activeTab sync with NavigationStore"
```

---

### Task 4: Update App.vue — view switching + IPC shortcuts

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/App.vue`

**Description:** Replace settingsStore.currentView with navStore.currentView for view switching. Update IPC shortcut handlers to use NavigationStore.

- [ ] **Step 1: Add navStore import**

In `<script setup>`:
- Add `import { useNavigationStore } from './stores/navigation'`
- Add `const navStore = useNavigationStore()`

- [ ] **Step 2: Update template**

Line 7: Change `@toggle-settings="settingsStore.setView(...)` to `@toggle-settings="navStore.currentView === 'settings' ? navStore.back() : navStore.push({ view: 'settings', activeTab: navStore.getLastSettingsTab() })"`

Line 11: Change `v-if="settingsStore.currentView === 'settings'"` to `v-if="navStore.currentView === 'settings'"`

- [ ] **Step 3: Add panel focus sync watcher**

After `const navStore = useNavigationStore()`, add a watcher that syncs panel focus when navigating between chat sessions:
```ts
watch(
  () => navStore.currentEntry?.view === 'chat' ? navStore.currentEntry.sessionId : null,
  (sessionId) => {
    if (sessionId && panelStore.focusedPanel?.sessionId !== sessionId) {
      panelStore.openSessionSmart(sessionId)
    }
  },
)
```
This ensures that `back()`/`forward()` between chat entries actually switches the visible panel, not just the navStore pointer. Without this watcher, the PanelTreeRenderer would continue showing the previously focused session. (FR-5)

- [ ] **Step 4: Update IPC shortcut handlers**

In `onShortcut` callback (lines 231-249):

`case 'standard'` / `case 'focus'` (line 237): replace `settingsStore.currentView = 'chat'` with: if navStore.currentView !== 'chat', call `navStore.push({ view: 'chat', sessionId: panelStore.focusedPanel?.sessionId ?? '' })`. Otherwise no-op. If the focused panel has no session, skip the push (just let standard merge happen). Note: correct API is `panelStore.focusedPanel?.sessionId` (verified panel.ts:78, not `focusedSessionId`).

`case 'settings'` (line 246): replace toggle with:
```
if (navStore.currentView === 'settings') { navStore.back() }
else { navStore.push({ view: 'settings', activeTab: navStore.getLastSettingsTab() }) }
```

- [ ] **Step 4: Commit**

```bash
git add src-electron/renderer/src/App.vue
git commit -m "feat: App.vue view switching via NavigationStore, update IPC shortcuts"
```

---

### Task 5: Remove settingsStore.currentView + cleanup

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/stores/settings.ts`
- Modify: `src-electron/renderer/src/components/layout/AppSidebar.vue`
- Modify: `src-electron/renderer/src/components/layout/AppHeader.vue`

**Description:** After all components have migrated to NavigationStore, remove the deprecated currentView and setView from settingsStore. Update remaining references.

- [ ] **Step 1: Update AppHeader.openSettings**

In `AppHeader.vue` (line 94-96):
- Add `import { useNavigationStore } from '../../stores/navigation'`
- Add `const navStore = useNavigationStore()`
- Replace `openSettings` body with: `navStore.push({ view: 'settings', activeTab: navStore.getLastSettingsTab() })`
- Remove `settingsStore` import if no longer needed (check other usages in file)

- [ ] **Step 2: Remove currentView and setView from settingsStore**

In `settings.ts`:
- Remove line 11: `const currentView = ref<'chat' | 'settings'>('chat')`
- Remove line 48: `function setView(v: 'chat' | 'settings') { currentView.value = v }`
- Remove `currentView` and `setView` from return object (lines 54, 57)

- [ ] **Step 3: Verify no remaining references**

Search for any remaining `settingsStore.currentView` or `settingsStore.setView` or `setView` references:
```bash
grep -rn "currentView\|setView" src-electron/renderer/src/ --include="*.vue" --include="*.ts"
```
Expected: zero results. If found, update those references.

- [ ] **Step 4: Run lint + existing tests**

```bash
npm run lint
npx vitest run src-electron/renderer/src/stores/__tests__/navigation.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove settingsStore.currentView, fully migrate to NavigationStore"
```

---

## Execution Groups

#### FG1: Core NavigationStore

**Description:** Create the navigation store and its unit tests. This is the data layer all UI components depend on.

**Tasks:** Task 1

**Files (预估):** 2 个文件（2 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high, tdd-coder: medium, reviewer: medium） |
| 注入上下文 | Task 1 描述、spec FR-1/FR-2/AC-1~AC-5/C-4/AMBIGUOUS 决议、编码规范（禁止 any、Promise.allSettled） |
| 读取文件 | `src-electron/renderer/src/stores/settings.ts`（参考 store 模式） |
| 修改/创建文件 | `src-electron/renderer/src/stores/navigation.ts`, `src-electron/renderer/src/stores/__tests__/navigation.test.ts` |

**Execution Flow (FG1 内部):** 串行派遣。

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development) → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** 见 Interface Contracts → Module: NavigationStore

#### FG2: UI Integration

**Description:** Wire all UI components to NavigationStore. Four files modified, all depend on FG1's store being ready.

**Tasks:** Task 2, Task 3, Task 4

**Files (预估):** 3 个文件（3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（前端: medium, reviewer: medium） |
| 注入上下文 | Task 2-4 描述、spec FR-3/FR-4/AC-1/AC-5/AC-6、前端编码规范、具体行号引用 |
| 读取文件 | `src-electron/renderer/src/stores/navigation.ts`（FG1 产出）, `AppSidebar.vue`, `SettingsView.vue`, `App.vue` |
| 修改/创建文件 | `AppSidebar.vue`, `SettingsView.vue`, `App.vue` |

**Execution Flow (FG2 内部):** 串行派遣。

  Task 2 (sidebar):
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 3 (settings view):
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 4 (app.vue):
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** FG1（需要 NavigationStore 已创建）

**设计细节:** 见 Interface Contracts → Module: App.vue / AppSidebar.vue / SettingsView.vue

#### FG3: Cleanup

**Description:** Remove deprecated settingsStore.currentView and setView. Update AppHeader. Final verification.

**Tasks:** Task 5

**Files (预估):** 3 个文件（3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: medium, reviewer: medium） |
| 注入上下文 | Task 5 描述、C-3 约束、需要 grep 验证零残留引用 |
| 读取文件 | `src-electron/renderer/src/stores/settings.ts`, `AppHeader.vue`, `AppSidebar.vue` |
| 修改/创建文件 | `settings.ts`, `AppHeader.vue`, `AppSidebar.vue` |

**Execution Flow (FG3 内部):** 串行派遣。

  Task 5:
    1. general-purpose → 修改代码 + grep 验证
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** FG2（所有组件已迁移到 navStore）

## Dependency Graph & Wave Schedule

```
FG1 (store) ──→ FG2 (UI integration) ──→ FG3 (cleanup)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | FG1 | NavigationStore 创建 + 测试，无依赖 |
| Wave 2 | FG2 | UI 组件接入，依赖 FG1 store 就绪 |
| Wave 3 | FG3 | 清理废弃代码，依赖 FG2 所有组件已迁移 |
