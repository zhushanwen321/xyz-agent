# Sidebar 异常处理审查待办 — 2026-07-14

> 来源：4 个 subagent 并行审查 sidebar 前后端全链路（前端组件层 / 编排+Store 层 / 后端 session 链路 / WS 传输+API 层）。
>
> 审查维度：异常处理完整性、鲁棒性、fail-fast vs 降级策略合理性、资源泄漏、状态一致性。
>
> 评分：前端组件层 6/10 · 编排/Store 层 6.5/10 · 后端 7/10 · WS 传输层 5/10。

## 贯穿性观察

两个系统性缺陷贯穿多层：

1. **用户写操作失败无反馈**（前端组件层 + 编排层 + WS 传输层共同导致）—— select/delete/rename/new 失败后用户无任何感知。组件层裸 await 无 catch，编排层注释写「UI 层捕获」但 UI 层没捕获，WS 层无超时导致 reject 永不触发。对比 `useChat` 的 6 个动作全部 catch+toast，sidebar CRUD 是遗漏。
2. **断连/超时场景的永久挂死**（WS 传输层根因）—— pending 请求无 per-request 超时，叠加 send 静默丢弃，构成「请求永久挂起」的真实泄漏路径。

---

## P0 · 立即修复（阻塞级）

### [ ] S0 · persistSessionName 在 rename 路径违反规则 #6，重新制造 EEXIST 卡死

- **文件**：`packages/runtime/src/infra/pi/session-file-utils.ts:73-96`（wx 分支）← 被调于 `packages/runtime/src/services/session/session-lifecycle.ts:110-112`（renameSession 活跃 session 分支）
- **问题**：同文件第 60-65 行 `[HISTORICAL]` 注释记录了 `ensureSessionFile` 因 `openSync(wx)` 提前建文件导致与 pi 0.80.3 `_persist` 的 `openSync("wx")` 冲突 → EEXIST → pi 抛 `message_start{stopReason:"error"}` → **session 永久卡死**，已删除。但 `persistSessionName` 第 88 行 `openSync(filePath, 'wx')` 做了完全相同的事，在 rename 路径复活了此 bug。
- **触发场景**：新建 session 后、首条 assistant 消息到达前（pi 延迟写入窗口），用户立即重命名 → runtime 用 wx 建文件 → pi 首次 flush 撞 EEXIST → session 永久死。
- **对比**：`session-service.ts:658-662` 的 `tryPersistLabel` 刻意加了 `existsSync` 守卫避开此坑，但 rename 走的是另一条路径 `persistSessionName`，没有对齐。
- **方案（长期）**：renameSession 活跃分支加 `existsSync(session.sessionFilePath)` 守卫，文件不存在时只更新内存 label（依赖 turn_end/agent_end 兜底写盘）；或删掉 `persistSessionName` 的 wx 建文件分支，强制调用方保证文件已存在。

### [ ] S1 · WS 请求无 per-request 超时，可永久挂死

- **文件**：`packages/renderer/src/api/pending.ts:24-31`（register 无 setTimeout）+ `packages/renderer/src/api/request.ts:31-41`
- **问题**：`pending.register()` 创建裸 Promise，全链路无任何超时。runtime handler 卡住（pi hang/FS 慢）但不断连 → 前端 Promise 永久 await，sidebar 操作永久 loading。叠加 `ws-client.ts:162` send 在未连接时静默丢弃，存在「send 时已断但 watch 未回调」的竞态窗口。
- **方案（长期）**：`pending.register(id, timeoutMs)` 内挂 setTimeout，超时后 delete + reject。一处改动同时根治「handler 卡死型」和「send 静默丢弃型」两类永久挂死。
- **短期兜底**：至少给 sidebar 关键操作（switch/create/delete/rename/fork/getHistory）单独包 `Promise.race([request(...), timeout(15000)])`。

### [ ] S2 · 四个 CRUD handler 裸奔无 try-catch + toast

- **文件**：`packages/renderer/src/components/sidebar/Sidebar.vue:248-250`（onSelectSession）、`:327-329`（onNewSession）、`:336-338`（onDeleteSession）、`:340-342`（onConfirmRename）
- **问题**：四个用户交互触发的 async handler 直接 `await` 编排层动作，无 try-catch。底层确实会 reject（`useSidebar.ts:187` switchSession、`:314` rename、`:324` remove）。对比同文件 `onSelectAgentCall:298-311` / `onWorkflowAction:314-325` 都正确 catch+toast，说明模式已存在，这四个是遗漏。
- **影响**：网络抖动或后端异常时，点切换/删除/重命名/新建 → 按钮点了没反应，无 toast，控制台 unhandled rejection。
- **方案**：统一加 try-catch + toastError，对齐已有的 `onSelectAgentCall` 模式。根因修复应同时让编排层（`useSidebar`）对齐 `useChat` 的「内部 catch + toast + 不 throw」契约。

---

## P1 · 短期修复（严重）

### [ ] S3 · deleteSession 不清理跨 store 残留

- **文件**：`packages/renderer/src/composables/features/useSidebar.ts:323-339`
- **问题**：deleteSession 只做 `removeFromList(id)` + 清空 bound panel，不调 `fileTree.clearSession(id)`（`fileTree.ts:233` 方法存在但从未被调），不清 chat 的 `streamSubscriptions`（模块级 Map，`useChat.ts:31`）。已删 session 的 fileTree 四个 Map 分桶、chat 分区、底层 WS 订阅永久残留。
- **影响**：频繁建删 session 后内存单调增长；`fileTree.currentFile` 可能命中已删 session 的残留节点。
- **方案（长期）**：deleteSession 在 `removeFromList` 后调 `useFileTreeStore().clearSession(id)`；给 useChat 增加 `disposeSession(sid)`（清 streamSubscriptions + chat 分区 + pendingSendTimer），deleteSession 调用之。

### [ ] S4 · deleteSession 删 active 后 selectSession(next) 失败导致跨 store 撕裂

- **文件**：`packages/renderer/src/composables/features/useSidebar.ts:323-339`
- **问题**：删除当前 active session 时，`removeFromList`（`session.ts:70-77`）内部已把 `activeId` 回退到 `list[0]`。随后 `selectSession(next.id)` 的 `await switchSession` 若失败（网络抖动）→ activeId=next 但 panel 空载、navigation 停在旧 view，三 store 不对齐。且错误因 S2 无反馈。
- **方案（短期）**：把 `selectSession(next.id)` 包 try-catch；失败时 fallback 到 `navigation.push({ view: 'chat' })` 空态。
- **方案（长期）**：`removeFromList` 不应擅自改 activeId（与 deleteSession 回退逻辑职责重叠），让 activeId 回退集中由 deleteSession 编排。

### [ ] S5 · loadSessions 失败后列表永久卡空态无重试出口

- **文件**：`packages/renderer/src/components/sidebar/Sidebar.vue:347`（fire-and-forget `void loadSessions()`）+ `packages/renderer/src/composables/features/useSidebar.ts:400-411`
- **问题**：`sessionApi.list()` 可能 reject，一旦 reject 整个 `loadSessions` reject，被 `void` 吞掉 → unhandled rejection + `setGroups` 永不执行 → SessionList 显示空态「暂无会话」。用户无法区分真空 vs 加载失败，无重试入口。
- **方案**：session store 增加 `listLoadError` 标志，SessionList 据此显示「加载失败，点击重试」态；或最低限度 `loadSessions` 内部包 try-catch + toast。

### [ ] S6 · RPC 超时后迟到响应被误路由为事件

- **文件**：`packages/runtime/src/infra/pi/rpc-client.ts:233-245`（handleMessage 路由）+ `:286-330`（sendCommand 超时）
- **问题**：sendCommand 超时后 `pending.delete(id) + reject`，pi 随后返回的带 id 响应进 handleMessage，`pending.has(msg.id)` 为 false → 落入 else 分支 → 当作事件广播给 EventAdapter。一个 get_state/get_messages 迟到响应会被当作未知事件翻译，产生幽灵 UI 副作用。
- **方案（短期）**：sendCommand 超时时把该 id 加入 `timedOutIds` 弱集合（带 TTL），handleMessage 里丢弃迟到响应。

---

## P2 · 中期改进

### [ ] M1 · WorkflowList / SubagentList 缺 loading / error 态

- **文件**：`packages/renderer/src/components/sidebar/WorkflowList.vue:84-93` · `SubagentList.vue:52-61` · `stores/workflow.ts:111-122`（loadWorkflows 静默吞错）· `stores/subagent.ts:112-123`（loadSubagents 同）
- **问题**：列表组件只有空态/有数据两态，加载期间显示「暂无工作流」误导用户。store 层 catch 后 `console.error` + `records=[]`，失败与空数据不可区分。
- **对比**：`FileView.vue:51-91` 完整实现 loading/error/empty/loaded 四态，是正面范本。
- **方案**：store 增加 `isLoading` / `loadError` 标志，组件加第三态。store 的 catch 不再把 `[]` 作为失败态，改设 `loadError=true`。

### [ ] M2 · 重连后不恢复 session 级状态

- **文件**：`packages/renderer/src/composables/useConnection.ts`（重连无编排）+ `packages/renderer/src/composables/features/useSidebar.ts:433-461`（initApp 被 appBootstrapped 守卫挡住）
- **问题**：重连后唯一状态恢复来源是 server 的 `sendInitialState`（只推 session.list/config/app.info）。`loadSessions` 不重跑、当前 active session 的 commands/context 不重拉（断连时被 rejectAll 清掉）。用户重连后切回 session 发现 slash 浮层空、context 用量空。
- **方案**：`useConnection` 增加重连 hook（watch `reconnecting/disconnected → connected` 且非首次），重连成功后重拉 `loadSessions()` + 当前焦点 session 的 commands/context + workspaceStore.load()。

### [ ] M3 · initializeManagedSession 三处无 try-catch + safeDestroy

- **文件**：`packages/runtime/src/services/session/session-lifecycle.ts:86`（create）、`:178`（restoreSession）、`:244`（forkSession）
- **问题**：三处在 `pm.createSession` + `client.switchSession` 成功后调 `initializeManagedSession`，但这一步无 try/catch + safeDestroy 保护（对比 getState/switchSession 失败都有 safeDestroy）。`initializeManagedSession` 内部 `adapterFactory(...)` / `adapter.attach(client)` 抛错时，pi 进程已 spawn 但未进 `sessions` Map → 不可见不可销毁的僵尸进程。
- **方案（短期）**：三处用 try/catch 包裹 `initializeManagedSession`，失败时 `await safeDestroy(id); throw e`。
- **方案（长期）**：收敛为 `spawnAndBind(id, cwd, filePath, ...)` helper，统一「spawn → switch → init → 失败回滚」骨架。

### [ ] M4 · 订阅者回调抛错中断同通道其他订阅者

- **文件**：`packages/renderer/src/api/events.ts:42`（dispatchSession）、`:83-84`（dispatchGlobal）
- **问题**：`sessionHandlers.get(sessionId)?.forEach((h) => h(msg))` —— 若任一 handler 抛错，forEach 立即终止，同 sessionId 后续订阅者收不到广播。sidebar 有 6+ 组件实例化 useSidebar，一个坏 handler 会让整条 session.list 广播中断。
- **方案**：每个 handler 调用包 try/catch，抽 `safeForeach(set, msg)` 工具。

### [ ] M5 · subagent.fetchAndInject 失败静默回退空数组

- **文件**：`packages/renderer/src/stores/subagent.ts:161-174`
- **问题**：`getSubagentHistory` 失败时 `setMessages(virtualId, [])` + console.error。用户看到空对话流，无错误态/重试入口。与 `workflow.selectAgentCall`（fail-fast 抛错，注释明确要求调用方 catch+回滚）策略相反。
- **方案**：统一为 fail-fast（抛错让 onSelectSubagent catch + toast + backToMain 回滚），对齐 selectAgentCall。

### [ ] M6 · broadcast 遍历 clients 时 ws.send 可能抛错中断

- **文件**：`packages/runtime/src/transport/message-broker.ts:61-67`
- **问题**：readyState 检查与 ws.send 间有 TOCTOU 窗口，连接在此瞬间关闭时 ws.send 抛错，broadcast 的 for 循环未 try/catch，异常上抛中断对剩余客户端的广播。
- **方案**：broadcast 内每个 send 包 try/catch。

---

## P3 · 长期/健壮性加固

### [ ] L1 · initApp catch 零可观测性

- **文件**：`packages/renderer/src/composables/features/useSidebar.ts:457-460`
- **问题**：`catch { appBootstrapped = false }` 连 console.error 都没有。启动编排失败时用户看到永久空白 landing，开发者排查零线索。
- **方案**：catch 内加 `console.error('[initApp] bootstrap failed:', e)`；失败超 N 次 toast 提示。

### [ ] L2 · loadSessions 的 allSettled 静默吞掉单 session 历史失败

- **文件**：`packages/renderer/src/composables/features/useSidebar.ts:404-410`
- **问题**：allSettled 吸收所有 rejection，reject 的 session 既没 `markHistoryFailed`（landing 不显重试出口），也无日志。与 selectSession 内 getHistory 处理（catch → markHistoryFailed）策略不一致。
- **方案**：遍历 allSettled 结果，对 rejected 的调 `chat.markHistoryFailed(s.id)`。

### [ ] L3 · useDetailPane 无并发守卫（快速切换文件竞态）

- **文件**：`packages/renderer/src/composables/features/useDetailPane.ts:94-124`（loadContent）、`:126-138`（openPreview）
- **问题**：openPreview 是 fire-and-forget，快速连续点两个文件时两个 loadContent 并发，先发的慢响应可能后到，用旧内容覆盖新选中文件 state（stale write）。对比 useFileTree.expandNode 有 inFlight Map 去重。
- **方案**：加请求版本号（每次 openPreview 自增 token，resolve 后校验 token 是否最新），或用 AbortController。

### [ ] L4 · session.create/fork 等失败统一返回 handler_error，错误码不可操作

- **文件**：`packages/runtime/src/transport/session-message-handler.ts:33-129` → `server.ts:220-223`
- **问题**：除 switch/steer/follow_up/compact 有专属 code 外，其余 session.* 失败一律 code=`handler_error`。model 未配置的错误消息很好（"No model configured..."），但 code 泛化，前端无法按错误码做差异化引导（弹 Settings vs 弹重装）。
- **方案**：fail-fast 抛错处用 `errorWithCode(msg, 'MODEL_NOT_CONFIGURED')`（errors.ts 已有此工具），session-message-handler 对 create/fork/restore 增加 try/catch 透传 `.code`。

### [ ] L5 · fork spawn 失败留孤儿 fork 文件

- **文件**：`packages/runtime/src/services/session/session-lifecycle.ts:220-233`
- **问题**：`createForkedSessionFile` 已写截断 JSONL 到磁盘，随后 createSession 失败时新文件留在磁盘上，下次 scanPiSessions 当成合法 session 显示（但无 pi 进程能操作）。
- **方案**：createSession 失败的 catch 里 `fs.unlink(forkedFilePath).catch(() => {})`。

### [ ] L6 · RPC 超时阈值未按操作分级

- **文件**：`packages/runtime/src/infra/pi/rpc-client.ts:57-58`（CMD_TIMEOUT_MS = 60_000 统一）
- **问题**：getState/getCommands 应毫秒级却等 60s 才报错；switchSession 加载大 session 可能误超时。仅 compact 单独配了 300s。
- **方案**：按操作分级（getState/getCommands ~10s，switchSession ~120s，prompt/steer 维持 60s）。

### [ ] L7 · switchModel 对未激活 session 静默成功，缓存与广播语义不清

- **文件**：`packages/runtime/src/services/session/session-service.ts:243-261`
- **问题**：对磁盘/不存在 session 切模型直接返回原 id 当成功；对活跃但 client 丢失的 session，会更新缓存并广播一个 pi 侧并未生效的模型切换。UI 显示模型已切，但 pi 实际没切。
- **方案**：`if (!session) throw new Error('session not active')`，或至少 `if (!client) return sessionId`（跳过缓存写和广播）。建议前者，fail-fast。

### [ ] L8 · scanPiSessions 顶层 readdirSync 未保护

- **文件**：`packages/runtime/src/infra/pi/session-file-utils.ts:175-176`
- **问题**：L171 有 `existsSync` 守卫，但 L176 `readdirSync` 无 try/catch（与下游 per-dir/per-file 隔离不同）。该函数经 `listPersistedSessions` 在 `session-service.ts:121` 的 `onSessionExit` 回调里同步调用，回调抛错 = 进程级未捕获异常。
- **方案**：L176 包 try/catch 返回 `[]`，与下游隔离策略对称。

### [ ] L9 · routeInbound 对 session 级广播缺失 sessionId 时静默降级到 global

- **文件**：`packages/renderer/src/composables/useConnection.ts:86-105`
- **问题**：session 级消息若 payload 漏带 sessionId（runtime bug），被路由到 dispatchGlobal 静默丢弃，无错误信号。违反规则 #7 的隔离要求应有 fail-fast 信号。
- **方案**：routeInbound 对「type 已知为 session 级但 sessionId 缺失」的消息 console.warn。

### [ ] L10 · mock 模式不安装断连清理监听

- **文件**：`packages/renderer/src/composables/useConnection.ts:150-153`
- **问题**：init() 在 mock 模式直接 return，跳过 rejectAll 监听安装。mock 断连时 pending 永不 reject，叠加 S1 无超时 → mock 模式 pending 也泄漏。
- **方案**：把 stopStateWatch 安装提前到 ensureDispatcher 之后、mock 分支之前。

---

## 设计合理的点（正面基线，保留）

| 做法 | 位置 | 评价 |
|---|---|---|
| selectSession 的 4 个独立 try-catch | `useSidebar.ts:198-238` | 切 session 本身 fail-fast，辅助数据降级——粗细粒度权衡正确 |
| FileView / FileTreeRow 三态处理 | `FileView.vue:51-91` | loading/error/empty/loaded 完整四态，错误精确落到节点级可重试 |
| useChat 统一错误契约 | `useChat.ts` 6 处 catch | catch+toast+不 throw，全 codebase 最成熟范式 |
| scanPiSessions per-file/per-dir 隔离 | `session-file-utils.ts:181-233` | 单个坏文件绝不毒化整个 list |
| model 未配置 fail-fast | `session-lifecycle.ts:53-55 等` | spawn pi 前检查，抛可操作错误 |
| getHistory 多级兜底 | `session-service.ts:298-318` | RPC→文件→ENOENT 空数组，降级范本 |
| newSession finally 复位 inFlight | `useSidebar.ts:283-285` | 并发守卫放 finally，异常路径不卡死 |
| 服务端双重 try/catch + error envelope 带 sessionId | `server.ts:208-225` | handler 抛错必被捕获，符合规则 #7 |
| 指数退避重连 + generation 防串扰 | `ws-client.ts` | 重连骨架成熟 |
| safeDestroy 吞清理异常 | `session-lifecycle.ts:38-40` | 错误清理路径不掩盖原始错误 |
| RenameSessionDialog zod 输入校验 | `RenameSessionDialog.vue:76-83` | min(1)/max(60)/正则白名单 + inline 提示，前端拦截 |
| SessionItem 删除两段式确认 + 四路 reset | `SessionItem.vue:99-135` | mouseleave/失焦/ESC/onClickOutside 四重防御 |

---

## 统计总览

| 层 | 评分 | try-catch 数 | 静默吞错 | 并发守卫 | 疑似泄漏点 |
|---|---|---|---|---|---|
| 后端 session 链路 | 7/10 | ~16（14 为 per-session 隔离） | 1（safeDestroy 合理） | 4 | 4 |
| 前端组件层 | 6/10 | 4（组件内） | 0（组件层无 catch 可吞） | 2 | 0 |
| 编排/Store 层 | 6.5/10 | 14 | 6 | 4 | 3（跨 store 残留） |
| WS 传输/API 层 | 5/10 | — | — | 重连骨架有 | 2（pending 永久挂死 × 2 路径） |
