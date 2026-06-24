# Tracing Round 1

> 独立 subagent 隔离追踪产出（fresh context）。主 agent 持久化。

## 追踪范围
- spec 初稿版本：spec-w11.md（2026-06-24），W11+ 前端↔runtime 集成第二轮，11 个功能项 FR-1~FR-11
- 追踪的视角：User Journey（P1）、Data Lifecycle（P2）、API Contract（P3）、State Machine（P4）、Failure Path（P5）——全部追踪，仅 P4 部分降级（见降级表）

## [UNVERIFIED] 项代码核实结论（F 类证据）

### 核实 #1：extension:widget/extension:status 的 dispatch 路由
**结论：走 session 通道。** payload 含 `sessionId`。
- 证据：`src-electron/shared/src/protocol.ts:234-235`
- 路由判定：`src-electron/renderer/src/composables/useConnection.ts:53-58` routeInbound 读 `payload.sessionId`，有 sid → dispatchSession；无 sid → dispatchGlobal。
- 含义：FR-7 的 onWidget/onStatus 订阅必须用 `events.on(sessionId, handler)`，不能用 onGlobalType。

### 核实 #2：SideDrawer 单/双模式触发机制
**结论：panel/spec.md 未定义独立「打开抽屉」按钮，触发来自实体联动。**
- 证据：`docs/page-design/v3/panel/spec.md:54,78,85,88`
- 含义：Diff 排除 + git-zone 移除后，SideDrawer 仅剩 Terminal/Browser tab，触发源缺失（G-012）。

### 核实 #3：compact 按钮放哪
**结论：设计稿无 compact 按钮位。** draft-companion-zones.html 只有 progress-zone + git-zone。
- 含义：FR-6 写「Composer 工具条或 Header」二选一未定（G-013）。

### 核实 #4：FileView 聚合多回合还是末条
**结论：设计稿语义 = 当前 active session 的改动文件（暗示跨回合），与 spec「末条」表述冲突。**
- 证据：`docs/page-design/v3/sidebar/draft-file-view.html:141,157`
- 含义：语义不一致 → D 类 gap（G-014）。

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | F | State Machine | P4/FR-2 | ToolCallStatus 无 'pending'（message.ts:3 = running/completed/error）。tool_call_pending 扩枚举还是映射？ |
| G-002 | F | API Contract | P3/FR-2 | message.tool_call_pending payload 未契约化（ServerMessageMapBase 无条目）。字段？生产侧形状？ |
| G-003 | F | Data Lifecycle | P2/FR-5 | extension.install/uninstall reply 是 config.extensions（非独立推送）。刷新靠 onExtensions 订阅还是 reply 解析？ |
| G-004 | F | API Contract | P3/FR-5 | 三 tab（npm/dir/git）→ 命令映射：install(source)/installDir(path)/installGit(url)，reply 不同（config.extensions vs extension.discovered）。spec 未列映射。 |
| G-005 | F | API Contract | P3/FR-5 | extension.discovered 回 {tempDir,candidates} 后，候选选择 UI 放哪？selected 默认全选？ExtensionPage 无候选组件。 |
| G-006 | F | Failure Path | P5/FR-5 | install 多步流错误（含 details.hint）如何展示？cancelInstall 的 UI 状态机？ |
| G-007 | F | Data Lifecycle | P2/FR-6 | session.compacted 同 type 同时走 pending（有 id reply）+ 流式广播（无 id）。订阅 handler 要过滤带 id 的 reply 吗？ |
| G-008 | F | User Journey | P1/FR-6 | compacted 完成后按钮态是否自动消失？压缩按钮态 + compactionSummary system 行如何并存？ |
| G-009 | F | API Contract | P3/FR-6 | session domain 新增 compact 的 return 类型？mock 侧 session 要补同构 compact（spec FR-6 未提 mock）。 |
| G-010 | F | Data Lifecycle | P2/FR-7 | widgetKey/statusKey 枚举？多 widget 路由到 Terminal/Browser tab 的映射规则？ |
| G-011 | F | State Machine | P4/FR-7 | widget lines 是增量（append）还是全量（replace）？累积策略未定。 |
| G-012 | D | User Journey | P1/FR-8 | SideDrawer 打开触发未定义。Diff 排除+git-zone 移除后，Terminal/Browser widget 触发抽屉的源组件？ |
| G-013 | D | User Journey | P1/FR-6 | compact 按钮放 Composer 工具条还是 Header？无设计稿依据。 |
| G-014 | D | Data Lifecycle | P2/FR-10 | FileView 聚合语义：末条 assistant fileChanges vs 全 session 跨回合并集？ |
| G-015 | F | Data Lifecycle | P2/FR-10 | U标注+行数+过滤的数据来源是否齐？mock fixture 是否带 addLines/delLines？ |
| G-016 | F | API Contract | P3/FR-11 | ExtensionInfo dirName 已在（protocol.ts:346），只缺 tools。spec「补 tools/dirName」应为「补 tools」。runtime 如何采集 tools？ |
| G-017 | F | State Machine | P4/FR-11 | FileChangeStatus 补 unmerged 后，runtime 何时推 unmerged？还是纯前端标注？ |
| G-018 | F | Failure Path | P5/FR-9 | session.list server-push 每次广播都重载全量历史（loadSessions 全量 getHistory）？性能隐患。 |
| G-019 | F | API Contract | P3/FR-9 | session.list 订阅用 onGlobalType 还是 useSidebar 订阅 dispatch？mock 侧无 session.list server-push 模拟。 |
| G-020 | F | Data Lifecycle | P2/FR-1 | mock 剧本的 messageId 如何与 message_start 对齐？file_changes ready 帧要 isFullSet=true。steer 后推 queue_update 的时机？ |
| G-021 | F | User Journey | P1/FR-3/4 | RetryIndicator/pending气泡放 Turn.vue 还是 Composer 上方？与 ProgressZone 的关系？ |
| G-022 | F | Failure Path | P5/FR-1 | mock 剧本 tool_call 中途 abort，剩余 setTimeout timer 不清理→孤儿事件。 |
| G-023 | F | Data Lifecycle | P2/FR-4 | pending 气泡「进入 message-stream 后消失」的触发信号？queue_update 清空 vs message_start 到达的时序？ |

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| State Machine（部分） | 不变更业务实体核心状态机（Message 生命周期已稳定，ChangeSetCard 5 态已实装）。仅 tool_call_pending/widget累积/FileChangeStatus 扩展涉及状态，已单独追踪。 | spec FR 列表无「状态机重构」项 |

## 补充说明

1. 4 个 [UNVERIFIED] 项已全部用代码核实。
2. FR-11 表述错误：dirName 已在，只补 tools（G-016）。
3. FR-2 隐藏依赖：tool_call_pending → status='pending'，但 ToolCallStatus 无 'pending'（G-001）。
4. FR-9 语义模糊：server-push 是否重载全量历史（性能 G-018）。
5. mock 同构约束：FR-5/FR-6/FR-9 新增方法 mock 侧必须同构补全（G-009/G-019/G-020）。
6. SideDrawer 与 Diff 排除矛盾：触发源缺失（G-012）。
