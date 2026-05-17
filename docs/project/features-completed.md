# 已实现功能清单

基于 2026-05-17 代码库实际状态，对照最早设计规格（`.superpowers/2026-05-06-hello-pi/spec-v3.md`）梳理。

架构已从原始规划的 Tauri v2 迁移到 Electron。

---

## 1. 基础架构

### 1.1 三层架构 ✅

```
Electron 主进程 (src-electron/main/)
  → 渲染进程 (src-electron/renderer/)  Vue 3 + Pinia + Tailwind v3
  → Sidecar (src-electron/sidecar/)     Node.js WebSocket 服务，通过 RPC 与 pi 通信
  → 共享类型 (src-electron/shared/)     前端与 sidecar 之间共享 TypeScript 类型
```

| 模块 | 状态 | 文件 |
|------|------|------|
| Electron 主进程 | ✅ | `main/main.ts`, `window-manager.ts`, `sidecar-manager.ts`, `shortcuts.ts`, `ipc-handlers.ts` |
| Preload 桥接 | ✅ | `preload/preload.ts`, `preload/index.d.ts` |
| Sidecar WS 服务 | ✅ | `sidecar/src/index.ts`, `server.ts` |
| 共享类型 | ✅ | `shared/src/protocol.ts`, `message.ts`, `session.ts`, `provider.ts`, `settings.ts`, `pane.ts`, `errors.ts` |

### 1.2 Sidecar 核心模块 ✅

| 模块 | 文件 | 说明 |
|------|------|------|
| RPC 客户端 | `rpc-client.ts` | pi 子进程 stdin/stdout JSONL 通信 |
| 进程管理 | `process-manager.ts` | pi 子进程生命周期（spawn/kill/health/restart） |
| Session 池 | `session-pool.ts` | `Map<sessionId, RpcClient>` 管理 |
| 事件适配 | `event-adapter.ts` | pi RPC 事件 → WS 协议事件翻译 |
| 配置管理 | `config-store.ts` | 读写 `~/.xyz-agent/` 下的配置 |
| Provider 管理 | `provider-store.ts` | API Key 存储与传递 |
| 模型数据库 | `model-db.ts` | 可用模型列表 |
| Skill 扫描 | `skill-scanner.ts` | 扫描本地 skill 文件 |
| Agent 扫描 | `agent-scanner.ts` | 扫描本地 agent 文件 |
| Session 扫描 | `session-scanner.ts` | 扫描已有 session |
| 垃圾回收 | `trash.ts` | session 删除处理 |

---

## 2. Design System

### 2.1 基础组件（12 个）✅

| 组件 | 文件 | 说明 |
|------|------|------|
| Button | `design-system/components/Button.vue` | primary/ghost/danger, sm/md/lg |
| Input | `design-system/components/Input.vue` | 单行输入 |
| Textarea | `design-system/components/Textarea.vue` | 多行，自适应高度 |
| Select | `design-system/components/Select.vue` | 下拉选择 |
| ScrollArea | `design-system/components/ScrollArea.vue` | 自定义滚动条 |
| Tooltip | `design-system/components/Tooltip.vue` | 悬浮提示 |
| Dropdown | `design-system/components/Dropdown.vue` | 下拉菜单 |
| Dialog | `design-system/components/Dialog.vue` | 模态对话框 |
| Tabs | `design-system/components/Tabs.vue` | 标签切换 |
| Badge | `design-system/components/Badge.vue` | 状态标记 |
| Toggle | `design-system/components/Toggle.vue` | 开关 |
| ProgressBar | `design-system/components/ProgressBar.vue` | 进度条 |

### 2.2 主题系统 ✅

- 明/暗主题 + 多色板预设（`warm-teal`, `terracotta` 等）
- CSS 变量驱动，`data-theme` + `data-palette` 属性切换
- `ThemeProvider.vue` + `useTheme.ts`
- OKLch 色彩空间
- 文件：`design-system/tokens/colors.ts`, `spacing.ts`, `typography.ts`

### 2.3 工具函数 ✅

- `design-system/utils.ts` — `cn()` 类名合并等
- `design-system/index.ts` — 统一导出

---

## 3. 前端功能

### 3.1 App Shell ✅

| 组件 | 文件 | 说明 |
|------|------|------|
| AppHeader | `layout/AppHeader.vue` | Logo + 视图切换 + 设置 + 主题 |
| AppStatusbar | `layout/AppStatusbar.vue` | 连接状态 + cwd + 模型 + token |
| AppSidebar | `layout/AppSidebar.vue` | Session 列表容器 |
| SettingsView | `layout/SettingsView.vue` | 全屏设置视图（4 Tab） |

视图切换：状态驱动（`settingsStore.currentView` + `focusMode`），无 vue-router。

### 3.2 Sidebar — Session 管理 ✅

| 组件 | 文件 | 说明 |
|------|------|------|
| SessionSearch | `sidebar/SessionSearch.vue` | 搜索过滤 |
| SessionGroup | `sidebar/SessionGroup.vue` | 按 cwd 自动分组，可折叠 |
| SessionItem | `sidebar/SessionItem.vue` | 状态圆点 + 标题 + 相对时间 + 右键菜单 |

功能：搜索、新建、删除、切换、重命名。

### 3.3 Chat — 核心对话 ✅

| 组件 | 文件 | 说明 |
|------|------|------|
| ChatInput | `chat/ChatInput.vue` | 自适应高度 + ModelPicker + 发送/中断 + Slash 命令触发 |
| MessageList | `chat/MessageList.vue` | 稳定消息列表（completedMessages） |
| StreamingMessage | `chat/StreamingMessage.vue` | 流式消息容器（rAF 批处理） |
| MessageBubble | `chat/MessageBubble.vue` | user/assistant/system 三态 |
| ThinkingBlock | `chat/ThinkingBlock.vue` | 思考过程，默认折叠 |
| ToolCallCard | `chat/ToolCallCard.vue` | 工具调用卡片（注册表分发） |
| ApprovalCard | `chat/ApprovalCard.vue` | 工具审批：Allow/Deny/Always Allow + 60s 倒计时 |
| ModelPicker | `chat/ModelPicker.vue` | 模型选择（分组下拉） |
| ContextBar | `chat/ContextBar.vue` | 上下文用量进度条（三级颜色） |
| SlashMenu | `chat/SlashMenu.vue` | / 命令浮层菜单（注册表驱动） |
| SystemMessage | `chat/SystemMessage.vue` | 系统消息渲染 |

### 3.4 工具渲染器 ✅

注册表模式（`tool-renderer-registry.ts`），ToolCallCard 按工具名分发。

| 渲染器 | 文件 | 特化展示 |
|--------|------|---------|
| BashToolRenderer | `ToolRenderers/BashToolRenderer.vue` | 终端风格输出 |
| EditToolRenderer | `ToolRenderers/EditToolRenderer.vue` | diff 视图（红色删除 + 绿色新增） |
| ReadToolRenderer | `ToolRenderers/ReadToolRenderer.vue` | 文件预览 |
| WriteToolRenderer | `ToolRenderers/WriteToolRenderer.vue` | 文件预览 |
| DefaultToolRenderer | `ToolRenderers/DefaultToolRenderer.vue` | JSON 折叠 |

### 3.5 Settings — 设置视图 ✅

4 个标签页，每个都是完整功能实现（非占位）。

| Tab | 组件 | 功能 |
|-----|------|------|
| Providers | `ProviderPane/Section/Modal` | Provider 添加/编辑/删除/连接状态 |
| Skills | `SkillsPane/Section/Modal` | Skill 扫描（Pi/Claude Code/Agents 目录）/导入/编辑/删除 |
| Agents | `AgentsPane/Section/Modal` | Agent 扫描/导入/编辑/删除 |
| System | `SystemPane` | 主题/语言等系统设置 |

辅助组件：`ScanImportSection.vue`, `ModelRow.vue`, `ToggleSwitch.vue`, `MarkdownEditor.vue`, `MetaGrid.vue`, `TagPill.vue`

### 3.6 Panel 多面板系统 ✅

| 组件 | 文件 | 说明 |
|------|------|------|
| PanelBar | `panel/PanelBar.vue` | 面板顶部栏 + Anchor 下拉 |
| ChatPanel | `panel/ChatPanel.vue` | 单面板完整对话视图 |
| PaneSessionView | `panel/PaneSessionView.vue` | 面板内 session 视图 |
| SplitDivider | `panel/SplitDivider.vue` | 分屏拖拽分隔线 |
| EmptyPane | `panel/EmptyPane.vue` | 空面板占位 |
| PaneTreeRenderer | `panel/PaneTreeRenderer.vue` | 面板树渲染 |
| AnchorDropdown | `panel/AnchorDropdown.vue` | 面板锚点下拉 |
| DrawerOverlay | `panel/DrawerOverlay.vue` | 抽屉叠加层 |

支持：分屏、Anchor 切换、面板内独立 session。

### 3.7 Drawer 抽屉面板 ✅

| 组件 | 文件 | 说明 |
|------|------|------|
| DrawerLeft | `drawer/DrawerLeft.vue` | 左侧抽屉 |
| DrawerRight | `drawer/DrawerRight.vue` | 右侧抽屉 |
| DrawerTabs | `drawer/DrawerTabs.vue` | 抽屉内 Tab 切换 |
| TaskTree | `drawer/TaskTree.vue` | 任务树 |
| TreeNodeItem | `drawer/TreeNodeItem.vue` | 树节点 |
| AlertItem | `drawer/AlertItem.vue` | 告警项 |
| DoneItem | `drawer/DoneItem.vue` | 完成项 |

### 3.8 Overview 全局总览 ✅

| 组件 | 文件 | 说明 |
|------|------|------|
| Overview | `overview/Overview.vue` | Mission Control 全局鸟瞰 |
| WindowCard | `overview/WindowCard.vue` | 窗口卡片 |
| PaneTreeMini | `overview/PaneTreeMini.vue` | 迷你面板树 |

### 3.9 Toast 通知 ✅

`toast/ToastContainer.vue`

---

## 4. 前端状态管理与 Composables

### 4.1 Pinia Stores ✅

| Store | 文件 | 职责 |
|-------|------|------|
| useChatStore | `stores/chat.ts` | 对话状态（completedMessages + streamingMessage 分离）、Session 分区 |
| useSessionStore | `stores/session.ts` | Session 列表、当前 Session ID |
| useSettingsStore | `stores/settings.ts` | 主题、语言、默认模型、视图状态 |
| useProviderStore | `stores/provider.ts` | Provider、Skill、Agent 管理 |
| usePaneStore | `stores/pane.ts` | 面板树结构 |
| useWindowStore | `stores/window.ts` | 多窗口管理 |

### 4.2 Composables ✅

| Composable | 文件 | 职责 |
|------------|------|------|
| useChat | `composables/useChat.ts` | 消息收发、流式事件处理（全局 listener + sessionId 路由） |
| useSession | `composables/useSession.ts` | Session CRUD + 切换 |
| useProvider | `composables/useProvider.ts` | Provider 配置管理 |
| useModel | `composables/useModel.ts` | 模型列表 + 切换 |
| useConnection | `composables/useConnection.ts` | WebSocket 连接（Electron IPC 端口发现 + 自动重连） |
| useRafBatch | `composables/useRafBatch.ts` | rAF 批处理（16ms 合并 delta） |
| useSlashCommands | `composables/useSlashCommands.ts` | Slash 命令注册表 |
| useContext | `composables/useContext.ts` | 上下文用量 |

### 4.3 基础设施 ✅

| 模块 | 文件 | 职责 |
|------|------|------|
| ws-client | `lib/ws-client.ts` | WebSocket 客户端（连接/发送/状态） |
| event-bus | `lib/event-bus.ts` | 前端事件总线 |
| markdown | `lib/markdown.ts` | markdown-it + DOMPurify |
| tool-renderer-registry | `lib/tool-renderer-registry.ts` | 工具渲染器注册表 |
| register-tool-renderers | `lib/register-tool-renderers.ts` | 渲染器注册 |

---

## 5. 国际化 ✅

- `i18n/index.ts` — vue-i18n 配置
- `i18n/types.ts` — Schema 类型
- `i18n/locales/zh-CN.ts` — 中文
- `i18n/locales/en-US.ts` — 英文

---

## 6. 代码规范基础设施 ✅

### 6.1 ESLint 自定义规则（taste-lint）

| 规则 | 文件 |
|------|------|
| no-emoji-in-template | `taste-lint/rules/no-emoji-in-template.mjs` |
| no-hardcoded-colors | `taste-lint/rules/no-hardcoded-colors.mjs` |
| no-magic-spacing | `taste-lint/rules/no-magic-spacing.mjs` |
| no-multi-arg-emit | `taste-lint/rules/no-multi-arg-emit.mjs` |
| no-native-html-elements | `taste-lint/rules/no-native-html-elements.mjs` |
| no-silent-catch | `taste-lint/rules/no-silent-catch.mjs` |
| no-unsafe-object-entries | `taste-lint/rules/no-unsafe-object-entries.mjs` |
| prefer-allsettled | `taste-lint/rules/prefer-allsettled.mjs` |
| prefer-v-model | `taste-lint/rules/prefer-v-model.mjs` |

### 6.2 Git Hooks

- `.githooks/install-hooks.sh` — 自动安装
- `.githooks/vue_rules_checker.py` — 行数/Emoji/CSS/Tab 检查

---

## 7. WS 协议 ✅

完整的双向消息协议，定义在 `shared/src/protocol.ts`：

**客户端 → Sidecar**：session.create/delete/list/switch/history/compact/clear/restore/rename、message.send/abort、config.getProviders/setProvider/deleteProvider/setToolPermissions/discoverModels/scanSkills/setSkill/deleteSkill/scanAgents/setAgent/deleteAgent、model.list/switch、tool.approve/deny/always_allow、ping

**Sidecar → 客户端**：session.created/deleted/list/history/compacting/compacted/restored/renamed、message.message_start/text_delta/thinking_delta/thinking_start/thinking_end/tool_call_start/tool_call_end/tool_call_pending/complete/error/status、context.update、config.providers/providerUpdated/discoveredModels/scannedSkills/skillUpdated/skillDeleted/scannedAgents/agentUpdated/agentDeleted/skills/agents、model.list/switched、pong、error

---

## 8. Mock 模式 ✅

- `mock/mock-ws.ts` — 模拟 WebSocket 服务
- `mock/data.ts` — 模拟数据
- 通过 `VITE_MOCK=true` 启用
