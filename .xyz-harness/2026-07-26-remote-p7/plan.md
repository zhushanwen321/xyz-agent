# 远程化 P7 实施计划：插件 ActiveSessionResolver 绑 clientId

**日期**: 2026-07-26 | **spec**: [spec.md](spec.md)（决策编号 D1-D6 在此引用） | **前置**: P5（clientId 透传 + presence Map + setActive RPC + leaseManager）已实施

> 所有 Task 遵守：vitest；lint/hook 问题正面修复；**不主动 git commit**。
>
> **P7 是最小阶段**（feature-map 预估「runtime 小改」），改动集中在 plugin-service 一处。

---

## 任务清单

### T0 — AsyncLocalStorage 引用确认（spec §2.0，C1 解法基础）

**【R2-m1 修正】不新建 async-context.ts**（P5 plan T2 已新建该文件并落地 als.run）：
- `packages/runtime/src/infra/async-context.ts`（**P5 plan T2 已建**）：`export const sessionContext = new AsyncLocalStorage<{ clientId?: string }>()`
- **本 Task 仅做引用确认**：核实 P5 plan T2 已落地 `sessionContext.run({ clientId }, () => this.handleMessage(...))`（server.ts handleMessage 入口），P7 plan T3 直接 import sessionContext 用 `sessionContext.getStore()?.clientId` 取
- **若 P5 尚未实施**：本 Task 退化为「记录 P7 对 P5 的反向需求，P5 实施时落地 ALS 注入」

**测试**（**【R2-m1】P5 plan T2 已建 `infra/async-context.test.ts`，P7 不重复**）：
- P5 plan T2 的 ALS 测试已覆盖：run 内/外 getStore、异步链路透传、无 run 时 undefined
- P7 验证时引用 P5 测试结果即可

---

### T1 — connection-manager / leaseManager 暴露查询方法

**文件**：
- `packages/runtime/src/transport/connection-manager.ts`：暴露 `getActiveSession(clientId): string|undefined|null`（P5 已维护 `activeSessions: Map<clientId, sessionId|null>`，加 getter，**R1-M4 命名统一**）
- `packages/runtime/src/services/session/lease-manager.ts`：暴露 `getBusySession(clientId): {sessionId}|undefined`（扫描 allSessions 找 busyOwnerId=clientId）

**测试**：
- `transport/connection-manager.test.ts`（扩展）：setActive 后 getActiveSession 命中；未 setActive 返回 undefined
- `services/session/lease-manager.test.ts`（扩展）：acquire 后 getBusySession 命中；release 后未命中

---

### T2 — ActiveSessionResolver 改造（spec §2.1，D1/D2/D3/D4）

**文件**：
- `packages/runtime/src/services/plugin-service/api/session-api.ts:33-67`：
  - resolve 签名改为 `resolve(clientId: string | undefined): SessionSummary | null`（undefined 走全局 fallback）
  - cache 从单值改为 `Map<clientId|'global', {sessionId, ts}>`
  - 数据源切换：有 clientId 时走 connectionManager.getActiveSession + leaseManager.getBusySession；miss 或无 clientId 走 findGlobalActiveSession（现状扫描逻辑）
  - 构造函数注入 connectionManager + leaseManager
  - 抽出 findGlobalActiveSession 私有方法（复用现状 listPersistedSessions + find status==='active'）
- `packages/runtime/src/services/plugin-service/`（组合根）：ActiveSessionResolver 实例化时注入 connectionManager + leaseManager

**测试**（`services/plugin-service/api/session-api.test.ts` 扩展或新建）：
- resolve('A') setActive sessionX → 返回 X
- resolve('B') setActive sessionY → 返回 Y（per-clientId 隔离）
- resolve('C') 无 setActive + 持有 lease sessionZ → fallback lease 命中 → 返回 Z
- resolve(undefined) → 返回全局 isGenerating session（D3 第三级 fallback，现状行为）
- resolve('D') 无 setActive 无 lease 且全局无 active → null
- TTL：2s 内重复 resolve('A') 不重算；'global' key 独立 cache

---

### T3 — RPC handler 用 ALS 取 clientId（spec §2.2，D6，C1 核心解法）

**文件**：
- `packages/runtime/src/services/plugin-service/api/session-api.ts:77-101`：
  - `SessionHandlers` 接口（deps 类型）：`getActiveSession` 从无参改为 `(clientId?: string) => SessionSummary | null`
  - `registerSessionRpcHandlers` 内的 `plugin.sessions.getActive` handler：`const { clientId } = sessionContext.getStore() ?? {}; return deps.getActiveSession(clientId)`
  - `plugin.sessions.sendMessage` handler：sessionId undefined 时同上取 clientId → getActiveSession(clientId) → null 则 throw RpcError('no_active_session')
- `packages/runtime/src/services/plugin-service/`（组合根 / plugin-host）：deps.getActiveSession 的实现改为调 activeSessionResolver.resolve(clientId)（透传 ALS 取到的 clientId）

**测试**：
- getActive handler：`sessionContext.run({clientId:'A'}, () => rpcServer.invoke('plugin.sessions.getActive'))` → deps.getActiveSession 收到 'A'
- getActive handler 无 ALS：直接 invoke（不包 run）→ deps.getActiveSession 收到 undefined → 走全局 fallback
- sendMessage handler：sessionId undefined + ALS clientId='A' → resolve('A') 命中 → 用该 sessionId；resolve 返回 null → throw RpcError
- sendMessage handler：sessionId 明确传入 → 不调 resolver（直接用传入的 sessionId）

---

### T4 — feature-map 同步 + verify 脚本

**文件**：
- `docs/feature-map/2026-07-26-remote.md`：
  - §九 P7 描述确认
  - §十一索引追加 P7 spec/plan 链接
  - §3.2「插件活跃 session 全局唯一」阻断点标注：已解决（P7，ALS + 四级 fallback）
- `tools/verify-plugin-active.cjs`（新建）：真 runtime + 真 plugin 场景
  - 场景 1：A 连接 + setActive sessionX + WS 触发 plugin getActive → 返回 X
  - 场景 2：B 连接 + setActive sessionY + WS 触发 → 返回 Y
  - 场景 3：无 WS 触发的 plugin 调用（如 plugin 自己的定时器）→ 返回全局 active session

---

## 依赖与顺序

```
T0（ALS 基础设施）─→ T3（handler 用 ALS）
T1（getter）─→ T2（resolver 改造）─→ T3（handler 注入）
T4 依赖 T1-T3 完成
```

P7 内部：T0 + T1 可并行（独立基础设施），T2 依赖 T1，T3 依赖 T0+T2。
**外部依赖**：
- P5 完整实施（clientId 透传 + presence Map + leaseManager）
- **P5 plan T2 需补 `sessionContext.run({clientId}, ...)`**（P7 spec §2.0 提出需求，P5 实施时落地 ALS 注入）

## DoD

0. **【R2-m4 前置 gate】** P5（activeSessions Map + leaseManager.getBusySession + ALS 注入 `sessionContext.run`）已实施——P7 resolver 数据源 + fallback + clientId 透传都依赖 P5 基础设施
1. vitest 全绿（runtime，新增 + 现有）
2. `tools/verify-plugin-active.cjs` exit 0
3. spec §六测试计划全覆盖（resolve per-clientId / TTL cache / fallback 链 / sendMessage active 解析）
4. feature-map §九 P7 + §3.2 阻断点标注更新
5. `npm run lint` + pre-commit 全过
6. **客户端可见断言**：端到端测试中 plugin getActive 返回 per-client 正确 session（verify 脚本断言）
