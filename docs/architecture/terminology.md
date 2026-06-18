# 术语对齐重构计划

**目标**: 将代码命名与 [context.md](context.md) 领域术语统一。项目未上线，改动成本低。

**前置条件**: 当前 worktree 分支干净，无未提交变更。

---

## 重构清单

### R1: sidecar → runtime

**范围**: 目录、workspace、import 路径、变量名

**涉及文件**:

| 类别 | 变更 |
|------|------|
| 目录 | `src-electron/sidecar/` → `src-electron/runtime/` |
| workspace 名 | `@xyz-agent/sidecar` → `@xyz-agent/runtime` |
| `src-electron/package.json` | `"@xyz-agent/sidecar"` → `"@xyz-agent/runtime"` |
| `package.json`（根） | workspace 路径引用 |
| `src-electron/main/sidecar-manager.ts` | → `runtime-manager.ts`，内部 class 重命名 |
| `src-electron/main/main.ts` | import sidecar-manager → runtime-manager |
| `src-electron/main/ipc-handlers.ts` | import 更新 |
| `src-electron/tsconfig.json` | paths/reference 更新 |
| `src-electron/vite.config.main.ts` | 如有 sidecar 引用 |
| 所有 import `sidecar/` | → `runtime/` |
| 所有注释中的 "sidecar" | → "Agent Runtime" 或 "runtime" |

**执行步骤**:
1. `git mv src-electron/sidecar src-electron/runtime`
2. `git mv src-electron/main/sidecar-manager.ts src-electron/main/runtime-manager.ts`
3. 批量替换 workspace 名和 import 路径
4. `npm run build` + `npm run dev` 验证

---

### R2: Pane → Panel

**范围**: 共享类型、前端 stores、组件

**涉及文件**:

| 类别 | 变更 |
|------|------|
| `shared/src/pane.ts` | → `panel.ts`，`PaneLeaf` → `PanelLeaf`，`PaneTree` → `PanelTree`，`SplitNode` 保持（内部结构概念） |
| `shared/src/index.ts` | export 更新 |
| `stores/pane.ts` | → `stores/panel.ts`，`usePaneStore` → `usePanelStore` |
| `stores/window.ts` | import 更新 |
| `stores/chat.ts` | 如有 pane 引用 |
| `components/panel/PaneSessionView.vue` | → `PanelSessionView.vue`（已在 panel 目录下，合理） |
| `components/panel/PaneTreeRenderer.vue` | → `PanelTreeRenderer.vue` |
| `components/panel/EmptyPane.vue` | → `EmptyPanel.vue` |
| `main/window-manager.ts` | `PaneTree` → `PanelTree`，函数名更新 |
| `preload/` | 如暴露了 pane 相关 API |
| 所有 import 和变量名 | pane → panel |

**注意**: `SplitDivider` 和 `SplitNode` 不改名——split 是布局概念，不是 pane 的同义词。

**执行步骤**:
1. 重命名 `shared/src/pane.ts` → `panel.ts`，替换类型名
2. 重命名 `stores/pane.ts` → `panel.ts`，替换 store 名
3. 重命名组件文件
4. 更新 `window-manager.ts` 类型引用
5. 全局搜索 `usePaneStore`、`PaneLeaf`、`PaneTree`、`paneId` 等替换
6. `npm run build` + `npm run dev` 验证

---

### R3: SystemChatMessage → SystemNotification

**范围**: chat store、UI 组件

**涉及文件**:

| 类别 | 变更 |
|------|------|
| `stores/chat.ts` | `SystemChatMessage` → `SystemNotification`，`ChatMessage` → `ChatMessage`（联合类型保持） |
| `composables/useChat.ts` | `role: 'system'` 的 Message 改为 `SystemNotification`（补充 systemType 等字段） |
| `components/chat/SystemMessage.vue` | → `SystemNotification.vue` |
| `components/panel/ChatPanel.vue` | import 和类型断言更新 |
| `components/panel/PaneSessionView.vue` | import 更新 |

**额外清理**: 统一 `Message(role='system')` 和 `SystemChatMessage` 的混用。所有前端本地生成的通知统一走 `SystemNotification` 接口。

**执行步骤**:
1. `stores/chat.ts` 重命名 interface
2. `useChat.ts` 的 `onError` 和 `abort` 中创建的通知改为 `SystemNotification`
3. 重命名 `SystemMessage.vue` → `SystemNotification.vue`
4. 全局搜索 `SystemChatMessage`、`as any`（ChatPanel 里的类型断言）清理
5. `npm run lint` + `npm run dev` 验证

---

### R4: Drawer → SideInspector

**范围**: 组件文件名、settings store 中的 drawer 相关变量、事件名

**涉及文件**:

| 类别 | 变更 |
|------|------|
| `components/panel/DrawerOverlay.vue` | → `SideInspectorOverlay.vue` |
| `stores/settings.ts` | `drawerOpen` → `inspectorOpen`，`drawerSide` → `inspectorSide`，`openDrawer` → `openInspector`，`closeDrawer` → `closeInspector` |
| 所有引用 drawer 的组件 | emit 事件名 `open-drawer` → `open-inspector` |
| `CLAUDE.md` | 文档更新 |

**执行步骤**:
1. 重命名组件文件
2. 替换 settings store 中的变量和方法名
3. 更新所有引用组件的 emit 和调用
4. `npm run lint` + `npm run dev` 验证

---

### R5: Overview → PanelGrid

**范围**: 组件文件名、settings store 中的 overview 相关变量

**涉及文件**:

| 类别 | 变更 |
|------|------|
| `components/overview/` 目录 | → `components/panel-grid/` |
| `stores/settings.ts` | `overviewVisible` → `panelGridVisible`，`toggleOverview` → `togglePanelGrid` |
| 所有引用 overview 的组件 | 更新 |
| `CLAUDE.md` | 文档更新 |

**执行步骤**:
1. `git mv components/overview components/panel-grid`
2. 替换 settings store 变量和方法
3. 更新引用
4. `npm run lint` + `npm run dev` 验证

---

## 执行顺序

```
R1 (sidecar→runtime)      ← 最先，影响最广但机械替换
│
├─→ R2 (Pane→Panel)       ← 可与 R3 并行，互不依赖
│
├─→ R3 (SystemChatMessage)
│
├─→ R4 (Drawer→SideInspector)   ← 纯 UI 层，互不依赖
│
└─→ R5 (Overview→PanelGrid)
```

R2-R5 之间无依赖，可并行执行。R1 影响面最大（涉及 npm workspace），先完成再做其余。

## 风险

| 风险 | 缓解 |
|------|------|
| import 路径遗漏导致编译失败 | 每步完成后 `npm run build` 验证 |
| preload 桥接 API 变更 | 检查 `preload/index.ts` 暴露给前端的接口名是否需要同步改 |
| localStorage key 变更 | settings store persist key 保持 `xyz-settings` 不变，只改变量名 |
| git 历史追踪断裂 | 使用 `git mv` 而非删除+新建 |

## 验证清单

每个 R 完成后执行：
- [ ] `npm run build` 通过
- [ ] `npm run dev` 启动正常，Electron 窗口可交互
- [ ] `npm run lint` 通过
- [ ] 功能验证：创建 session、发送消息、分屏、切模型
