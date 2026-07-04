---
topic: recent-workspaces
deliverable: system-architecture
verdict: pass
stage: mid-plan
complexity_tier: L2
created_at: 2026-07-03
---

# 系统架构 — recent-workspaces（最近工作区独立持久化）

> mid-plan 产出。**系统设计层**，不进入代码级（无 API 签名/时序图/DB schema——那些是 mid-detail-plan 的 code-arch 阶段）。给约束（grep 规则、Port 清单、不变式），不给实现。

## 1. 系统设计立场（设计立场）

### 核心计算是什么？

**这不是业务规则编排，是技术流程编排**——一个极简的「路径 + 时间戳」记录的 CRUD + LRU 淘汰。核心计算（LRU 淘汰逻辑、去重、时间戳排序）是纯算法，无业务规则引擎、无领域聚合行为。

→ **采用三层架构**（runtime 现有 transport/services/infra），**不引入 DDD4 层**（无 aggregate/值对象/领域服务，引入是过度设计）。

### 复杂度归位

复杂度应归位到：
- **runtime services 层**：LRU 淘汰、去重、时间戳管理（业务编排）
- **runtime infra 层**：文件原子写、损坏降级（技术细节）
- **renderer**：UI 渲染 + 状态持有（纯展示 + 拉取）

复杂度**不应**归位到：
- ❌ session 服务内部（会污染 session 职责，session 不应知道「目录还要被记一份」）
- ❌ 前端派生函数（当前就是这个，是改造对象）

## 2. 分层架构（沿用现有三层，新增 workspace 域）

**沿用现有三层**，新增一个 service 域：

```
┌─ Renderer ────────────────────────────────────────┐
│  DirSelectPopover ──→ workspaceStore ──→ workspaceApi.listRecent()│  (pull RPC)
│  useNewTaskFlow ──→ workspaceStore                 │
└───────────────────────┬───────────────────────────┘
                        │ WS request (workspace.listRecent, 带 msg.id)
                        │ WS reply   (workspace.recentList, msg.id 匹配 → pending.resolve)
┌───────────────────────┴───────────────────────────┐
│  transport: WorkspaceMessageHandler               │  (新增 handler, 纯路由 → ctx.reply)
│  services: WorkspaceService + RecentWorkspacesStore│  (新增, 业务编排 + LRU)
│  infra: atomicWrite + getConfigDir()              │  (复用现有)
└───────────────────────────────────────────────────┘
                        ▲ upsert 触发
                        │
┌───────────────────────┴───────────────────────────┐
│  SessionLifecycle.create ──→ WorkspaceService.record │  (写入时机 A)
│  MessageDispatcher.sendPrompt ─→ WorkspaceService.record│  (写入时机 B)
└───────────────────────────────────────────────────┘
```

> **关键边界（业务层）**：session 服务**不直接持有** RecentWorkspacesStore 引用。它通过 WorkspaceService 暴露的 `record(cwd)` 方法间接触发——session 知道「目录被用过」这件事，但不知道「目录要被独立记一份」。Seam 纪律：session→workspace **单向依赖**（session 触发 workspace，workspace 不回调 session），无环。
>
> **注入链路（实测，§6 架构审查路 nit-1 要求补全）**：`WorkspaceService` 在 runtime 组合根（`index.ts`，与 `SessionService` 同处）创建，经 `SessionService` 构造注入到 `SessionLifecycle`/`MessageDispatcher`（与现有 `SessionService` 内部 new lifecycle/dispatcher 的构造注入模式一致）。`WorkspaceService` 与 `SessionService` **平级**，非嵌套，无环。
>
> **方法名精度（架构审查 nit-3）**：写入时机 B 的实际触发方法是 `MessageDispatcher.sendPrompt`（发消息时更新 lastActiveAt 的同一处），非泛指的 `dispatch`。

## 2.1 业务目标 → 系统目标转换（目标转换）

| 业务目标（requirements.md）| 系统目标（本架构）|
|------|------|
| S1 删 session 后目录仍在 | 解除「记录 ← session 文件」派生依赖，独立持久化 |
| S2 独立时间戳排序 | 记录自带 lastUsedAt，不再复用 session.lastActiveAt |
| S3 进程重启不丢 | recent-workspaces.json + atomicWrite |
| S4 新建/重活都记录 | 两个 record 触发点（SessionLifecycle.create + MessageDispatcher）|

**搭便车改造（已确认 D-002）**：**删除** `renderer/lib/utils.ts` 的 `recentWorkspaces()` / `resolveDefaultCwd()` 派生函数，调用方（DirSelectPopover + useNewTaskFlow）改接 workspaceStore。独立记录已覆盖其职责，保留=双数据源漂移。

## 3. 模块拆分（按变化轴）

| 模块 | 会因为什么改？ | 归属 |
|------|---------------|------|
| RecentWorkspacesStore | 持久化策略变（JSON→SQLite，淘汰算法变） | services（核心业务） |
| WorkspaceService | 写入时机触发 + trim（LRU 淘汰）逻辑变 | services（编排） |
| WorkspaceMessageHandler | RPC 契约变 | transport（纯路由） |
| workspaceStore（前端）| 前端状态管理方式变 | renderer |

**不变式：transport 零业务逻辑**（与现有所有 handler 一致：只路由 + reply）。

## 4. Port 清单

> 系统设计层只列「需要哪些 Port」，接口签名属 code-arch（mid-detail-plan）。

| Port | 方向 | 必要性 |
|------|------|--------|
| **前端→runtime RPC**：`workspace.listRecent` | 拉取记录 | **必需**（pull model，见 §6）|
| **service 内部**：`WorkspaceService.record(cwd)` | session→workspace 触发 | **必需**（写入时机）|
| **infra**：`atomicWrite` + `getConfigDir()` | 持久化 | **复用现有，无新 Port**|

**不做新 Port**：pi 侧无改动（与 pi 数据隔离——规则 #11）。filesystem 访问走现有 infra 抽象（atomicWrite 已是 infra 层抽象，复用即可）。

## 5. 核心模型（数据模型，业务概念层，非 schema）

```
RecentWorkspaceRecord（DTO） {
  cwd: string          // 业务标识 + 去重键（目录绝对路径）
  lastUsedAt: number   // 排序键（时间戳，类型/精度属 code-arch）
  label: string        // 派生自 cwd（basename），存或算属 code-arch 决策
}
```

> 模型类型：**DTO**（纯数据传输对象，无行为，无聚合身份）——符合「技术流程编排」判定（§1），不引入 aggregate/实体/值对象。LRU 淘汰/去重是 service 层算法，不沉淀进模型。

**LRU 不变式**：
- 记录数 ≤ 10（`MAX_RECENT_WORKSPACES`）
- 相同 cwd 全局唯一（去重）
- 按 lastUsedAt 倒序，淘汰最小者
- cwd 空串/undefined 拒绝写入（脏数据防御，UC-2.2）

> 文件格式（JSON 数组 vs 对象）、时间戳精度、label 存储策略属 code-arch。

## 6. 控制边界：RPC pull 模型（核心架构决策）

### 决策：pull-only RPC，不做 broadcast

本功能采用 **pull RPC**（`workspace.listRecent`），**不做** broadcast。理由：
1. 记录变更频率低（新建/活跃目录才写）、消费点单一（DirSelectPopover + 默认 cwd 推断），broadcast 引入时序复杂度无收益
2. 避开 CLAUDE.md「Runtime broadcast 时序竞争」约束（renderer 主动拉取，不依赖 broadcast 到达）
3. WriteBackCache 的定时 flush（5s）可能让「刚 record 的目录」还没落盘，但 `listRecent` 读的是 **WriteBackCache 内存视图**（非直接读文件），pull 总能拿到最新值，不受 flush 时机影响（红队 nit-2 要求实现时确认读内存而非读盘）

### 通信路径（实测 `useConnection.ts:52-72` routeInbound）

RPC reply 的消费路径**不走 events.ts 订阅通道**，而是走 pending map（与 `sessionApi.list()` 同模式）：

```
前端 workspaceApi.listRecent()
  → pending.create() + pending.register(id) + transport.send(请求体: type=workspace.listRecent, id, payload=空)
  → runtime WorkspaceMessageHandler 收到 → ctx.reply(ws, msg.id, 'workspace.recentList', 载荷: records 数组)
  → 前端 routeInbound(msg): if (msg.id) → pending.resolve(msg.id, msg.payload)   ← RPC reply 在此兑现
```

`routeInbound` 的两阶段：①先 `if (msg.id) → pending.resolve`（**RPC reply 在此兑现**）；②再无条件按 `payload.sessionId` 分流 session/global 通道（**只给 server-push/broadcast 用**）。本功能 reply 因 payload 无 sessionId 会流入阶段②的 `dispatchGlobal`，但**无订阅者消费 `workspace.recentList`**，故有效消费仅在阶段①。这不影响实现（实现指引已是 pending pattern）。

### 与不变式 #2 的关系（修正先前错误论证）

CLAUDE.md 不变式 #2「所有 runtime→前端消息必须带 sessionId（无 sid 丢弃）」约束的是 **session 级消息**。本功能的 RPC：
- reply 带 **msg.id**（correlation id，用于 pending 匹配），数据性质**全局**（非 session 级）
- 不在 #2 约束范围（#2 管 session 级路由，本功能 reply 走 pending map，不经 session 通道）

→ **不存在与 #2 的冲突，也不需要「global 通道」作合规例外**。先前草稿把「数据全局性」与「events.ts global 订阅通道（broadcast 专用）」混为一谈，是概念错位（架构审查 SF-1 + 红队 S1 + 禁读重建 MISMATCH-1 三路独立指出）。

> **附：events.ts 双通道真实用途 + 不变式 #2 措辞滞后（follow-up，不在本功能改，供 code-arch 参考）**：events.ts 的 session/global 通道都是 **broadcast 推送**的订阅侧（如 sendInitialState 推送的 config.providers/model.list 走 global），与 pull RPC reply（pending map）是平行机制——本功能两者都不用。另：#2 字面「**所有**消息必须带 sid，无 sid 丢弃」与 events.ts 实现（无 sid → dispatchGlobal，不丢弃）不一致，该不一致是既有的（非本功能引入），建议未来修正 #2 措辞。

## 7. 边界划分原则（三层代价台阶验证）

| 决策 | 代价 | 是否值 |
|------|------|--------|
| 新增 WorkspaceService（而非塞进 SessionService）| +1 service | **值**：session 职责不膨胀，workspace 独立可测 |
| 新增 WorkspaceMessageHandler（而非复用 session handler）| +1 handler | **值**：transport 零业务，handler 按域隔离一致 |
| 复用 WriteBackCache（而非新写持久化）| 0（复用）| **值**：write-back 意图复用（dirty + 定时 flush，应对写入时机 B 高频写） |
| pull RPC 而非 broadcast | 0（用现有 RPC 模式）| **值**：避开 broadcast 时序坑 |

### WriteBackCache 复用的形态适配（架构审查 SF-2 要求澄清）

`WriteBackCache<K,IK,IV>` 是 **per-partition KV** 设计（session-data-store 用 `K=sessionId`，每 session 一文件）。本功能是**全局单数组**（一个 `recent-workspaces.json` 存 `RecentWorkspaceRecord[]`），形态不同。适配方式（code-arch 最终选定其一）：
- **方案 a**：WriteBackCache 用固定 partition key（如 `K='global'`），IK=cwd，IV=record——契合 write-back 意图
- **方案 b**：改用更轻的 `JsonStore<T>`（同文件，单文件单值 read-through），service 层自做 debounce

红队 nit-1 倾向 b（访问模式是整体读写非按行查，JsonStore 更匹配），但 a 保持与 session-data-store 一致。最终归 code-arch。

### 写入时机 B 的 debounce 归位（架构审查 SF-3 + 红队 S3 要求澄清）

debounce 归位 **WriteBackCache**（复用其 write-back：`WorkspaceService.record` 每次 set 即时更新内存 + 标记 dirty，WriteBackCache 定时 flush 落盘），**不在 WorkspaceService 额外 debounce**（避免双层 debounce 语义混淆）。这给了 WorkspaceService 独占职责 = 写入时机触发 + trim 逻辑，与 RecentWorkspacesStore（持久化策略）职责分离。

**Seam 纪律检查**：
- session→workspace 单向依赖（session.record 触发，workspace 不回调）→ **无环，无需 seam 接口**
- runtime→pi：无新增依赖（本功能不碰 pi）→ **无新 seam**
- 仅 1 个假设 seam（WorkspaceService 被多个触发点调用）→ 不抽象成 interface，直接 class 注入

## 8. 外部依赖分类

| 依赖 | 类别 | Port 决策 |
|------|------|----------|
| filesystem（recent-workspaces.json）| In-process（本地 infra）| 复用 atomicWrite，无新 Port |
| pi session 文件扫描| True-external（pi 拥有，只读）| **本功能解除依赖**（改造动机）|
| session 服务（触发源）| In-process（同 runtime）| 直接方法调用，无 Port |

→ 无需新建 Port 接口（4 类里只有 In-process 和已复用的 infra，无 Remote-owned/True-external 需要新适配）。

## 9. 约束（grep 规则 / 不变式，给 mid-detail-plan 用）

| ID | 不变式 | 验证方式 |
|----|--------|---------|
| INV-1 | cwd 空串/undefined 拒绝写入 | grep `record(` 调用点，确认每个都过脏数据检查（或在 store 内统一守卫）|
| INV-2 | 记录数 ≤ 10 | store 内 upsert 后立即 trim 到 10 |
| INV-3 | 相同 cwd 全局唯一 | store 内按 cwd 去重（Map）|
| INV-4 | 文件损坏降级空列表不崩 | loadPartition try/catch，非法 JSON → 返回 [] |
| INV-5 | 不硬编码 `~/.xyz-agent` | 用 `getConfigDir()`，pre-commit `check_path_whitelist.py` 守护 |
| INV-6 | workspaceStore 须在默认 cwd 推断前填充 | `useNewTaskFlow.startFlow`/initApp 预填默认 cwd **之前**必须先 pull 填充 workspaceStore（不只 DirSelectPopover 打开时）；grep 确认 startFlow 调用链在 workspaceStore.list() resolve 之后 |
| INV-7 | cwd 失效（目录已被外部删除）有降级处理 | `listRecent` 不过滤失效目录（保留历史可见），但选择失效 cwd 时走 `existsSync` 检查降级（复用 `session-lifecycle.restoreSession` 的 homedir fallback 模式）；具体 UX（置灰/报错/homedir）归 code-arch |

> INV-6 扩展自初稿（架构审查 MISSING-1）：初稿只覆盖 DirSelectPopover 打开时的 pull，漏了 `useNewTaskFlow` 默认 cwd 推断这个隐式消费点的数据时序——改接 workspaceStore 后首屏默认 cwd 会拿空。
>
> INV-7 是改造引入的二阶风险（架构审查 MISSING-2 + 需求审查 should_fix-2 两路指出）：独立持久化使记录生命周期独立于 session，历史 cwd 可能在两次使用间被外部删除（worktree 清理等）。`session-lifecycle.restoreSession` 已有 `existsSync` + homedir fallback，证明 cwd 失效是系统已认知的真实场景。

## 10. 决策记录

> 所有架构决策已确认，见 `decisions.md`：
> - D-003 三层架构（D-不可逆，agent-opinionated）
> - D-004 pull-only RPC + 不做 broadcast（D-不可逆，agent-opinionated）—— **措辞已澄清**：先前草稿措辞「走 global 通道 + pull model」中「global 通道」是概念错位（架构审查 SF-1 + 红队 S1 + 禁读重建 MISMATCH-1 三路独立指出：pull RPC reply 经 pending map，不经 events.ts 订阅通道）。修正后表述见 §6
> - D-005 复用 write-back 意图（dirty + 定时 flush）+ atomicWrite（D-不可逆，agent-opinionated）—— 具体抽象（WriteBackCache 固定 partition vs JsonStore+service debounce）归 code-arch 选定，见 §7 形态适配
> - D-006 lastUsedAt 用 number（D-可逆，agent-opinionated）
>
> 业务决策（D-001 冷启动空开始 / D-002 删除派生函数）见 requirements.md §9 + decisions.md。
>
> 本功能「D-不可逆」决策均已 agent-opinionated 自决（栈已定、模式已定、与现有惯例一致）—— 这是 L2 偏简单的特征，无需二次 ask。
>
> **待 mid-detail-plan batch-ask 的 K 类决策**（本阶段标边界，不拍板）：
> - UC-2 selectWorkspace 时机（需求审查 should_fix-1 + 禁读重建 MISMATCH-2）：「选了目录但未提交消息」是否算「使用」要记录
> - INV-7 cwd 失效的具体 UX（置灰/报错/homedir fallback）—— 架构层只定「有降级处理」，UX 归 code-arch
