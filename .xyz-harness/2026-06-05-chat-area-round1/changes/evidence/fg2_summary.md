# FG2 Summary: Utility Rail & PanelBody Layout

## Completed Tasks

| Task | Description | Status |
|------|-------------|--------|
| Task 7 | 创建 `UtilityRail` 组件 | ✅ |
| Task 8 | 创建 `PanelBody` flex row 布局 | ✅ |
| Task 9 | 修改 `ChatPanel` 集成 utility-rail | ✅ |

## Changed Files

| File | Action | Description |
|------|--------|-------------|
| `src-electron/renderer/src/components/chat/UtilityRail.vue` | Created | 36px utility rail 组件，含 ChevronUp/ChevronDown 按钮，group-hover 显隐 |
| `src-electron/renderer/src/components/chat/__tests__/UtilityRail.spec.ts` | Created | 8 个测试：按钮显隐、emit 事件、CSS 类验证 |
| `src-electron/renderer/src/components/panel/PanelBody.vue` | Created | flex row 容器 + group class，用于 hover 感应 |
| `src-electron/renderer/src/components/panel/ChatPanel.vue` | Modified | 引入 PanelBody + UtilityRail，添加 scroll 状态追踪和按钮事件处理 |

## Key Design Decisions

1. **PanelBody 不存在 → 创建新组件**: Plan 中说"修改 PanelBody"，但该文件不存在。创建为最小 flex row wrapper（`flex-1 flex flex-row min-w-0 group`），通过 slot 接收内容。

2. **UtilityRail 作为纯展示组件**: 接收 `showScrollTop` / `showScrollBottom` props，由 ChatPanel 计算 scroll 状态。组件本身不处理 scroll 逻辑，只负责 UI 渲染和 emit 事件。

3. **PanelBody 的 `group` class**: UtilityRail 使用 `group-hover:opacity-100` 实现仅在 panel 内容区 hover 时显示。`group` 放在 PanelBody 上，hover 内容区或 rail 本身都会触发显示。

4. **ChatPanel 滚动状态追踪**: 在 `onChatScroll` 中同步更新 `scrollTop`、`scrollHeight`、`clientHeight` ref，通过 computed 属性 `showScrollTop` / `showScrollBottom` 传递给 UtilityRail。阈值 40px 与 spec 一致。

## Lint Result

```
0 errors, 4 warnings (taste/no-native-html-elements — 与 WidgetDock.vue 一致的已知 warning)
```

## Test Result

```
UtilityRail.spec.ts: 8 tests passed
```

## AC Coverage

| AC | Description | Status |
|----|-------------|--------|
| AC6 | Utility rail 出现在每个 panel 右侧，全高贯穿，按钮 hover 显隐正确 | ✅ PanelBody flex row 布局 + group-hover 实现 |
| AC7 | 滚动按钮仅在非顶端/底端时可见 | ✅ 40px 阈值 computed 属性控制 v-if |
| AC12 | 分屏模式下每个 panel 有独立 rail | ✅ 每个 ChatPanel 实例有独立 UtilityRail |

## Blockers

无。PanelBody.vue 文件不存在（plan 假设存在），已作为新文件创建。
