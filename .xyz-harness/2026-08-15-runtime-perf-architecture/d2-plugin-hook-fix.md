# D2：Runtime Plugin Hook 执行链路修复

> **一句话结论**：runtime plugin 的 hook 执行链路确诊断裂——主线程发「带 id 的 JSON-RPC request」，Worker 只在「无 id 的 notification」分支监听，且 request 分发器只认 `plugin.tool.execute`。所有插件的 block/transform/observe 语义 100% 失效。定案：Worker 侧 request 分发器直连 hook handler（request/response），observe 类 hook 走 notification（无回传），同时修复 `transformedData` 字段错配与 `onPiEvent` key 错配两个次生 bug，并补端到端测试消灭 mock 盲区。

**当前层 → 下一层**：技术方案设计（下一层产物 = 可实现的接口改动 + 数据契约 + 测试用例）。涉及运行时行为与错误处理，准则 5/6/7 全适用。

---

## §1 背景目标

### SCQA

- **情境**：xyz-agent runtime 支持第三方插件（Worker Thread / fork 沙箱两种宿主）。插件通过 `context.api.hooks.onXxx(...)` 注册 hook：block 类（`onBeforeSendMessage`/`onBeforeToolCall`/`onBeforeAgentStart`，可阻断）、transform 类（同前 + `onAfterToolResult`，可改写数据）、observe 类（`onPiEvent`，纯观测）。这是插件系统与 pi 事件流交互的核心能力。
- **冲突**：性能分析中发现 hook 管线「串行 RPC 三重浪费」（每次执行重排序、线性查 worker、每 handler 一次完整往返）。深挖后确认**更严重的事实**：hook 执行链路根本不工作。
- **问题**：**每个 hook 调用都被 METHOD_NOT_FOUND 立即弹回、被 catch 吞为「放行」——插件以为注册成功了，实际上从未执行过。** 两个次生 bug 让 transform 结果即使通了路由也会被丢弃。测试全绿是因为两个测试文件都 mock 掉了传输层，切断了唯一能暴露错配的连接点。
- **答案**：修复路由错配（request 直连）、修复字段错配与 key 错配、按 hook 语义分层（block/transform 走 request，observe 走 notification）、补端到端测试。修复方案本身即性能最优形态。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| HookPipeline | 主线程执行器（`services/plugin-service/hook-pipeline.ts`）：从注册表取 handlers，按 priority 排序后**串行**调用，5s 超时放行，block 则终止链。 |
| PluginRpcServer.invoke | 主线程 → Worker 的请求入口（`plugin-rpc-server.ts:79`）：生成自增 id、发 `{type:'rpc', request}`、登记 5s pending。 |
| plugin-bootstrap | Worker/子进程侧消息循环（`plugin-bootstrap.ts`）：`msg.response`→handleResponse、`msg.notification`→handleNotification、`msg.request`→handleIncomingRequest。**两者共用同一份**（fork 沙箱经 `plugin-bootstrap-process.ts` 复用）。 |
| hook-api | Worker 侧 hook API（`hook-api.ts`）：`onXxx` 生成 handlerId → 本地 Map 存 handler → RPC 注册到主线程；`createHookApi` 内注册 `onNotification('plugin.hooks.invoke')` 监听。 |

### 设计目标

1. **hook 真实执行**：插件注册的 hook 在对应事件上被调用，返回值正确驱动 block/transform/observe。
2. **性能分层正确**：observe 类 hook（高频事件）不产生请求往返；block/transform 类（必须回传结果）才走 request。
3. **杜绝 mock 盲区复发**：有端到端测试把真实 bootstrap 串起来跑一次 hook invoke。

### In / Out scope

- **In**：hook 的 RPC 路由修复、字段契约统一、注册/调用 key 统一、observe 走 notification、端到端测试、注册时排序与 worker 反向索引（性能优化并入）。
- **Out**：hook 语义本身的重设计（新增 hook 类型等）；大 payload 懒取协议（留待修复后按真实使用评估）；pi extension（`@zhushanwen/pi-*`）的 hook 系统（不同体系，不涉及）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

一个安装了 demo 插件（`plugins/demo/index.ts:46` 注册了 `onBeforeSendMessage`，期望把消息里的 `!important` 改写为 `IMPORTANT`）的用户：

1. 用户发送消息 → `plugin-service.ts:278` 调 `executeHooks('onBeforeSendMessage', ...)`；
2. `HookPipeline.execute` 找到该 handler 条目 → `rpcServer.invoke(workerId, 'plugin.hooks.invoke', {handlerId, hookType, context}, 5000)`；
3. **实际发生**：Worker 立即回 `METHOD_NOT_FOUND: Unknown method: plugin.hooks.invoke` → invoke reject → `HookPipeline` catch 分支吞掉并 `console.warn('[plugin-service] hook handler hook_demo_1 failed/timed out: ...')` → 返回 `{blocked: false}`；
4. 用户看到：消息照常发出、**内容未被改写**、控制台有一行含糊的失败告警。block 类 hook 拦截永不生效——被设计为「插件可拒绝」的操作全部放行。

### 2.2 根因：双向错配（探明证据链）

```
插件 activate
  → createHookApi(plugin-bootstrap.ts:239)
  → rpcClient.onNotification('plugin.hooks.invoke', ...)   ← 挂在「无 id notification」分支

主线程 executeHooks
  → HookPipeline.execute(hook-pipeline.ts:74)
  → rpcServer.invoke(...)                                   ← 生成自增 id（plugin-rpc-server.ts:85）
  → postMessage({type:'rpc', request:{id, method:'plugin.hooks.invoke', params}})

Worker/子进程 handleMessage case 'rpc'（plugin-bootstrap.ts:138-149）
  → msg.request 存在 → handleIncomingRequest(request)
  → request.method ≠ 'plugin.tool.execute' → 立即 METHOD_NOT_FOUND 回包（:179-183）
  → onNotification listener 永不触发（它只在 msg.notification 分支被调用）

主线程收到 error 响应 → pendingInvokes.reject → HookPipeline catch → 放行
```

**三个错配**：
1. **request vs notification 错配**：调用方发带 id 的 request，监听方只挂在无 id 的 notification 分支。
2. **结果回传腿缺失**：Worker 侧设计（`hook-api.ts:148-157`）是在收到 invoke 后通过**独立 request** `plugin.hooks.invoke.result` 回传结果——但主线程没有任何该方法的 handler（全仓 grep 仅 Worker 侧一处引用）。即使修好第一腿，第二腿也是断的。
3. **两条宿主路径同断**：fork 沙箱（`plugin-bootstrap-process.ts:17`）复用同一份 `handleMessage`/`handleIncomingRequest`，断裂与 Worker 线程完全同源。

### 2.3 两个次生 bug（修好路由后仍会让功能失效）

1. **transform 结果被丢弃**：`hook-pipeline.ts:95-100` 把 handler 返回的 `modifiedData` 写回 `context.data`（只供下游 handler 间传递），但 `HookPipeline.execute` 返回的 `HookResult` 从未填 `transformedData` 字段；而消费侧（`event-interpreter.ts:296-297/348`）读的正是 `hookResult.transformedData`。Worker 返回契约（`InterceptorResult{proceed, modifiedData}`）与主线程 `HookResult{blocked, transformedData}` 之间没有映射层。
2. **onPiEvent key 错配**：注册侧 key 是 `onPiEvent:${eventName}`（`hook-api.ts:225`），调用侧是泛型 `onPiEvent`（`event-interpreter.ts:267` 等）——按精确事件名注册的 handler 匹配不到调用，事件名短路失效。

### 2.4 测试全绿根因

- `plugin-hooks-serial.test.ts`：`vi.fn()` mock 掉 `rpcServer.invoke` 与 `host.getWorkerHandle`，只验 HookPipeline 纯逻辑（排序/串行/block）。
- `plugin-api-hooks.test.ts`：mock 整个 `PluginRpcClient`，手工从 `onNotificationHandlers` Map 取出 listener 直接调用，只验 createHookApi 本地骨架。
- **没有任何测试把「主线程 invoke → Worker handleIncomingRequest → hook-api listener」串起来**。mock 恰好切断了唯一能暴露 request/notification 错配的连接点。

### 2.5 物理数据流（现状）

```
[主线程]                            [Worker/子进程]
executeHooks('onBeforeSendMessage')
  → HookPipeline.execute
    → invoke(id=1, 'plugin.hooks.invoke')
      ──── request{id:1} ────────→  handleIncomingRequest
                                    → 只认 plugin.tool.execute
      ←── error{METHOD_NOT_FOUND} ──  else 分支立即回错
    → reject → catch → warn → 放行
（hook handler 从未被调用）
```

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**成功路径**（demo 插件改写场景）：
1. 用户发送含 `!important` 的消息；
2. 主线程 `executeHooks('onBeforeSendMessage', {data})` → HookPipeline 找到 handler → `invoke(workerId, 'plugin.hooks.invoke', {handlerId, hookType, context})`；
3. Worker `handleIncomingRequest` 命中 `plugin.hooks.invoke` 分支 → 查本地 handler Map → 调 handler → 得到 `{proceed: true, modifiedData: {content: '...IMPORTANT...'}}` → 作为响应原样回传；
4. 主线程把 `modifiedData` 映射进 `HookResult.transformedData` → 消费侧用改写后的内容发消息；
5. 用户在对话流看到消息已按插件规则改写，无告警日志。

**observe 路径**（onPiEvent 场景）：
1. pi 事件到达（如 `agent_start`）→ 主线程 `rpcServer.notify(workerId, 'plugin.hooks.invoke', {handlerId, ...})` 发**无 id 通知**；
2. Worker `handleNotification` 触发已注册的 listener → 调 handler → 结果不回传（fire-and-forget）；
3. 主线程不等待、不创建 pending、不消耗超时定时器。

**失败路径 + 恢复指引**：
- handler 抛错：Worker 分支内 catch → 回传 `{proceed: true}`（维持「异常放行」既有语义），错误记 Worker 侧日志；主线程无感。
- handler 5s 未响应（block 类）：主线程 pending 超时 reject → HookPipeline 放行（语义不变），告警日志保留。
- 插件 Worker 已 crash：`getWorkerHandle` 返回空 → 跳过该 handler（语义不变）。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：request 直连 + observe 走 notification（选）** | ✅ 符合 JSON-RPC 语义（要结果走 request、不要结果走 notification）；observe 高频事件零往返；block/transform 同步可靠 | 中：Worker 分支 + 主线程映射层 + observe 调用点切换 + e2e 测试 | 低：改动集中在 4 个文件 | ✅ |
| B：按原设计意图（主线程发 notify + Worker 回独立 result-request + 主线程补 result handler 桥接） | ❌ 一次调用两次跳（invoke 通知 + result 请求），且主线程需维护「handlerId → pending」第二套映射，复杂度高于 A | 高：两处 handler + 桥接簿记 | 中：双跳协议更易错 | ❌ 若用它：§3.1 的成功路径变成 invoke 通知→Worker 执行→result 请求→主线程查第二套 pending 表→resolve，多一跳多一套状态 |
| C：全 request 直连、observe 不区分 | ⚠️ 简单但留下已知性能隐患：onPiEvent 每个 pi 事件一次完整往返 + 5s 定时器创建/清除，正是本次分析要消除的「串行 RPC 放大」 | 低 | 中：性能问题原样保留 | ❌ 若用它：agent_start 等高频观测事件在 N 插件下 N 次串行往返，高流量会话延迟线性恶化 |

**推荐 A**。理由：修复 bug 与性能优化一次做对——block/transform 语义需要回传，走 request；observe 语义本来就 fire-and-forget（调用点全部 `.catch(() => {})` 不消费结果），走 notification 零成本。

### 3.3 关键决策与权衡

**D2-1：Worker 侧在 `handleIncomingRequest` 增加 `plugin.hooks.invoke` 分支，而不是改主线程发 notification**。
- 选择：request 分支（A）。被否：主线程改发 notify（B 的前半）。
- 证据：block/transform 必须同步拿结果；主线程 `invoke` 已具备 pending/超时/错误处理全套设施，复用零成本；worker 侧 `handler-registry.ts` 的 `dispatchHandler` 骨架（查 Map → 调 handler）已就绪。
- 注意：createHookApi 的 handler Map 是闭包私有，需从 `createHookApi` 导出「按 handlerId 执行并返回 Promise<结果>」的入口（如 `executeHookRequest(params)`），供 `handleIncomingRequest` 调用——这是本决策唯一的接口新增点。

**D2-2：observe 类 hook 一律走 `rpcServer.notify`（无 id）**。
- 选择：`onPiEvent`（event-interpreter 5 处调用点）与 bridge observe 类事件（`bridge-interop.ts` 的 `kind:'observe'` 映射组）改走 notify。
- 证据：调用点全部 fire-and-forget（`.catch(() => {})`），不读 `blocked`/`transformedData`；`PI_HOOK_EVENT_MAP` 已明确标注 `kind: 'intercept' | 'observe'`（`bridge-interop.ts:33-44`），分类依据现成。
- 边界：`onAfterToolResult` 既是 transform 又是 observe——它需要 `transformedData`（output 改写），**保持 request**；其观察需求由同事件的 `onPiEvent` 通知覆盖。

**D2-3：字段契约统一——`modifiedData` → `transformedData` 映射层**。
- 选择：`HookPipeline.execute` 收到 Worker 响应 `{proceed, modifiedData, reason}` 后，映射为 `HookResult = { blocked: !proceed, blockedBy, reason, transformedData: modifiedData }`；下游 handler 间的 `context.data` 传递保持不变。
- 证据：消费侧（event-interpreter / plugin-service sendMessage hook）读 `transformedData`；Worker 契约 `InterceptorResult` 用 `modifiedData`；映射层放主线程（`hook-pipeline.ts`）一次收口，两侧契约都不破坏。
- 运行时断言（✅已探明）：`hook-types.ts:35` InterceptorResult 用 modifiedData；`hook-types.ts:71` HookResult 用 transformedData；`event-interpreter.ts:296-297,348` 消费 transformedData。字段名两侧无统一映射层。

**D2-4：onPiEvent 注册/调用 key 统一**。
- 选择：调用侧与注册侧统一为**泛型 `onPiEvent`**（不按事件名细分）。事件名已作为 `context` 内的 `event` 字段传给 handler，插件可在 handler 内自行按事件名过滤。
- 被否：注册侧改为泛型而调用侧按 `onPiEvent:${eventName}` 逐事件调用——主线程需要在每个事件点构造动态 key，且 `PI_HOOK_EVENT_MAP` 的映射结构不匹配。
- 证据：`event-interpreter.ts:267,310,315,356,407` 全部用泛型 `onPiEvent` 调用；`hook-api.ts:225` 用 `onPiEvent:${eventName}` 注册。统一后事件名短路（无匹配 handler 时 `entries.length === 0` 直接 return）仍生效。

**D2-5：性能优化并入修复**。
- 注册时排序：`HookPipeline.execute` 每次 `[...entries].sort()`（`hook-pipeline.ts:66`）→ 改为 `hookRegistry` 注册时插入有序（`hook-api.ts:75` 的 register 处理中保序），execute 直接遍历。
- `pluginId → workerId` 反向索引：`getWorkerHandle` 线性扫全 worker（`plugin-host.ts:296-315`）→ 维护 `Map<pluginId, handle>`，assign/terminate/crash 时同步维护。
- 证据：两处均为每 handler 一次的全量扫描/排序，在修复后的真实执行路径上才会显形。

**D2-6：端到端测试（防盲区复发）**。
- 选择：新增 e2e 测试，用**真实** `plugin-bootstrap.handleMessage` + 真实 `PluginRpcServer`（内存 MessagePort 对）串起「invoke → handleIncomingRequest → handler → 响应」，断言：block 生效、transform 生效、observe 通知不产生响应。现有单测保留（验纯逻辑）。
- 证据：盲区根因是「两个测试文件各自 mock 掉传输层」；e2e 测试用真实路由正是消除盲区的唯一手段。

---

## §4 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | 真实 app 中，demo 插件（已随 runtime 打包）拦截消息改写 | 启动 dev 应用（demo 插件激活）→ 发送含 `!important` 的消息 | 对话流中该词被改写为 `IMPORTANT`（历史消息与实时流一致）；runtime 日志**无** `hook handler ... failed/timed out` 告警 | 目标 1（hook 真实执行） |
| V2 | 写一个测试插件注册 `onBeforeToolCall`，对某工具返回 `proceed: false` | 在真实会话中触发该工具调用 | 工具调用被阻断，对话流显示插件给出的拒绝原因，agent 不再继续该工具 | 目标 1 |
| V3 | 测试插件注册 `onAfterToolResult` 改写 output | 触发一次工具调用 | 对话流中工具结果展示的是改写后的文本 | 目标 1 |
| V4 | 测试插件注册 `onPiEvent`（agent_start）并写入自己的日志文件 | 跑一个真实 agent turn | 插件日志出现 agent_start 记录；主线程无该事件相关的 pending 超时告警 | 目标 2（observe 免往返） |
| V5 | e2e 测试套件跑通 | `npx vitest run <新增 e2e 测试文件>` | 新 e2e 测试绿；现有 `plugin-hooks-serial.test.ts`/`plugin-api-hooks.test.ts` 不因重构而红（或按需小改断言） | 目标 3（防盲区） |

---

## §5 下一层拆分

实施路径：单阶段交付（改动集中、可一次完成），但按「先通后优」拆 commit：

| # | 拆分单元 | justification | 文件改动地图 |
|---|---|---|---|
| U1 | Worker 侧 request 分支 + 执行入口导出 | 最小修复点：让 request 直连 handler | `plugin-bootstrap.ts`（handleIncomingRequest 加分支）；`hook-api.ts`（导出 executeHookRequest） |
| U2 | 主线程字段映射层 | 修 transform 被丢弃的次生 bug | `hook-pipeline.ts`（响应 → HookResult 映射） |
| U3 | observe 走 notification + key 统一 | 性能分层 + 修 key 错配 | `event-interpreter.ts`（5 处 onPiEvent 调用点 + 观察类调 notify）；`bridge-interop.ts`（observe 组）；`plugin-service.ts`（executeHooks 增加 observe 快捷路径） |
| U4 | 注册时排序 + worker 反向索引 | 修复后性能优化（每 handler 免 sort + 免线性扫描） | `hook-api.ts`（register 保序）；`plugin-host.ts` / `plugin-host-process.ts`（反向索引维护） |
| U5 | 端到端测试 | 消灭 mock 盲区 | 新增 `plugin-hooks-e2e.test.ts`（真实 bootstrap + 内存 MessagePort 对） |

**待验证检查点**：
- `plugin-bootstrap-process.ts` 复用 `handleMessage` 后，fork 沙箱的 hook 路径是否随 U1 自动修复（应自动修复，实施时以 e2e 双宿主各跑一遍确认）。
- `bridge-interop.ts` 的 `handleBridgeIntercept`（before_agent_start 拦截）依赖 `injectedMessages` 的返回语义——确认与 `HookResult` 映射层的字段对齐，实施 U2 时核对。
