---
verdict: pass
---

# Non-Functional Design — TUI Bridge Phase 0

## 1. 稳定性

EventAdapter 是事件翻译的唯一瓶颈点。所有新 handler 都遵循相同的 switch-case 模式（读取 pi event 字段 → 构造 ServerMessage → 返回），不引入新的异步操作或外部依赖。handler 内部没有 try/catch，异常由外层 `handleEvent()` 统一捕获并打印日志。这种设计确保单个 handler 的 bug 不会影响其他事件的处理，也不会导致 sidecar 进程崩溃。

回归风险通过现有 20 个测试 + 新增 17 个测试覆盖。每个新 handler 都有对应的单测，验证输入/输出映射的准确性。所有修改是纯增量（新增 case 分支、新增字段），不修改已有逻辑分支。

## 2. 数据一致性

本次改动不涉及持久化存储。所有新增状态（ChatStore 的 5 个可选字段）仅存在于内存中的 Pinia reactive state，随 session 生灭。event-bus 内部存储保持 `Map<string, Set<EventHandler>>`（键仍为 string），避免类型变更影响运行时行为。

ChatStore 新字段全部可选（`undefined` 默认值），不影响现有 session 的序列化/恢复逻辑。`replaceMessages()` 从历史恢复时不会设置这些字段，保持向后兼容。

## 3. 性能

本次改动对性能无负面影响。EventAdapter 的 translate() 方法是 O(1) 的 switch-case 查找，新增 case 不增加时间复杂度。event-bus 的 emit 仍是 O(handlers) 遍历，无额外开销。ChatStore 新增字段是 reactive 对象的属性访问，Vue 的响应式系统会按需追踪。

pi RPC 事件频率通常在每秒 10-50 个（streaming delta 期间），每次事件处理耗时 < 1ms。新增 handler 不引入任何 I/O 或重计算。

## 4. 业务安全

不适用。本次改动不涉及用户输入处理、权限控制或 AI 行为指令。EventAdapter 是被动的翻译层，不解析也不执行事件内容。useChat handler 仅将事件数据写入 store，不触发副作用操作（除 `onExtensionSetTitle` 调用 `window.electronAPI.setTitle`，这是一个受控的 Electron API 调用）。

## 5. 数据安全

不适用。本次改动不处理敏感信息（密码、token、API key）。事件流中可能包含文件内容（bash output、tool result），但这些数据已经通过 pi → EventAdapter → WebSocket 通道传输，本次改动不改变传输路径或存储方式。WebSocket 连接是本地 localhost（Electron app 内部通信），不存在网络暴露风险。
