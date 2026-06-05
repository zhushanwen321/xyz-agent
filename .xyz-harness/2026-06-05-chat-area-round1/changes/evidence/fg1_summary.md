# FG1 Summary: Message Operations & Batch Selection

## Completed Tasks

| Task | Description | Status |
|------|-------------|--------|
| Task 1 | `collectMessageContent` + `clipboard` 工具函数 + 测试 | ✅ |
| Task 2 | `MessageActionMenu` 组件 | ✅ |
| Task 3 | `MessageBubble` 集成 `⋯` 按钮 | ✅ |
| Task 4 | `BatchSelectBar` 组件 | ✅ |
| Task 5 | `PanelBar` 添加 `≡` 入口 | ✅ |
| Task 6 | `BranchIndicator` 组件 | ✅ |

## Changed Files

### New files (7):
1. `src-electron/renderer/src/lib/collectMessageContent.ts` — 收集消息内容（thinking + tool call + body）
2. `src-electron/renderer/src/lib/clipboard.ts` — `copyWithToast()` via event-bus
3. `src-electron/renderer/src/lib/__tests__/collectMessageContent.spec.ts` — 9 tests
4. `src-electron/renderer/src/lib/__tests__/clipboard.spec.ts` — 3 tests
5. `src-electron/renderer/src/components/chat/MessageActionMenu.vue` — 操作菜单（复制/纯文本/Navigate/Fork/Clone stub）
6. `src-electron/renderer/src/components/chat/BatchSelectBar.vue` — 批量选择浮动栏
7. `src-electron/renderer/src/components/chat/BranchIndicator.vue` — 分支指示器 pill

### Modified files (2):
1. `src-electron/renderer/src/components/chat/MessageBubble.vue` — 添加 `⋯` 按钮 + BranchIndicator 集成 + MessageActionMenu
2. `src-electron/renderer/src/components/panel/PanelBar.vue` — 添加 `≡` 按钮 + `toggle-batch-select` emit

## Commits
```
a5c58e5 feat(chat-area-round1): task 1 collectMessageContent + clipboard utils
4b1e619 feat(chat-area-round1): task 2 MessageActionMenu component
618f844 feat(chat-area-round1): task 3+6 MessageBubble ⋯ button + BranchIndicator
51e11e7 feat(chat-area-round1): task 4 BatchSelectBar component
ff83866 feat(chat-area-round1): task 5 PanelBar ≡ batch select entry
cd088a7 feat(chat-area-round1): lint fixes for BranchIndicator + BatchSelectBar
```

## Test Results
- collectMessageContent: **9 passed**
- clipboard: **3 passed**
- Total: **12 passed, 0 failed**

## Lint Results
- **0 errors** (pre-existing warnings in UtilityRail.vue and WidgetDock.vue only)
- All new files pass lint cleanly

## Design Decisions

1. **Toast via event-bus**: `clipboard.ts` emits `toast:show` event through the existing `event-bus.ts` infrastructure. `App.vue` needs a listener for `toast:show` to bridge to the toast system (to be wired in integration).

2. **BranchIndicator branchTabs**: Currently returns empty array. Needs integration with `MessageList.vue` + `useTree` to pass actual `BranchTab[]` data. The component accepts the data structure but the parent must provide it through the tree store's `getActivePath()`.

3. **Fork/Clone stubs**: Menu items render with `opacity: 0.45` and close the menu without action. Task 23 will fill in the actual WS calls.

4. **Menu positioning**: `MessageActionMenu` uses `Teleport to="body"` with `anchorRect`-based positioning, consistent with existing context menu patterns in PanelBar.

## Spec Gaps / Notes

1. **BranchIndicator data flow**: The spec says "数据来源：`stores/tree.ts` 的 `BranchTab[]`，通过 `getActivePath()` 获取" but `getActivePath()` returns `PathNode[]` where `branchTabs` are embedded inside each `PathNode`. The `BranchIndicator` needs the `branchTabs` from the corresponding `PathNode`, which requires `MessageList` to compute and pass them as props. This is an integration concern, not a component bug.

2. **Batch select state**: The spec describes checkbox/selection behavior in MessageList, but that's integration work beyond component creation. `BatchSelectBar` is ready to receive `selectedIds` and emit actions.

3. **`data-entry-id` attribute**: Added to MessageBubble wrapper for `collectMessageContent` to find the correct message element. MessageList integration needs to pass `entryId` prop to each MessageBubble.

## Blockers
None.
