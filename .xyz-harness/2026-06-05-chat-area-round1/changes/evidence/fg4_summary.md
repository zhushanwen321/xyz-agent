# FG4 Summary: macOS Fullscreen Layout

**Execution Group:** FG4 (4 Tasks: 15→16→13→14)
**Acceptance Criteria:** AC9 — macOS 窗口化/全屏两种布局各元素位置正确
**Result:** ✅ All 4 tasks completed, lint passes with 0 errors

## Commits

| # | Commit | Task | File |
|---|--------|------|------|
| 1 | `62eb67d` | Task 15 | `src-electron/main/window-manager.ts` |
| 2 | `e851ac1` | Task 16 | `src-electron/preload/preload.ts` + `index.d.ts` |
| 3 | `0cf17be` | Task 13 | `src-electron/renderer/src/style.css` |
| 4 | `a0ad8d1` | Task 14 | `src-electron/renderer/src/App.vue` |

## Implementation Details

### Task 15: window-manager.ts — Register fullscreen events
- Added `win.on('enter-full-screen')` and `win.on('leave-full-screen')` listeners inside `WindowManager.register()`
- Forwards state to renderer via `win.webContents.send('fullscreen-changed', { isFullscreen: boolean })`
- Events registered per-window during `register()`, cleaned up automatically when window closes

### Task 16: preload.ts — Expose fullscreen API
- Added `onFullscreenChanged(callback: (payload: { isFullscreen: boolean }) => void): () => void` to `ElectronAPI` interface
- Implementation wraps `ipcRenderer.on('fullscreen-changed', ...)` and returns cleanup function
- Updated `index.d.ts` type declaration to match

### Task 13: style.css — .is-fullscreen layout rules
- `.is-fullscreen .sidebar-row1 { padding-left: 14px !important }` — removes traffic-light padding
- `.is-fullscreen .sidebar-row2 .sidebar-brand { display: none !important }` — hides brand from Row2
- `.is-fullscreen .sidebar__new { width: 100% !important }` — full-width New Session button
- `!important` used to override AppSidebar's scoped styles

### Task 14: App.vue — Fullscreen class toggle
- Added `ref="appContainer"` to root `<div>` and `const appContainer = ref<HTMLElement | null>(null)`
- In `onMounted`, calls `window.electronAPI.onFullscreenChanged(...)` to toggle `.is-fullscreen` class
- Cleanup handled via existing `ipcCleanupFns` array in `onUnmounted`

## Data Flow

```
Electron BrowserWindow event (enter/leave-full-screen)
  → WindowManager.register() listener
  → webContents.send('fullscreen-changed', { isFullscreen })
  → preload: ipcRenderer.on('fullscreen-changed')
  → renderer: window.electronAPI.onFullscreenChanged(callback)
  → App.vue: appContainer.classList.add/remove('is-fullscreen')
  → style.css: .is-fullscreen overrides sidebar layout
```

## Lint Result

```
npm run lint → 0 errors, 4 warnings (all pre-existing, none from FG4 changes)
```

## Notes

- `AppSidebar.vue` already has conditional rendering for fullscreen (brand in Row1 vs Row2, wide button) driven by a local `isFullscreen` ref (currently hardcoded `false` with TODO comment). The CSS-based approach in style.css provides layout overrides from the parent level. Both mechanisms coexist — the CSS rules apply when `.is-fullscreen` is present on the app-container, while AppSidebar's own scoped logic would need its ref connected separately (outside FG4 scope).
