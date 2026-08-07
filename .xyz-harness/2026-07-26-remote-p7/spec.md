# 远程化 P7 设计：插件 ActiveSessionResolver 绑 clientId

**日期**: 2026-07-26 | **状态**: 设计定稿（待实施） | **上游方案**: [docs/feature-map/2026-07-26-remote.md](../../docs/feature-map/2026-07-26-remote.md)（§九 P7 阶段、§8.4 P4、§3.2「插件活跃 session 全局唯一」阻断点） | **前置设计**: [P5](../2026-07-26-remote-p5/spec.md)（clientId 透传 + presence + session.setActive RPC）

> P7 范围（feature-map §九）：插件活跃 session 的 per-client 化——`ActiveSessionResolver` 当前返回 runtime 全局唯一 active session，多客户端各有活跃 panel 时插件拿到错误的 session。改造为 resolver 绑 clientId。feature-map 预估「runtime 小改」。
>
> **代码核实后的关键发现**（explorer 报告）：
> 1. **ActiveSessionResolver 位置确认**：`packages/runtime/src/services/plugin-service/api/session-api.ts:33-67`（feature-map 说 `extension/api/`，实际是 `plugin-service/api/`——本仓 plugin-service 即 extension 域）。
> 2. **"全局唯一 active session" 是隐式派生**：`resolve()` 扫描 `listPersistedSessions()` 找第一个 `status==='active'`（即 isGenerating=true），**不是显式全局变量**。status 由 `session-service.ts:715 toSummary` 计算：`s.isGenerating ? 'active' : 'idle'`。
> 3. **插件拿 session 的两条路径**：`plugin.sessions.getActive`（→ deps.getActiveSession → ActiveSessionResolver.resolve）和 `plugin.sessions.sendMessage(undefined, ...)`（sessionId 可选，undefined 时解析 active session）。**两条路径都不知道 clientId**。
> 4. **注释提到历史**（session-api.ts:24-26）：曾有 `_activeSessionCache` 模块全局，现已收口为实例 cache（TTL 2s）。当前 cache 仍是全局语义（不区分 clientId）。
> 5. **P5 已建 `activeSessions: Map<clientId, sessionId|null>`**（presence 推送用，**R1-M4 命名统一**）——P7 直接复用这个 Map 作为 resolver 的数据源，不需要新造机制。
> 6. **【C1 核心阻断，审查发现】plugin RPC 不走 WS handler ctx**：`plugin.sessions.getActive/sendMessage` 通过 `rpcServer.registerMethod`（session-api.ts:82,92,96）注册到 **PluginRpcServer**（主线程↔Worker 的 JSON-RPC 通道），**不是** WS 路由表里的 handler。`deps.getActiveSession` 在 `registerSessionRpcHandlers` 调用时被绑成**无参闭包**（:92-93），根本没有 clientId 可传。P5 的 ctx.getClientId() 透传链只覆盖 WS 路由的 6 个 handler，**完全不触及 plugin-host 的 RPC dispatch**。
>
> **P7 是 P5/P6 之后的最小阶段**：依赖 P5 的 `activeSessions: Map<clientId, sessionId|null>` + lease（per-client active session 记录，**R1-M4 命名统一**）。**但 P7 的核心难点不在 ActiveSessionResolver 改造，而在「clientId 如何到达 plugin worker RPC 调用」**——plugin 操作的发起方可能不是 WS 请求（如 hook 触发、定时器），需要独立设计 clientId 上下文传递路径（见 §2.0）。

---

## 一、设计决策总表

| # | 决策 | 选择 | 理由 / 证据 |
|---|---|---|---|
| D1 | **resolver 数据源切换** | ActiveSessionResolver 从「扫描 listPersistedSessions 找 isGenerating」改为「从 connection-manager 的 `activeSessions: Map<clientId, sessionId|null>` 取」 | P5 已为 presence 维护 per-client active session Map（feature-map §4.1 `activeSessions: Map<clientId, sessionId|null>`，**R1-M4 命名统一**）。resolver 直接读这个 Map 即可，无需新数据源。语义对齐：插件的"active session"应等于客户端正在看的 session，而不是"任何正在生成的 session" |
| D2 | **resolver 签名加 clientId** | `resolve(clientId: string): SessionSummary \| null`。调用方（getActive、sendMessage）从 plugin 调用上下文取 clientId 传入（见 §2.0） | 现状 resolve() 无参，扫描全局。P7 改为必须传 clientId |
| D3 | **fallback 策略** | `activeSessions: Map<clientId, sessionId|null>` 取不到（客户端未调 session.setActive，如刚连上还没切 panel）→ fallback 到「该 clientId 是否持有任何 lease」（P5 busyOwnerId）→ 再 fallback **全局 active**（扫描 isGenerating，现状行为）→ 再 fallback null | 四级 fallback：①正常 setActive 过 → Map 命中；②刚连上未 setActive 但正在操作 pi → lease 命中；③无 clientId 上下文（hook/定时器触发）→ 回退全局 active（与现状等价，零回归）；④什么都没有 → null |
| D4 | **TTL cache 改为 per-clientId** | 现状 2s TTL cache（避免高频 resolve 扫描）改为 `Map<clientId \| 'global', { sessionId, ts }>`，per-key 各自 2s TTL | 切换数据源后 resolve 已是 O(1)，cache 作为防御保留。'global' key 兜底 D3 第三级 |
| D5 | **协议不变** | 不新增 RPC 类型。`plugin.sessions.getActive` 和 `plugin.sessions.sendMessage` 协议层不变，只是服务端实现读取 clientId | 插件 API 对前端透明——插件代码无感，只是服务端给的 active session 变"准"了 |
| D6 | **【重写】clientId 到 plugin worker 的传递路径** | **plugin 调用分类**：①源于 WS 请求的 plugin 操作（如客户端调 `extension.ui_response` 触发 plugin hook）—— 用 **AsyncLocalStorage** 在 WS handler 入口注入 clientId，plugin-host RPC dispatch 同线程透传；②不源于 WS 的 plugin 操作（hook 自触发/定时器/extension 生命周期）—— **无 clientId**，resolver 走 D3 第三级全局 active fallback（与现状等价）。**不强行给所有 plugin 调用伪造 clientId** | 审查 C1 发现：plugin RPC 经 PluginRpcServer（主线程↔Worker JSON-RPC），不经过 WS handler 的 MessageHandlerContext。但 plugin 操作的**根因**几乎都是某次 WS 请求（用户操作 → plugin 响应）。AsyncLocalStorage（Node.js 原生，无依赖）在同线程异步链路自动透传，WS handler 入口 `als.run({ clientId }, () => handleMsg())`，plugin-host.dispatch 经 RPC 到主线程 handler 时 `als.getStore()` 可读 clientId。跨 Worker Thread 边界（主线程 → Worker）时 AsyncLocalStorage **不自动透传**——需在 RPC 请求参数显式带 clientId，Worker 内 plugin 调用 getActive 时 RPC 回主线程再带上。**简化**：Worker 内 plugin API 调用一律经主线程 RPC（现状如此，createSessionApi 的所有方法都 `rpcClient.request`），主线程 handler 用 AsyncLocalStorage 取 clientId。Worker Thread 本身不需要持有 clientId |
| D7 | **【新增】AsyncLocalStorage 例外** | plugin **不源于 WS 请求**的场景（hook 链式触发、`onDidCreateSession` 等生命周期通知、定时器）—— AsyncLocalStorage 无 store，resolver 收到 undefined clientId → D3 fallback 到全局 active（扫描 isGenerating）。**这是可接受的降级**：无明确发起方的 plugin 操作用全局 active 是现状行为，零回归 | 不强行给 hook 链路注入"触发者 clientId"——hook 可能跨多个 plugin 链式触发，追踪发起者复杂度高且收益低（hook 场景罕见）。D3 fallback 保证不崩 |

**明确不在 P7**：
- 插件 per-client 数据隔离（plugin sessionData 已是 per-session，不是 per-client；多客户端看同一 session 共享 sessionData 是正确语义）
- 插件 UI 的 per-client 渲染（extension.ui_request 是 session 级广播，所有客户端都看到同一份审批 UI 是正确语义）
- 插件 presence（插件不需要知道"谁在线"）
- hook 链路发起者追踪（D7 例外，降级到全局 active）

**对 P5 的依赖**：`activeSessions: Map<clientId, sessionId|null>`（D1 数据源，**R1-M4 命名统一**）+ lease busyOwnerId（D3 fallback）+ **AsyncLocalStorage 需在 P5 WS handler 入口注入 clientId**（D6，P7 spec 提出需求，P5 plan T2 透传链第 4-5 层落地时一并加 als.run）。

---

## 二、实现

### 2.0 clientId 到 plugin worker 的传递路径（C1 核心阻断的解法）

**问题回顾**（审查 C1）：`plugin.sessions.getActive/sendMessage` 注册在 PluginRpcServer（主线程↔Worker JSON-RPC），`deps.getActiveSession` 是无参闭包（session-api.ts:92-93），P5 的 WS handler ctx.getClientId() 到不了。

**解法：AsyncLocalStorage（ALS）+ 调用源分类**

```
┌─────────────────────────────────────────────────────────────────┐
│ 主线程                                                           │
│                                                                  │
│  WS handler 入口（P5 server.ts handleMessage）                   │
│    als.run({ clientId }, () => routeToHandler(msg, ws))  ← D6    │
│                                                                  │
│  plugin-host RPC dispatch（主线程侧 registerMethod handler）     │
│    const clientId = als.getStore()?.clientId   ← 同线程透传      │
│    resolver.resolve(clientId)   ← clientId 可能为 undefined      │
│                                                                  │
│  hook 链式触发 / 定时器 / 生命周期通知                           │
│    als.getStore() === undefined  ← D7 例外                       │
│    resolver.resolve(undefined) → D3 fallback 到全局 active      │
└─────────────────────────────────────────────────────────────────┘
        ▲ RPC（主线程 ↔ Worker）            ▲ RPC reply
        │ pluginId 在请求参数               │ 主线程 handler 用 ALS 取 clientId
┌───────┴──────────────────────────┐    ┌──┴───────────────────────────┐
│ Worker Thread（plugin 执行）      │    │ Worker → 主线程 RPC 请求      │
│                                   │    │ rpcClient.request(            │
│ plugin.getActive()                │───▶│   'plugin.sessions.getActive',│
│   ↓ rpcClient.request             │    │   { pluginId }                │
│   （Worker 不持有 clientId）       │    │ )                             │
└───────────────────────────────────┘    └───────────────────────────────┘
```

**关键设计点**：
1. **ALS 在 P5 的 WS handler 入口注入**（P5 plan T2 第 4 层 server.ts handleMessage 加 `als.run({ clientId }, () => ...)`）。这是 P7 对 P5 的反向需求——P7 spec 提出后，P5 plan T2 需补这一步。
2. **plugin-host RPC handler 是主线程同步异步链路**：Worker 经 `rpcClient.request` 发 RPC → 主线程 `PluginRpcServer` 的 registerMethod handler 在主线程事件循环执行 → 同一线程的 ALS store 可读（Node.js ALS 语义保证同异步链路透传，包括 Promise.then/setTimeout 回调）。
3. **Worker Thread 不持有 clientId**：plugin 在 Worker 内调 `getActive()` 经 RPC 回主线程，主线程 handler 用 ALS 取 clientId。Worker 不需要知道 clientId（plugin API 也不暴露 clientId 给 plugin 代码）。
4. **ALS 不跨进程/不跨 Worker**：ALS 是同进程同线程的异步上下文。主线程↔Worker 是消息传递，ALS 不自动透传——但本设计**不需要**透传到 Worker（Worker 只发 RPC 请求，主线程 handler 处理时在 ALS 作用域内）。

**ALS 实现位置**：
- 新建 `packages/runtime/src/infra/async-context.ts`：`export const sessionContext = createAsyncContext<{ clientId?: string }>()`（封装 node:async_hooks 的 AsyncLocalStorage）
- P5 server.ts handleMessage：`sessionContext.run({ clientId }, () => this.handleMessage(msg, ws, clientId))`
- P7 plugin-host handler：`const { clientId } = sessionContext.getStore() ?? {}`

**例外场景（D7）**：
- hook 链式触发：plugin A 的 hook 触发 plugin B 的 hook → plugin B 调 getActive → 此时 ALS 可能有 store（若 hook 链源于 WS）或无 store（若 hook 链源于定时器/生命周期）。ALS 自动跟随异步链路，hook 链源于 WS 则整链路有 store。
- 定时器/`onDidCreateSession` 生命周期通知：无 WS 触发源，ALS 无 store → resolver fallback 到全局 active。
- **不补救这些例外**：全局 active 是现状行为，零回归；强行追踪「hook 链的原始 WS 发起者」复杂度高收益低。

### 2.1 ActiveSessionResolver 改造

`packages/runtime/src/services/plugin-service/api/session-api.ts:33-67`：

```ts
// 现状（:33-67）
class ActiveSessionResolver {
  private cache: { sessionId: string; ts: number } | null = null   // 全局 cache
  resolve(): SessionSummary | null {
    if (cache hit) return sessionService.getSummary(cache.sessionId)
    const sessions = listPersistedSessions()
    const active = sessions.find(s => s.status === 'active')
    ...
  }
}

// P7 目标
class ActiveSessionResolver {
  // D4 per-key cache（clientId 或 'global'）
  private cache = new Map<string, { sessionId: string; ts: number }>()

  resolve(clientId: string | undefined): SessionSummary | null {
    const cacheKey = clientId ?? 'global'
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.ts < 2_000) {
      return sessionService.getSummary(cached.sessionId) ?? null
    }

    // D3 四级 fallback
    let sessionId: string | undefined
    if (clientId) {
      // 有 clientId：per-client 链路
      sessionId =
        connectionManager.getActiveSession(clientId)         // ① P5 Map 命中
        ?? leaseManager.getBusySession(clientId)?.sessionId  // ② lease fallback
    }
    // ③ 无 clientId 或 per-client 链路都 miss → 全局 active fallback（现状行为）
    if (!sessionId) {
      sessionId = this.findGlobalActiveSession()              // 扫描 isGenerating
    }
    // ④ 仍无 → null
    if (!sessionId) return null

    this.cache.set(cacheKey, { sessionId, ts: Date.now() })
    return sessionService.getSummary(sessionId) ?? null
  }

  private findGlobalActiveSession(): string | undefined {
    // 现状 resolve() 的扫描逻辑（listPersistedSessions + find status==='active'）
    const sessions = this.listPersistedSessions()
    return sessions.find(s => s.status === 'active')?.sessionId
  }
}
```

**依赖注入**：ActiveSessionResolver 构造函数加 `connectionManager` 和 `leaseManager` 参数（plugin-service 组合根注入）。

**关键点**：`clientId === undefined` 时走全局 active（D3 第三级 + D7 例外），与现状行为完全等价——hook/定时器触发的 plugin 调用零回归。

### 2.2 调用方改造（C1 解法：ALS 取 clientId）

`packages/runtime/src/services/plugin-service/api/session-api.ts:77-101` RPC handler：

```ts
// 现状（:77-101）—— deps.getActiveSession 是无参闭包
export function registerSessionRpcHandlers(rpcServer, deps) {
  rpcServer.registerMethod('plugin.sessions.getActive', async (_params) => {   // R3-m4: 现状是 _params 非 ()
    return deps.getActiveSession()   // 无 clientId
  })
}

// P7 目标—— 从 ALS 取 clientId（D6）
import { sessionContext } from '@/infra/async-context'

export function registerSessionRpcHandlers(rpcServer, deps) {
  rpcServer.registerMethod('plugin.sessions.getActive', async () => {
    const { clientId } = sessionContext.getStore() ?? {}   // D6 ALS 取
    return deps.getActiveSession(clientId)                 // 透传给 resolver
  })

  rpcServer.registerMethod('plugin.sessions.sendMessage', async (params) => {
    let { sessionId, role, content } = params
    if (!sessionId) {
      const { clientId } = sessionContext.getStore() ?? {}
      const active = deps.getActiveSession(clientId)       // D2 传 clientId
      if (!active) {
        throw new RpcError('no_active_session')            // plugin 收到错误自己处理
      }
      sessionId = active.sessionId
    }
    await deps.sendMessage(sessionId, role, content)
  })
}
```

**关键变化**：`deps.getActiveSession` 从无参闭包改为 `(clientId?) => ...`（session-api.ts:92 现状的 `getActiveSession()` 签名扩展）。SessionHandlers 接口的 `getActiveSession` 字段类型相应改。

**ALS 何时有 store**：
- WS 请求触发的 plugin 操作（用户点审批 → extension.ui_response → plugin hook → getActive）：P5 server.ts handleMessage 用 `sessionContext.run({ clientId }, ...)` 包裹，整异步链路 ALS 有 store
- hook 自触发/定时器/生命周期：ALS 无 store → clientId undefined → resolver 全局 fallback（D7）

### 2.3 connection-manager 暴露 getActiveSession

`packages/runtime/src/transport/connection-manager.ts`：

P5 已维护 `activeSessions: Map<clientId, sessionId | null>`（presence 用，**【R1-M4】命名统一**）。P7 暴露公共方法：

```ts
getActiveSession(clientId: string): string | undefined {
  return this.activeSessions.get(clientId)
}
```

### 2.4 leaseManager 暴露 getBusySession

`packages/runtime/src/services/session/lease-manager.ts`（P5 新建）：

```ts
getBusySession(clientId: string): { sessionId: string } | undefined {
  for (const [sid, session] of sessionService.allSessions()) {
    if (session.busyOwnerId === clientId) return { sessionId: sid }
  }
  return undefined
}
```

**性能**：O(N) 扫描所有 session。N = MAX_SESSIONS（默认 10），可接受。若未来 N 大，可维护反向 Map<clientId, sessionId>。

---

## 三、客户端无改动

P7 对前端透明：
- 插件 API 协议不变（D5）
- 插件 UI 渲染不变（extension.ui_request 仍是 session 级广播）
- 客户端只需在 P5 已做的 session.setActive 基础上无新增

**唯一前置确认**：客户端是否在 P5 已正确调 session.setActive？——是，P5 spec §4.4「客户端切 panel 时调 session.setActive」。P7 复用这个上报。

---

## 四、与 P5/P6 的衔接

| P7 改动 | 依赖 |
|---|---|
| resolver 读 activeSessions Map | P5 的 `activeSessions: Map<clientId, sessionId|null>` + getActiveSession 方法（**R1-M4 命名统一**） |
| resolve(clientId) 签名 | P5 的 ctx.getClientId() |
| lease fallback | P5 的 leaseManager + busyOwnerId 字段 |
| 主线程 handler 注入 clientId | P5 的 clientId 透传链 |

**结论**：P7 是 P5 的纯消费方，零新机制。

---

## 五、与 feature-map §8.4 P4 原文的对照

| feature-map §8.4 P4 原文 | 本设计落点 |
|---|---|
| ActiveSessionResolver 当前返回 runtime 全局唯一 active session | 现状确认（explorer 报告） |
| resolver 绑 clientId | D1/D2 |
| 从 `activeSessions: Map<clientId, sessionId|null>` 取 | D1（复用 P5 Map，**R1-M4 命名统一**） |

**与 feature-map 一致**：无偏离。feature-map 预估「runtime 小改」与实际匹配（改动集中在 session-api.ts 一处 + connection-manager 暴露方法）。

---

## 六、测试计划

框架 vitest。

| 测试 | 位置 | 要点 |
|---|---|---|
| resolve per-clientId | `services/plugin-service/api/session-api.test.ts`（新建或扩展） | A setActive sessionX → resolve('A') 返回 X；B setActive sessionY → resolve('B') 返回 Y |
| resolve 全局 fallback（D3 第三级） | 同上 | resolve(undefined) → 返回全局 isGenerating 的 session（现状行为）；无任何 active → null |
| resolve lease fallback（D3 第二级） | 同上 | A 持有 sessionZ lease 但未 setActive → resolve('A') 返回 Z |
| TTL cache per-key | 同上 | 2s 内重复 resolve('A') 不重算；advance 2.1s 重算；'global' key 独立 cache |
| ALS 透传 | `infra/async-context.test.ts`（新建） | sessionContext.run({clientId:'A'}) 内 getStore() 返回 {clientId:'A'}；run 外 getStore() 返回 undefined；异步链路（Promise.then/setTimeout）透传 |
| plugin handler ALS 取 clientId | `plugin-service/api/session-api.test.ts` | mock sessionContext.run({clientId:'A'}) → registerMethod handler 调用 → deps.getActiveSession 收到 'A'；无 run → deps.getActiveSession 收到 undefined |
| sendMessage active 解析 | 同上 | sendMessage(undefined) + ALS 有 clientId → 用 resolve(clientId)；resolve 返回 null → throw RpcError |
| 端到端 | `tools/verify-plugin-active.cjs`（新建） | 真 runtime + 真 plugin：A 在 sessionX 触发 plugin getActive（WS 触发）→ 返回 X；B 在 sessionY → 返回 Y；hook 触发（无 WS）→ 返回全局 active |

---

## 七、开放问题

1. **lease fallback 的语义**：D3 第二级 fallback 用「该 clientId 持有的 lease session」。A 持有 sessionX 的 lease 意味着 A 正在跟 pi 对话，此时 plugin getActive 返回 sessionX 合理——A 正在操作的 session 就是 A 的 active session。fallback 顺序 setActive → lease → global → null 是对的。
2. **plugin.sessions.sendMessage 的 no_active_session 错误**：插件调用 sendMessage(undefined) 时若无 active session（resolver 四级 fallback 都 miss），throw RpcError。插件代码需处理（建议先 getActive 确认）。**plugin SDK 文档化**：sendMessage 不传 sessionId 时，无 active session 会失败。
3. **ALS 跨 Worker 边界**：本设计**不需要**跨 Worker 透传 clientId（Worker 只发 RPC 请求，主线程 handler 处理时在 ALS 作用域内）。但未来若有 plugin 在 Worker 内直接需要 clientId（如 plugin 自己维护 per-client 状态），需在 RPC 请求参数显式带——P7 不做。
4. **ALS 性能**：AsyncLocalStorage 基于 async_hooks，有微小性能开销（~1-5% 异步操作）。runtime 的 WS handler 和 plugin RPC 都是低频操作（相对 pi token 流），开销可忽略。Node.js 22+ 有优化过的 ALS 实现。
5. **clientId='local' 本地模式**：本地 Electron 单连接 clientId='local'，ALS run({clientId:'local'})，resolve('local') 命中 Map。本地模式与远程模式统一路径。
6. **hook 链发起者追踪**（D7 例外）：hook 链源于 WS 时 ALS 自动透传（整异步链路有 store）；源于定时器/生命周期时无 store。**不强行追踪定时器场景的"逻辑发起者"**——复杂度高收益低，全局 active fallback 是合理的现状降级。
