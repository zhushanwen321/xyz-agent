# 架构评审问题记录

**评审对象**: 提议的「6 层（按进程分两翼）」架构设计
**评审时间**: 2026-06-16
**分支**: refactor-architecture-design
**结论**: 提议作为「方向」正确，但作为「设计」还不够细。4 个核心判断经验证均准确，另有 9 个盲点/需细化点需补全。

---

## 0. 验证通过的结论（提议正确，无需改动）

| # | 提议结论 | 代码验证证据 |
|---|---------|-------------|
| V1 | 依赖方向正确，无层间穿透 | 前端不 import `runtime/`、不 import `node:` 内置模块；runtime 不 import 前端代码 |
| V2 | 前端缺 API Client 层 | 7 个 composable 直接 `import { send } from '../lib/ws-client'`（useChat/useSession/useModel/useProvider/useTree/useExtensionUI/useToolApproval）；~30 个协议字符串散落在各 composable |
| V3 | Runtime 文件平铺 | `runtime/src/` 30+ 文件，transport / services / infra 混排在同一目录 |
| V4 | 逻辑分层正确，只是目录没表达 | `interfaces.ts`（DI 接口）+ 6 个 `*-message-handler.ts`（transport）+ `services/`（业务）+ `index.ts`（手动 DI 组合根）均已存在 |

**资产清单（提议低估的已有基础）**:
- `shared/src/protocol.ts` — 完整的 `ClientMessage` / `ServerMessage` discriminated union + `ClientMessageMap`，是类型安全 API 的现成基础
- `interfaces.ts` — 7 个 service 接口（`ISessionService` / `IConfigService` / `IModelService` / `IPluginService` 等），DI 已落地
- `index.ts` — 手动 composition root（3-Phase 构造），无需引入 IoC 容器

---

## 1. 盲点清单（按严重度排序）

### 🔴 B1. 渲染进程有两条出口通道，提议只画了一条

**提议的画法**: 前端 → 后端只有一条线 `ws-client ←→ server.ts`。

**实际情况**: 渲染进程有**两条独立出口通道**：

```
渲染进程
  ├─ WebSocket (ws-client)  → runtime/sidecar   业务通信（session/config/model/plugin...）
  └─ IPC (electronAPI)       → Electron Main     系统/窗口操作（get-runtime-port, create-window,
                                                  pick-directory, open-external, open-settings-window...）
```

`ipc-handlers.ts` 注册了 8+ 个 IPC handler，全部绕过 WS。最关键的隐式契约是 **`get-runtime-port`**：渲染进程启动时**必须先通过 IPC 向 Main 要 runtime 端口**，然后才能连接 WS。这是启动时序的硬依赖，提议完全没有建模。

**提议相关表述的偏差**: "④ Electron Main 不直接调 services" 过于绝对——Main 通过 `RuntimeManager` 持有子进程的 spawn/kill/端口发现/健康检查全生命周期，这是「基础设施编排」，比 "thin shell" 重得多。

**影响**: 将来做「runtime 崩溃自动重连」「多窗口端口隔离」「runtime 热重启」时，IPC→port→WS 这条链路是核心，而当前它是隐式的、无统一管理。

**待解决**: 显式建模双通道，定义各自边界。

---

### 🔴 B2. 窗口/面板布局是跨进程分布式状态，提议未定位 "source of truth"

**提议的表述**: "① Electron 壳不放业务逻辑"。

**实际情况**: `WindowManager`（main 进程）和 `stores/panel.ts` + `stores/window.ts`（渲染进程）**各自维护一份** PaneTree / 窗口状态，靠 IPC 事件（`update-window-state` / `window-list-updated`）同步。

窗口树（PaneTree 二叉树、window ↔ session 绑定）**本身就是领域模型**，现在被劈成两半：
- Main 持有权威窗口列表（用于跨窗口查找 session 所在窗口）
- Renderer 持有详细 PaneTree 结构（用于渲染）

这是真正的**分布式一致性问题**，而提议把它归为「壳」，等于回避了。

**待解决**: 把「窗口/面板编排」单列为一个关注点，明确双 source of truth 及其同步协议。

---

### 🔴 B3. API Client 层提得太含糊，回避了核心设计决策

**提议的表述**: "新增 `api/`（WS 协议封装）"。

**遗漏的核心问题**: 当前协议是**事件驱动 + fire-and-forget**，不是请求/响应：
- `send({ type: 'session.create' })` 没有返回值
- 响应通过 `event-bus` 的 `on('session.created', ...)` 异步回来
- 每个调用方要手动 wire 监听器
- `id` 字段（用于关联请求/响应）几乎没人用

如果新增的 API Client 只是「把 `send()` 包一层类型」，价值有限（因为 `protocol.ts` 已提供类型）。

**真正的价值在于一个未做的决策**:
> API Client 要不要引入 **typed request/response**（`const session = await api.session.create()`）？还是保持事件驱动，只做类型收口？

这决定了前端一半代码的写法。

**待解决**: 明确两种方案 + 给出推荐。

---

### 🟡 R4. Runtime `infra/` 切分漏了两个「翻译层」模块

**提议的切分**: `rpc-client / process-manager / pi-config-bridge / npm-installer / extension-resolver` 归入 `infra/`。

**遗漏的模块**（既不是纯 infra 也不是纯 service）:

| 模块 | 实际职责 | 问题 |
|------|---------|------|
| `event-adapter.ts` | pi RPC 事件 → WS ServerMessage 翻译 | 它是 **pi 协议 ↔ WS 协议的防腐层**，不是基础设施 |
| `message-converter.ts` | pi 历史格式 → 前端 Message[] | 纯数据转换，但语义上是「领域翻译」 |

这两个是 **Anti-Corruption Layer（防腐层）**——全部价值是隔离 pi 的格式变更。塞进 `infra/` 会模糊「infra（管外部系统连接）」和「adapter（翻译外部格式）」的边界。

CONTEXT.md 原始设计里本就有 `pi-adapter/` 子模块的意图，提议反而退化了。

**待解决**: 在 `services` 和 `infra` 之间显式分出 `adapters/`（或 `pi-bridge/`）层。

---

### 🟡 R5. PluginService 是穿透三层的垂直切片，不能用单一层归类

**提议的表述**: 插件系统笼统归为「⑥ Services 层」+「plugins/ 独立子域」。

**实际情况**: `services/plugin-service/` 有 **27 个文件**，自身就是一个 mini 架构：

```
plugin-service/
├── api/              ← 对插件暴露的 API（6 个）     [≈ transport/contract]
├── plugin-host.ts    ← Worker Thread 宿主           [≈ infra/进程管理]
├── plugin-rpc-*.ts   ← Worker RPC（client/server）  [≈ transport]
├── plugin-sandbox.ts ← require/env 拦截             [≈ infra/安全]
├── plugin-registry   ← 发现/注册                    [≈ service]
├── plugin-permission ← 权限                         [横切]
└── hook-api / bridge-interop ← 与 pi 引擎交互        [≈ adapter]
```

它**同时**做了 transport（RPC）、infra（Worker 进程）、service（生命周期）、adapter（hook 桥接）。强行塞进某一层会失真。

**待解决**: 把 PluginService 标注为「垂直切片」——自成体系、横跨 layers，对外只通过 `IPluginService` 暴露；同时讲清楚「水平分层」和「垂直切片」两个正交维度。

---

### 🟡 R6. 提议完全没提横切关注点（cross-cutting concerns）

架构不只是目录划分。三个 CLAUDE.md 反复强调的关键不变量**没有归宿**：

| 横切不变量 | 当前散落处 | 提议的归属 |
|-----------|-----------|-----------|
| 错误必须重置 `isGenerating` + `streamingMessage`（规则 #3） | 每个 composable 自己处理 | ❌ 未提及 |
| 所有消息必须带 `sessionId`（规则 #7） | chat store / useChat / PaneSessionView 三处各自过滤 | ❌ 未提及 |
| DI 组合根与服务循环依赖 | `index.ts` 手动 new + `setServices`（3-Phase 构造绕开循环） | ❌ 未提及 |

**第 3 点尤其关键**: `index.ts` 用「Phase 1/2/3 分阶段构造」打破 `SessionService ↔ PluginService ↔ ModelService` 的循环依赖——这说明**服务间存在隐含循环依赖**，纯靠构造顺序掩盖。提议说「⑥ 通过 interfaces.ts 做 DI」但没点出这个循环，重构时极易踩坑。

> ⚠️ **订正（tracing-round-1）**：本条 R6 第 3 点的「循环依赖」诊断经代码核对**不成立**——Session↔Plugin↔Model 无编译期循环，setter 是正常 DI，hook 是 IoC 回调注入。本评审记录保留原文以存评审历史；design.md 的 D6c 已据核对结果重写（事件总线降为可选演进，见 `architecture-design.md` D6c）。

**待解决**（⚠️ 第 3 点「循环依赖」诊断已订正，见上方 tracing-round-1 标注；其余两点仍有效）: 增加「横切关注点」章节，把错误流、session 路由、DI 装配列为一等公民，并指出服务循环依赖需用事件/消息解耦而非构造顺序。

---

### 🟢 N7. 命名债是真实的架构信号，应纳入重构

- `SidecarServer`（server.ts）还叫 "sidecar"，但目录已是 `runtime/`，CONTEXT.md 也标注「待重命名」
- `server.ts` 注释写 "pure Transport layer"，但它通过 `setServices()` 持有 6 个 Service 引用 + 6 个 Handler 实例——注释与实现不符
- 提议的 `transport/` 重命名正确，但应明确这是「消除认知债务」的一部分，而非单纯「挪目录」

> 详见 `docs/refactor/terminology-alignment-plan.md`（已存在的 R1-R5 命名对齐计划）。

---

### 🟢 N8. Mock 边界位置未定义

`VITE_MOCK` 当前插在 `ws-client.ts`（传输层）。若新增 API Client 层：
- mock 应**改插在 API Client 层**——这样能 mock 出「业务语义」（如 `api.session.create()` 返回假数据）而非「协议字节」
- 提议没说 mock 边界，但直接影响 API Client 的设计形态

**待解决**: 在 API Client 设计中明确 mock 注入点。

---

### 🟢 N9. `shared` 协议基础被低估，应直接复用

`protocol.ts` 已是完整的 discriminated union（`ClientMessage` / `ServerMessage` / `ClientMessageMap`）。前端缺的不是「类型」，而是「把类型用起来的调用约定」。

**待解决**: 新增 API Client 时直接复用此 union 做类型安全 wrapper，不重新定义协议。

---

## 2. 待解决清单（驱动后续设计）

| 编号 | 问题 | 性质 | 产出 |
|------|------|------|------|
| D1 | 双出口通道（WS+IPC）建模 | 🔴 结构性遗漏 | 双通道边界图 + 启动时序契约 |
| D2 | 跨进程窗口/面板状态协调 | 🔴 结构性遗漏 | 双 source of truth + 同步协议 |
| D3 | API Client 请求/响应 vs 事件驱动 | 🔴 回避的决策 | 方案对比 + 推荐 + 落地形态 |
| D4 | Runtime 内部 infra/adapters/services 分层 | 🟡 细化 | 防腐层独立 + 目录结构 |
| D5 | PluginService 垂直切片定位 | 🟡 细化 | 水平层 × 垂直切片双维度模型 |
| D6 | 横切关注点归宿 | 🟡 细化 | 错误流 / session 路由 / DI 循环解耦 |
| D7 | 命名债（sidecar→runtime 等） | 🟢 已有计划 | 引用 terminology-alignment-plan |
| D8 | Mock 边界 | 🟢 收尾 | API Client 注入点 |
| D9 | 协议复用 | 🟢 收尾 | 直接复用 protocol.ts union |

以上 9 点逐项解决后，汇总为完整架构设计文档（`docs/refactor/architecture-design.md`）。
