# 前端 v3 重建 — 前端设计细节

> plan.md 的子文档。承载详细 File Structure + Interface Contracts（完整方法签名表）。主文档 plan.md 保留总纲 + Execution Groups + 强制矩阵。

## 1. File Structure（按 Execution Group 分组）

| File | Type | Group | Description |
|------|------|-------|-------------|
| `renderer/src/style.css` | modify | FG0 | design-tokens → CSS 变量（`--bg`/`--accent`/`--radius-*` 等） |
| `renderer/tailwind.config.ts` | modify | FG0 | borderRadius(3/8/12)、colors、fontFamily(Inter) |
| `components.json` | create | FG0 | shadcn-vue 配置（style: design-tokens 映射） |
| `renderer/src/components/ui/` | create(dir) | FG0 | shadcn-vue 增量装（Button/Input/ScrollArea/Tooltip/Dialog...） |
| `composables/useChat.test.ts`(symlink) | delete | FG0 | 断链 symlink 清理 |
| `composables/useSlashCommands.test.ts`(symlink) | delete | FG0 | 断链 symlink 清理 |
| `renderer/src/api/index.ts` | create | FG1 | 门面入口（聚合 domains） |
| `renderer/src/api/transport.ts` | create | FG1 | WS+IPC 统一管道（封装 ws-client） |
| `renderer/src/api/pending.ts` | create | FG1 | 命令 id → Promise 映射（crypto.randomUUID） |
| `renderer/src/api/events.ts` | create | FG1 | 事件订阅分发（sessionId 路由第 2 层） |
| `renderer/src/api/domains/session.ts` | create | FG1 | session 域方法 |
| `renderer/src/api/domains/chat.ts` | create | FG1 | chat 域方法 |
| `renderer/src/api/mock/index.ts` | create | FG1 | mock 门面（同 api 接口） |
| `renderer/src/api/mock/data.ts` | create | FG1 | fixture 数据（参考 main 结构，从零写） |
| `renderer/src/stores/navigation.ts` | create | FG1 | 导航历史栈（main 模式 + overview view） |
| `renderer/src/stores/session.ts` | create | FG1 | session 列表 + D6 派生 status |
| `renderer/src/components/shell/AppShell.vue` | create | FG2 | L0 容器（aside + main 布局） |
| `renderer/src/components/shell/AsideRegion.vue` | create | FG2 | 透明 sidebar 容器槽 |
| `renderer/src/components/shell/MainPanel.vue` | create | FG2 | float 主区槽（view 路由） |
| `renderer/src/App.vue` | modify | FG2 | 挂载 AppShell + traffic light 安全区 |
| `renderer/src/components/sidebar/Sidebar.vue` | create | FG3 | L1 容器（四态） |
| `renderer/src/components/sidebar/SegmentedTab.vue` | create | FG3 | 会话/文件 tab 切换 |
| `renderer/src/components/sidebar/SessionList.vue` | create | FG3 | 会话列表 |
| `renderer/src/components/sidebar/SessionItem.vue` | create | FG3 | 单项 + 状态点（D6） |
| `renderer/src/stores/sidebar.ts` | create | FG3 | tab/collapsed 状态 |
| `composables/features/useSidebar.ts` | create | FG3 | sidebar 业务编排 |
| `renderer/src/components/workspace/Workspace.vue` | create | FG4 | 双 Panel 主从容器 |
| `renderer/src/components/workspace/PanelContainer.vue` | create | FG4 | Panel 挂载点 + split 状态机 |
| `renderer/src/components/panel/Panel.vue` | create | FG4 | Panel 容器（5 zone 编排） |
| `renderer/src/components/panel/{PanelHeader,ProgressZone,GitZone}.vue` | create | FG4 | zone 空壳（占位 throw） |
| `renderer/src/stores/panel.ts` | create | FG4 | PanelTree + activePanelId |
| `renderer/src/components/panel/MessageStream.vue` | create | FG5 | 7 块 + 回合折叠 |
| `renderer/src/components/panel/message-stream/{Turn,Block}.vue` | create | FG5 | 消息块子组件 |
| `renderer/src/components/panel/Composer.vue` | create | FG5 | composer（S1/S2/S5/S6 主路径） |
| `renderer/src/stores/chat.ts` | create | FG5 | messages + isStreaming |
| `composables/features/useChat.ts` | create | FG5 | send/abort 编排 |
| `composables/effects/useChatScroll.ts` | create | FG5 | auto-scroll 基础版 |
| `renderer/src/components/overview/Overview.vue` | create | FG6 | 卡片网格骨架 |
| `renderer/src/components/overview/SessionCard.vue` | create | FG6 | 单卡片 |
| `renderer/src/components/settings/SettingsModal.vue` | create | FG6 | 骨架（hide 入口） |
| `renderer/src/components/overlays/SearchModal.vue` | create | FG6 | 骨架（hide 入口） |

> lib/（ws-client/event-bus/ipc）已存在，FG1 仅在 transport.ts 中封装复用。useConnection 保留（连接态 UI）。

## 1.5 FG1 执行顺序（C 方案：骨架优先）

FG1 分两步交付，骨架先行让 tsc 成为契约强制（防 subagent 臆造类型，如 review 暴露的 StreamChunk 问题）：

**步骤 A — 骨架（tsc 绿即交付）：**
- `renderer/src/types.ts`：本地类型（NavEntry / PanelTreeNode / DerivedStatus）
- api/ 五层（index/transport/pending/events）+ domains（session/chat）+ mock/index：全部签名 + `throw new Error('not implemented')`
- stores/（navigation/session/chat/panel/sidebar）：Pinia setup store 骨架，state + getter 签名 + action throw
- 验证：`npx vue-tsc --noEmit` 绿 + `npm run lint` 绿 → commit "骨架"

**步骤 B — 填实现：**
- 按 T1.1-T1.4 填方法体 + mock/data.ts 最小 fixture
- 验证：tsc + lint 绿 + mock 契约单测 → commit "实现"

骨架文件低密度（每个 ~5-15 行 throw），按行数约束（≤3000）评估，文件数可超 5。

## 2. Interface Contracts

### Module: api

#### transport
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| connect | () => Promise<void> | Promise | mock 200ms 直进 connected | D2/D7 |
| send | (msg: ClientMessage) => void | void | 未连接时 queue | §6.3 |
| on | (h: (m: ServerMessage) => void) => () => void | unsubscribe | — | §6.3 |

#### domains/session
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| list | () => Promise<SessionSummary[]> | Promise | mock 返回全字段（D7） | UC-3 |
| create | (title?: string) => Promise<SessionSummary> | Promise | 默认标题 | UC-2 |
| switchSession | (id: string) => Promise<void> | Promise | id 无效 → 抛（`switch` 是 TS 保留字，用 switchSession） | UC-3 |

#### domains/chat
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| send | (sessionId: string, text: string) => Promise<void> | Promise | mock 不模拟失败（D7） | UC-2 |
| getHistory | (sessionId: string) => Promise<Message[]> | Promise | mock 返回 fixture 深拷贝 | UC-2 |
| abort | (sessionId: string) => Promise<void> | Promise | DEFERRED 流转 | §9 G-025 |
| streamSubscribe | (sessionId: string, h: (msg: ServerMessage) => void) => () => void | unsubscribe | handler 内过滤 `message.text_delta`/`message.thinking_delta` 等事件；ServerMessage 见 protocol.ts | §6.7 |

### Module: stores

#### navigation
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| current | ComputedRef<NavEntry> | entry | — | D1 |
| canBack / canForward | ComputedRef<boolean> | bool | — | D1 |
| push | (e: NavEntry) => void | void | 超 MAX_ENTRIES(50) 丢最早；分支截断 | D1 |
| back / forward | () => void | void | 边界 no-op | D1 |

#### session
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| list | Ref<SessionSummary[]> | array | — | UC-3 |
| activeId | Ref<string\|null> | id | 空态 null | §8.5 |
| active | ComputedRef<SessionSummary\|null> | — | null 触发空态 | UC-1 |
| derivedStatus | (id: string) => ComputedRef<DerivedStatus> | 'running'\|'waiting'\|'done'\|'stopped'\|'error' | 从 message/tool 派生 | D6 |

#### chat
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| messages | Ref<Message[]> | array | 按 sessionId 分区（store 内 Map） | UC-2 |
| isStreaming | Ref<boolean> | bool | — | UC-2 |
| appendUser / appendAssistantChunk / setStreaming | (…) => void | void | — | UC-2 |

#### panel
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| layout | Ref<PanelTree> | tree | 单/双 Panel | P3 |
| activePanelId | Ref<string> | id | — | P3 |

#### sidebar
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| activeTab | Ref<'sessions'\|'files'> | tab | files view 骨架（G2-003 defer 内容） | UC-3 |
| collapsed | Ref<boolean> | bool | — | P2 |

### Module: composables/features
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| useSidebar().selectSession | (id: string) => void | void | push nav + switchSession api | UC-3 |
| useSidebar().newSession | () => Promise<void> | Promise | create + push + select | UC-2 |
| useChat().send | (text: string) => Promise<void> | Promise | store.appendUser + api.send + streamSubscribe | UC-2 |
| useChat().abort | () => Promise<void> | Promise | DEFERRED 中断流转 | §9 |

### Module: composables/effects
| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| useChatScroll().scrollToBottom | () => void | void | — | §8.5 |
| useChatScroll().stickToBottom | Ref<boolean> | bool | 用户上滚暂停 DEFERRED（G2-007） | §9 |

## 3. 数据流链（关键路径）

- **UC-2 发送消息**：`Composer` → `useChat.send` → `store.chat.appendUser` + `api.chat.send` → `api.transport.send`(ws) → mock 回流 `ServerMessage`(message.text_delta 等) → `api.events.streamSubscribe` → `store.chat.appendAssistantChunk` → `MessageStream` 响应式渲染 + `useChatScroll.scrollToBottom`
- **UC-3 切换会话**：`SessionItem` click → `useSidebar.selectSession` → `store.navigation.push` + `api.session.switch` → `store.session.activeId` 更新 → `store.chat` 分区切换 → `MessageStream` 重新渲染
- **连接态**：`api.transport.on` → `useConnection`（保留）→ Shell 连接指示

## 4. NavEntry 类型

```ts
type NavEntry = { view: 'chat' | 'overview' | 'settings'; sessionId?: string; activeTab?: string }
```
