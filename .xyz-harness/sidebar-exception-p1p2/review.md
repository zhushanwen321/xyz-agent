# Review — cw-2026-07-14-sidebar-exception-p1p2

## 审查范围

P1+P2 共 10 项 sidebar 异常处理修复，分 4 个 Wave：
- W1 (S3+S4)：deleteSession 跨 store 清理 + selectSession fallback
- W2 (S5+M1+M5+L1+L2)：三列表加载错误态 + fetchAndInject fail-fast + initApp 可观测性
- W3 (S6+M3+M6)：runtime 迟到响应丢弃 + broadcast try-catch + initializeManagedSession 僵尸进程防护
- W4 (M4+L9)：events 订阅者隔离 + session 级消息缺失 sessionId warn

## 1. Plan 覆盖核对

| Plan changes | 落地状态 | 文件 |
|---|---|---|
| W1: chat store disposeSession | ✅ | stores/chat.ts（disposeSessionImpl 模块级） |
| W1: useChat disposeSession | ✅ | composables/features/useChat.ts |
| W1: deleteSession 调 fileTree.clearSession + useChat.disposeSession | ✅ | composables/features/useSidebar.ts |
| W1: selectSession(next) 失败 fallback | ✅ | useSidebar.ts deleteSession try-catch |
| W2: session store listLoadError | ✅ | stores/session.ts |
| W2: workflow store isLoading/loadError | ✅ | stores/workflow.ts |
| W2: subagent store isLoading/loadError | ✅ | stores/subagent.ts |
| W2: fetchAndInject fail-fast | ✅ | stores/subagent.ts |
| W2: Sidebar SessionList 失败态 + 重试 | ✅ | components/sidebar/Sidebar.vue |
| W2: WorkflowList loading/error 态 | ✅ | components/sidebar/WorkflowList.vue |
| W2: SubagentList loading/error 态 | ✅ | components/sidebar/SubagentList.vue |
| W2: onSelectSubagent catch+backToMain | ✅ | Sidebar.vue |
| W2: initApp console.error (L1) | ✅ | useSidebar.ts（原 plan W4 L1，因同文件提前到 W2） |
| W2: loadSessions allSettled markHistoryFailed (L2) | ✅ | useSidebar.ts（原 plan W4 L2，因同文件提前到 W2） |
| W3: rpc-client timedOutIds | ✅ | infra/pi/rpc-client.ts |
| W3: message-broker broadcast try-catch | ✅ | transport/message-broker.ts |
| W3: initializeManagedSession try-catch+safeDestroy 三处 | ✅ | services/session/session-lifecycle.ts |
| W4: events safeForeach | ✅ | api/events.ts |
| W4: routeInbound session 级 warn (L9) | ✅ | composables/useConnection.ts |

注：L1/L2 原计划在 W4，因与 W2 的 useSidebar.ts 改动在同一文件，实现时提前到 W2 一起提交。功能等价。

## 2. 代码质量

### 正面
- disposeSessionImpl 抽到模块级，遵循项目既有的「控制 setup 函数行数」模式（对齐 readStreamingTimeoutMs/applySubagentStreamDeltaImpl）
- 三列表四态改造对齐 FileView.vue 正面范本，组件 props 用 withDefaults 保持向后兼容
- fetchAndInject fail-fast 注释明确引用 selectAgentCall 契约，对齐项目错误处理策略
- rpc-client timedOutIds 用 Set + TTL + .unref()，避免无限增长且不阻止进程退出
- safeForeach 的 eslint-disable 注释明确标注 M4 原因，对齐项目 no-silent-catch 处理模式

### 关注点
- useConnection 的 L9 warn 用 `msg.type.startsWith('session.')` 判断 session 级消息，是近似——某些以 session. 开头的 type 可能不需要 sessionId（如 session.list 是全局广播）。warn 只是可观测性，不阻断分发，误报无害
- deleteSession 的跨 store 清理调用顺序：先 removeFromList 再 clearSession/disposeSession。若 selectSession(next) 在清理后执行，next session 的状态不受影响（清理只针对被删的 id）。正确

## 3. 测试覆盖

| TestCase | Wave | 状态 | 说明 |
|---|---|---|---|
| U1 | W1 | ✅ | chat store disposeSession 清理全部 per-session 状态（3 tests） |
| U2 | W1 | ✅ | useChat disposeSession 取消 streamSubscriptions（1 test） |
| U3 | W1 | ✅ | deleteSession 调 fileTree.clearSession + useChat.disposeSession |
| U4 | W1 | ✅ | 删 active 后 selectSession(next) 失败 fallback + 列表空 fallback |
| U5 | W2 | ✅ | session listLoadError 失败设错误/成功清空（2 tests） |
| U6 | W2 | ✅ | workflow loadError 失败保留旧数据 |
| U7 | W2 | ✅ | fetchAndInject fail-fast throw |
| U8 | W3 | ✅ | rpc-client 超时后迟到响应丢弃 + TTL 清理（2 tests） |
| U9 | W3 | ✅ | message-broker broadcast 单 client 抛错不中断（2 tests） |
| U10 | W4 | ✅ | events safeForeach 订阅者隔离 dispatchSession + dispatchGlobal（2 tests） |
| E1 | W2 | ✅ | Sidebar SessionList 失败态 DOM 渲染 + 重试（3 tests） |

共 20 个测试全部通过（16 前端 + 4 runtime）。

## 4. 回归风险

- chat store disposeSession 的 changeSetStatuses 清理用前缀匹配（`sessionId:`），若 messageId 含冒号会误删。但 messageId 格式是 UUID（不含冒号），安全
- workflow/subagent store 的 loadError 在 loadWorkflows/loadSubagents 成功时设 null，但在 `if (!sessionId)` 空分支也设 null——正确（空 sessionId 是合法无数据态，不是错误）
- events safeForeach 改变了 forEach 的语义：原来 throw 会中断，现在 catch 后继续。所有调用方（dispatchSession/dispatchGlobal）是 void 函数，不期望返回值，安全

## 5. 一致性

- 三列表 store 的 isLoading/loadError 模式统一（workflow/subagent 对齐）
- 组件四态结构统一（WorkflowList/SubagentList 对齐 FileView）
- catch+toast 模式统一（onSelectSubagent 对齐已有的 onSelectAgentCall/onWorkflowAction/onSelectSession）

## 结论

通过。10 项 P1+P2 问题全部修复，20 个测试全绿，代码质量符合项目规范。
