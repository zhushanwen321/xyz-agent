# ADR-0036：Session 隔离统一采用 Map 分区派范式

- **Status**: Accepted
- **Date**: 2026-07-21
- **Topic**: `cw-2026-07-21-session-isolation-arch`

## Context

xyz-agent 前端有大量 per-session 状态（聊天消息、ask-user 队列、命令缓存、文件树、widget 缓冲等）。explorer 审查发现 codebase 存在**两套并行的 session 隔离范式**：

### 范式 A：Map 分区派（主流，10+ 处）

状态存 `Map<sessionId, T>`，每个 session 独立分区。
- `stores/chat.ts`：`chatSessions: Map<sessionId, ChatSessionState>`
- `composables/features/useNewTaskFlow.ts`：per-sessionId flow 状态
- `composables/features/useFileTree.ts` / `useSessionDerivations.ts`
- `stores/fileTree.ts` / `workflow.ts` / `command.ts` / `fileSearch.ts`

### 范式 B：watch 清理派（少数，4 处）

单实例状态（ref/let）+ `watch(sessionId)` 切换时清空。
- `composables/useExtensionUI.ts`（**有 bug**）
- `composables/panel/useComposerHistory.ts`
- `composables/features/useSessionEvents.ts`
- `components/panel/SideDrawer.vue`

### Bug 触发

`useExtensionUI.ts` 两套范式都没做到——既没用 Map 分区，`subscribe(sid)` 切换 session 时又没清空 `queue.value`。导致：

1. Panel A 显示 ask-user overlay（session A 有 pending 请求）
2. 用户切到 session B
3. 同一个 Panel 实例的 `props.sessionId` 变为 B
4. `subscribe(B)` 退订了 A 的 WS 订阅，但 `queue.value` 里 A 的 pending 请求残留
5. `currentAskUserRequest = computed(() => queue.value.find(r => r.askUser))` 仍命中 A 的请求
6. **session B 的 Panel 显示了 session A 的 ask-user overlay**

注释甚至写了"per-sessionId 分区"——**注释与实现不符**，代码异味。

## Decision

**所有 per-session 状态的 composable 统一采用 Map 分区派范式。**

具体落地（经 spec_review 修订，CL4/CL5 定稿）：

1. **新建通用 composable 工厂** `useSessionScopedState<T>(sid: Ref<string | null>, init: () => T)`：内部维护 `Map<sessionId, T>`，按 `sid.value` 查对应分区，`init` 为新 session 惰性初始化。提供 `current` computed（当前 sid 的分区）、`update(updater)` 操作当前分区、`cleanup(sid)` 清理指定 session。null sid 时 `current` 返回 `init()` 默认实例但不写入 Map（防 null key 污染）。

2. **useExtensionUI 改用 Map 分区**：`queue` 从实例级 `ref<ExtensionUIRequest[]>` 改为 `Map<sessionId, ExtensionUIRequest[]>`（直接用通用工厂）。`currentAskUserRequest` / `currentDialogRequest` computed 按当前 sid 查分区。

3. **迁移现有 watch 清理派到 Map 分区派**：
   - `useComposerHistory.ts`：`history` 是 computed（天然 per-session，不迁移）；`browsing/index/savedDraft` 三个裸 `let` 收进 `reactive` 对象再经 `useSessionScopedState` 分区
   - `SideDrawer.vue` 的 widget/status 缓冲态（terminalLines/browserLines/unknownWidget/guiWidgetsByTab/statusMap）经 `useSessionScopedState` 分区
   - **`useSessionEvents.ts` 不迁移**（spec_review D3 决策）：它是订阅编排层（管理 events.on/off 退订），不持有 per-session 业务状态，强套 Map 分区是错配

4. **cleanup 接入 session 销毁链路**（spec_review #2 修订）：plan 阶段定义 cleanup 的唯一调用点（session close / panel unmount / session-tree 删除节点候选之一），防止 Map 分区积累已销毁 session 的条目导致内存泄漏。

### 术语澄清（spec_review #8）

- **Map 分区** = 单例 composable 内部 `Map<sessionId, T>`，按 sid 查分区。本次目标范式。
- **实例级隔离** = 每组件实例各自状态（靠组件树天然多实例）。useExtensionUI 现状（脆弱——切 session 时同一实例的状态没清就泄漏）。
- **watch 清理派** = 单实例状态 + `watch(sessionId)` 切换时清空。SideDrawer/useComposerHistory 现状（正确隔离但范式不统一）。

### 防护层（spec_review D4 修订：ESLint 规则放弃）

| 层 | 措施 | 目的 |
|----|------|------|
| 测试 | 补"同实例切换 sessionId"回归测试（split 双 panel 同 sid 分流也覆盖） | 直接防 useExtensionUI 类 bug 再犯 |
| 代码抽象 | `useSessionScopedState` 通用工厂 | 新 composable 用它天然隔离 |
| 文档 | 本 ADR + 更新 AGENTS.md | 记录范式选择 + 反模式 |

~~ESLint 自定义规则~~：spec_review D4 放弃。理由：AST 检测"composable 内 ref/let 是 per-session 还是 UI 局部"铺天盖地误报，检测语义问题非 ESLint 所长。防护靠工厂（结构隔离）+ 测试（回归）+ 文档（范式约束）。

## Alternatives Considered

### 替代方案：watch 清理派（单实例状态 + watch 切换清空）

被否决。理由：
- **脆弱模式**：依赖开发者记得在 `watch(sessionId)` 回调里清空**所有**状态字段。新加字段忘了清，就泄漏。useExtensionUI 的 bug 正是这个模式失效的实例。
- **切 session 数据丢失**：切走再切回，状态丢失（除非从 runtime 重新拉，多一次 RPC）。
- **与 codebase 主流不一致**：10+ 处用 Map 分区，4 处用 watch 清理，应统一到主流。

### 替代方案：不抽象通用工厂，各 composable 各自实现 Map 分区

被否决。理由：
- **重复代码**：每个 composable 都要写一遍 Map 管理 + watch + cleanup 逻辑。
- **不防复发**：新 composable 作者还是要自己知道用 Map 分区，没从结构上强制。

## Consequences

### 正面

- **范式统一**：所有 per-session composable 遵循同一模式，降低认知负担。
- **消除 bug 根因**：Map 分区下，切 session 天然切分区，不存在"忘清空"的失误可能。
- **切 session 不丢数据**：切走再切回，状态自然恢复（如 ask-user pending overlay 重新出现）。
- **从结构上防复发**：新 composable 用 `useSessionScopedState` 工厂天然隔离；ESLint 规则检测违规。
- **与 codebase 主流一致**：10+ 处 Map 分区派的模式得到强化和抽象。

### 负面

- **改动面较大**：新建工厂 + 改 useExtensionUI + 迁移 3 个现有 composable + ESLint 规则。多 Wave 工程。
- **回归风险**：SideDrawer 的 widget 缓冲态迁移涉及多个状态字段（terminalLines/browserLines/unknownWidget/guiWidgetsByTab/statusMap），需充分测试。
- **内存管理**：Map 分区不会自动释放，需在 session 销毁时显式 cleanup（否则内存泄漏）。通用工厂需提供 cleanup 接口 + 在合适的生命周期调用。

## Open Questions（spec_review 后的残留）

1. ~~`useSessionEvents.ts` 是否真要迁移~~ → **已决（D3）：不迁移**
2. ~~ESLint 规则的检测精度~~ → **已决（D4）：放弃 ESLint 规则**
3. **session 销毁时机（何时调 cleanup）** —— 留待 plan 阶段定义调用点 deliverable（FR-4 约束）
4. ~~SideDrawer 切 sid 时缓冲清空时序与 useSessionEvents 退订时序的竞态（AC-4 约束）~~ → **已修复**：useSessionEvents 把订阅时 sid 传给 handler（`(msg, sid) => void`），SideDrawer handler 调 `drawerState.updateFor(sid, ...)` 写「消息所属 sid」分区。从结构上消除竞态（非时序依赖）。commit bf1fffc + 19ea684f。

## Addendum：M1/M2 竞态修复（post-review）

review 阶段发现 M1 竞态（切 sid 的 WS 消息写入）+ M2 测试假绿，曾作为 known risk 留后续。后补充修复（commit 49b2e577 + bf1fffc + 19ea684f）：

- **useSessionScopedState 工厂加 `updateFor(targetSid, updater)`**：显式指定分区，不读 `sid.value` 实时值
- **useExtensionUI handler**（onUIRequest/onUITimeout/getPendingRequests）闭包捕获 subscribe 参数 sid，调 `updateFor(sid, ...)`
- **useSessionEvents 接口扩展**：`onMessage` handler 签名加第二参数 sid（订阅时捕获），分发时透传。其他消费者（useGitStatus/CommandPopover/ContextCapacityPopover）handler 参数更少，TS 允许赋值，无需改
- **SideDrawer handler** 加 sid 参数，调 `drawerState.updateFor(sid, ...)`
- **SideDrawer.test.ts mock** 从 `sidRef.value` 实时匹配改为注册时 sid 快照，对齐真实 useSessionEvents 行为。M2 假绿确证已修（临时验证脚本确认 handler 被真触发）

核心思路：**隔离靠结构（handler 捕获订阅时 sid + updateFor 显式分区），不靠时序（watch flush 退订）**。即使 flush:pre 异步退订窗口内有旧 sid 迟到消息，也只写旧 sid 分区。

## References

- explorer 审查报告（topic `cw-2026-07-21-session-isolation-arch` 的 clarify 记录）
- Bug 首现 commit：`892ca6ba` "fix: cache pending ask-user requests for session switch recovery"（引入 queue 缓存但未分区）
- 现有 Map 分区范例：`packages/renderer/src/stores/chat.ts`
- 现有 watch 清理范例（正确隔离）：`packages/renderer/src/components/panel/SideDrawer.vue`
