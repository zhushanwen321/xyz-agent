# T&C 收口：transport 中间件归位 core + bootstrap 真编排（组 1 设计）

> **一句话结论**：把滞留 renderer 壳的 api 中间件（events / pending / request / domains / mock，约 5.3k 行）原样下沉 `core/transport`，删除死代码连接入口与 TransportPorts 反向注入接口，让 `bootstrap()` 从零调用的占位变成被 renderer 壳真实调用的五步编排——入站消息从「跨界两次」变「单跨界」，mobile 壳获得可复用的 RPC 层。

<!-- 层声明：本次设计 = 组 1 波次的技术方案层；下一层产物 = 文件级迁移任务序列（§10）。
     运行时行为/数据流/错误处理均涉及 → 准则 5/6/7 全适用。-->

## 开篇（SCQA）

- **S（情境）**：xyz-agent renderer 已完成四包拓扑重构过半——`core`（平台无关内核）持有 ws-client 与 use-connection，七个业务域已迁入；`renderer` 壳持有 api 层（RPC 请求与事件分发）。
- **C（冲突）**：transport 的 seam 切了一半：管道（ws-client）与生命周期（use-connection）在 core，中间件（events/pending/request/domains）整组滞留壳层。一条入站消息 core→壳→core 跨界两次；`bootstrap()` 编排入口生产零调用，真实启动时序散落壳层两处，死锁防线只活在注释里。
- **Q（问题）**：如何把 T&C（Transport & Coordination）层收口成一个 core 内的 deep module，让壳只剩平台装配？
- **A（答案）**：中间件原样迁移 + TransportPorts 接口删除（内化为 core 内部 import）+ 死代码 connect() 删除 + bootstrap 五步真编排 + ~98 处 import 直接改写（用户已拍板，不走 shim）。

---

## 1. 背景：被设计的系统是什么

**本章结论**：本设计聚焦 renderer 四包拓扑中的 T&C 切片，读者需先建立「一条消息怎么进出壳」的认知。

xyz-agent 是 Electron + Vue3 桌面 AI Agent 工作台。渲染进程（renderer 壳）经 WebSocket 与 Agent Runtime（Node.js 后端）通信：出站发 RPC 请求（如 `chat.send`），入站收 server-push 事件（如 `message.chunk` 流式块）。这条通信链路的服务端（runtime）不动；本设计只动**渲染侧**的组织结构。

渲染侧现状分两包：

- `packages/core`：平台无关内核。持有 `transport/ws-client.ts`（377 行，WS 连接状态机 + 心跳 + 重连退避）、`transport/use-connection.ts`（414 行，端口发现 + 重连生命周期）、`coordination/route-inbound.ts`（419 行，入站消息路由）。
- `packages/renderer`（桌面壳）：持有 `src/api/`（约 5.4k 行，RPC 与事件分发的中间件层）+ 平台装配（`lib/ipc.ts`、`platform/desktop-platform.ts`）。

**使用者**有三类：① renderer 壳的开发者（经 `@/api` 调 RPC、订阅事件）；② mobile 壳的开发者（未来消费同一 RPC 层）；③ 最终用户（聊天、设置、插件等所有功能都走这条链路）。

## 2. 设计目标

**本章结论**：五个目标，覆盖 seam 收口、连接语义单一、启动时序结构化。

1. **G1 seam 收口**：入站/出站消息在 core 内完成路由与 RPC 结算，壳只做平台装配——「transport 真源在 core」从注释承诺变物理 import。
2. **G2 连接语义单一**：全进程一条连接入口（use-connection 生命周期），删除与它平行的第二条端口发现路径。
3. **G3 extension-host 流量并入**：插件桥的出站消息经 core transport 发送，不再锚壳层 transport 模块。
4. **G4 mock 单一真源**：mock 基建（2,934 行）与真实实现同迁 core，mock/real 分叉收敛为构建期常量分叉（壳 facade 三元 + search 轨条件引用，见 D4）。
5. **G5 bootstrap 真编排**：`bootstrap()` 被 renderer 生产代码调用，五步顺序（platform → 连接编排 → 会话注入 → 挂载点 → 贡献扫描）成为结构化事实，死锁防线（platform 先于连接编排）从注释变代码顺序；mobile 壳未来一行启动。注意：`initConnection` 的 resolve 语义是「连接编排已提交」而非「已连接」（推导见 D2），connected 仍由连接状态机驱动、视图初始化仍由壳 connected 驱动（现状语义保持）。

**In-scope**：`api/{pending,events,request,transport}.ts`、`api/domains/`（17 文件）、`api/mock/`、`src/mock/mock-ws.ts` 的迁移与改造；**facade 之外的 mock 直连消费点**（`useSearch.ts` / `useSearchModalDeps.ts` 的 search 轨，见 D4）；`lib/ws-client.ts` shim 的归宿处理（随 M3 消亡，见 §7）；TransportPorts / ConnectionPorts 接口收窄（含 `subscription-state.ts` 的类型派生与 core 测试注入适配，见 D3）；`bootstrap.ts` 真编排与 renderer 调用点改造；受影响 import 改写（生产子路径 ~46 处 + 测试子路径 62 处 / 50 文件）。

**Out-of-scope**（显式声明，防 scope creep）：

- mobile 壳对接 core bootstrap（组 3；mobile 自身 TODO 注释亦标注 P1+D2 条件）
- i18n 下沉（组 3）；route-inbound 三结构合一（ROUTE_TABLE/CROSS_SESSION_TYPES/FALLBACK，独立小步）；transport 模块级状态的 taste 治理收编（组 2）；测试语义分流「锚 core / 随壳消亡」（组 2——本波只改测试的 import 路径，不改断言语义）
- `@/api` barrel facade（45 处 `from '@/api'`）的迁移——facade 是壳的 env 装配，留在壳（见 D4）

## 3. 现状：使用者眼里是什么样的

**本章结论**：一条消息要穿越 core↔壳边界两次才能落进 store；连接入口有两个；启动编排入口零调用。

### 3.1 现状的真实样子

**入站一条流式消息的物理路径**（`message.chunk`，取自真实代码结构）：

```
runtime WS
  → core/transport/ws-client.ts          (receive, 377L)
  → core/coordination/route-inbound.ts   (ROUTE_TABLE 查表, 419L)
      TransportPorts.pending.events ──┐
      （接口在 core 定义，实现是壳的）  │ 【跨界①】
  → renderer/src/api/events.ts          (dispatchSession, 133L)
  → renderer 订阅回调 useMessageEffects (壳)
  → core/domain/chat store              (mutation 落账)

  （若 msg.id 命中 RPC reply）
  → renderer/src/api/pending.ts         (resolveEnvelope, 212L)  【跨界②】
```

支撑这条链的是「端口注入」接口——core 定义、壳实现、装配点在壳的 `composables/useConnection.ts`（83 行）：

```ts
// renderer/src/composables/useConnection.ts（真实代码，节选）
const connectionPorts: ConnectionPorts = {
  ipc: { getRuntimePort, getRuntimePort, ... },     // ← 壳合理（Electron IPC）
  visibility: { isVisible: () => document... },      // ← 壳合理（DOM）
  env: { isMock: import.meta.env.VITE_MOCK === 'true' },
  pending,                                           // ← 壳实现，本设计要内化的
  events,                                            // ← 同上
  subscribe: sessionApi.subscribe,                   // ← 同上（api/domains/session）
  effects: createInboundEffects(),
  ...
}
setConnectionPorts(connectionPorts)
```

route-inbound 侧的对应接口（`coordination/route-inbound.ts:49-81`）：`TransportPorts { pending, events, subscribe }`——三个字段全部指向壳的 api 模块。

**出站一条 chat.send 的物理路径**：

```
core/domain/chat useChat → ChatApiPort（接口）
  → renderer/src/api/domains/chat.ts    【跨界】
  → renderer/src/api/request.ts         (command<K>() 类型化 RPC, 62L)
  → renderer/src/api/transport.ts       (send)
  → core/transport/ws-client.ts         (send)      【跨界回 core】
  → runtime
```

**第二条端口发现路径**（`api/transport.ts:25-40`，真实代码语义）：`connect()` 自含「IPC 并行拉 port/token + 10s 超时」的发现逻辑，与 use-connection 的 fallback 链（env.isMock → ipc.getRuntimePort → BASE_PORT+offset）平行。**生产代码零调用方**（grep 实证：仅注释自述「确保就绪」）；插件桥只消费它的 `send`（`useExtensionHostBridge.ts:193/:278`、`extension-host-dialog.ts:151`）。

**bootstrap 现状**（`core/src/bootstrap.ts`，96 行）：五步编排 `providePlatform → initConnection → restoreSessions → registerMountPoints → scanContributions`，其中 `initConnection` / `restoreSessions` 是 `console.log` 占位；**生产零调用**——真实启动在两处：`main.ts`（platform 注入 + 桥初始化 + 挂载）与 `App.vue`（:70 `useConnection()` 解构，:96 onMounted 内 `init()`）。2026-08-04 死锁事故后，「platform 注入必须先于 connect」的时序约束以 `[HISTORICAL]` 注释形式活在 `main.ts:17-28`。

### 3.2 怎么出错

- **失败模式 A（出口分裂）**：同一进程两个 transport 出口——`api/transport.ts` 的 `send/on`（被插件桥与 request 锚定）与 core ws-client 的直接导出并存，外加死代码 `connect()` 自带的第二条端口发现。未来改发送语义（如加序号、优先级）需要同时改两处，漏一处即产生只影响 plugin 流量的隐蔽分叉。（注：auth 前丢消息在现状已有结构防御——`useExtensionHostBridge.ts` 的 `watch(state==='connected')` 才发送，而 ws-client 在 auth 握手成功后才置 connected；本模式的痛点是双出口的维护分裂，不是现行丢包。）
- **失败模式 B（死代码误导）**：新开发者读到 `api/transport.ts` 的 `connect()`（含端口发现 + 10s 超时），误以为这是连接入口，在它里面加逻辑——实际它是死代码，与 use-connection 的真分支形成隐蔽双轨。
- **失败模式 C（时序回归）**：新增壳代码在 `providePlatform` 之前触发任何 core platform 调用 → `getPlatform()` fail-fast 抛错 → 界面永远「连接中」。防线是注释与运气，不是结构。

### 3.3 根因

架构文档 §5.1 规划「api 层原样继承进 core/transport」，但 W1/W2 波次只迁了 ws-client 与 use-connection（当时的事件顺序），中间件滞留壳层并被「端口注入」接口合法化——**seam 切在了最深的线（ws-client）上，而中间件层本应与它同批归位**。TransportPorts 这个「core 定义、壳实现」的接口把中间件滞留固化成了正式契约；bootstrap 则因为 `restoreSessions` 依赖的 core SessionService 尚不存在（bootstrap.ts:35 TODO 自述），整条编排停在占位。

## 4. 根因 + 物理数据流

**本章结论**：症状的共同根因是「planned-but-never-executed 的收尾动作」——接口把半途状态合法化。

> **端口注入（port injection）** = core 定义接口、壳提供实现、装配点注入的依赖倒置模式。适用于**真随壳变化**的依赖（ipc / visibility / env / toast）；被滥用于**不随壳变化**的中间件（pending / events / subscribe）时，它就成了滞留的合法化外衣。

**Before（现状物理数据流，入站 + 出站）**：

```
┌─ renderer 壳 ─────────────────────────────────────────────┐
│  useChat ──→ api/domains/chat ──→ api/request ──→ api/transport.send ─┐
│                            ▲                                         │
│  useMessageEffects ←── api/events ←────┐                             │
│                            │           │                             │
│  (装配) ConnectionPorts{pending,events,subscribe} ─────────────┐      │
└──────────────────────────────│─────────│─────────│──────────────┼──────┘
                               │注入      │注入      │注入          ▼
┌─ core ───────────────────────▼─────────▼─────────▼──────────────▼─────┐
│  route-inbound ──TransportPorts──→ (回到壳)     use-connection ──→ ws-client ──→ runtime WS │
└────────────────────────────────────────────────────────────────────────┘
```

**After（终态物理数据流）**：

```
┌─ renderer 壳 ─────────────────────────────────────────────┐
│  useChat → @xyz-agent/core (api/domains/chat)             │
│  facade: VITE_MOCK ? core-mock : core-real    （壳仅剩装配）│
│  ConnectionPorts{ipc, visibility, env, toast, effects}    │
└───────────────────────┬───────────────────────────────────┘
                        │ 平台端口注入（真随壳变化的部分）
┌─ core ────────────────▼───────────────────────────────────┐
│  domains → request → ws-client.send → runtime WS          │
│  ws-client → route-inbound → events/pending → domain store│
│  use-connection（唯一连接生命周期 + 唯一端口发现）          │
│  mock/（与 real 同接口的第二 adapter）                     │
└───────────────────────────────────────────────────────────┘
```

## 5. 终态：使用者眼里将是什么样的

**本章结论**：壳开发者 import 全部指向 core；连接只有一条入口；启动只有一处编排。

### 5.1 成功路径

**场景：renderer 壳开发者新增一个 RPC 调用（如 `usage.getStats`）**

```ts
// 迁移前：跨三个文件、两个包
import { usage } from '@/api'                    // 壳 facade
// 实现在 renderer/src/api/domains/usage.ts → request.ts → transport.ts

// 迁移后：一个 import，core 真源
import { usage } from '@xyz-agent/core'          // core/transport/api/domains/usage
// request/pending/events 同在 core，出站单跨界
```

**场景：最终用户启动 app 发消息**

启动：`main.ts`（platform 注入 + 桥初始化 + 挂载）→ `App.vue onMounted → bootstrap({ platform })` → 五步依次 await（`initConnection` resolve = 连接编排已提交，**不等待 connected**——与现状 `init()` fire-and-forget 语义一致，App.vue:72 注释自述）→ connected 事件由壳 `watch(connectionState)` 驱动视图初始化（App.vue:98-105 现状语义保持）→ 用户输入 → `chat.send` 出站（core 内一条链）→ 流式块入站（core 内一条链）→ 消息逐字渲染。中途任何一步 reject，后续步骤不执行、错误上抛壳层降级 UI（ES1 语义保持）。连接编排提交后、connected 前的 RPC 调用走 fast-fail（send false → 立即 reject）——与现状 `request.ts` 语义等价，无回归。

### 5.2 失败路径（带恢复指引）

- **runtime 不可达**（connect 失败 / 超时）：use-connection 既有退避重连不变；重试用尽 → `onRuntimeUnavailable` → 壳 toast + 重试按钮。👉 恢复：启动 Agent Runtime 后点重试，或 `retryRuntime()`（IPC 拉起）。
- **断连时 pending 积压**：ws-client onclose → `pending.rejectAll` → 各 RPC 调用方 catch → 错误以 SystemNotification 形态进对话流（现有语义，随迁移保持）。👉 恢复：重连后重发；订阅类状态由 seq reconcile 自动补齐。
- **bootstrap 步骤失败**：如 `initConnection` reject → 后续 restoreSessions/挂载点扫描不执行，错误上抛。👉 恢复：App.vue catch 后渲染降级 UI（连接错误页），提供重试入口；禁止静默吞错后继续挂载。

## 6. 关键决策与权衡

**本章结论**：五个决策共同把现状变终态；两个真分叉已由用户/代码库信号拍板。

### 6.1 D1：api 中间件归位方式 —— 迁移 + 直接改写 import（用户已拍板）

- **采用**：pending/events/request/domains 原样迁 `core/transport/api/`；消费者子路径 import（生产 ~46 处 + 测试 62 处/50 文件）机械改写为 `@xyz-agent/core`（或新增子路径 export）；barrel facade `from '@/api'`（45 处）不动。
- **被否**：B 全 shim 过渡（`@/api/*` 各文件变 re-export 壳）——22 个文件骨架要保留到 P6 清尾，债务面比 lib/ws-client 单模块 shim 先例大一个量级；C 维持现状（TransportPorts 收口为正式接口）——把半途状态合法化，mobile 无法复用。
- **证据**：import 面 grep 实测（91 处生产：45 barrel + 46 子路径；62 处测试/50 文件）；`import.meta` 仅存在于 3 个文件（两个 facade + transport.ts），pending/events/request/domains 全部 headless 兼容，迁移无改造点；core `package.json` 已有 exports 子路径机制（`./bootstrap` 先例）。
- **效果**：G1 成立；core 真源从物理 import 成立；笔误风险由 typecheck + lint + 存量测试（62 处 import / 50 文件）守卫。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A 迁移+直接改写 | 高：真源物理成立，无 shim 债务 | 中：生产 ~46 + 测试 62 处（50 文件）机械 codemod + 全量回归 | 低：typecheck/test 守卫笔误 | ✅ |
| B 全 shim 过渡 | 中：P6 债务 +1 组 | 低：消费方零 churn | 中：shim 骨架 22 文件长期共存 | ❌ |
| C 现状+接口收口 | 低：滞留合法化 | 最低 | 高：mobile 无法复用 RPC | ❌ |

**被否若用（B）**：§5.1 的例子变成 `import { usage } from '@/api'`（不变）——但 core 内部 import 壳的 TransportPorts 契约永续存在，mobile 壳必须复制一份壳 api 才能用 RPC。

### 6.2 D2：bootstrap 真编排与 await 语义（vs 删除）

- **采用**：`bootstrap()` 成为生产编排入口。关键语义推导——`useConnection().init()` 是 fire-and-forget（`connectWs(url)` 不同步等握手，App.vue:72 注释自述），await 链无法也不应承诺「五步后 connected」。三选一裁决：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| ① initConnection 等 connected 才 resolve | 低：把连接状态机塞进启动链，需自定义超时/失败语义，与 onRuntimeUnavailable 职责重叠 | 高：改 init 契约 + App.vue 现有 watch 双轨 | 高：超时值成为新魔数 | ❌ |
| ② initConnection resolve = 编排已提交；restoreSessions = core 内 no-op 占位步骤 | 高：对齐 SSOT §11.0.3 编排位置（连接编排后、connected 前的会话准备位），connected 驱动的视图初始化留在壳（单一职责）；真实语义依赖 remote 波次三件套，本波不伪造既有语义 | 低：保持现状占位形态，零契约债务 | 低 | ✅ |
| ③ bootstrap 拆连接前/后两段 | 中：两段各自编排，但「一行启动」卖点受损，mobile 要调两次 | 中 | 中：两段间的时序又回到约定 | ❌ |

  据此：`initConnection` 真实现 = `useConnection().init()`（resolve 即编排提交）；`restoreSessions` = **core 内部 no-op 占位步骤**（R3 减法修正：不引入壳注入钩子——三件套落地后的真实实现归 core coordination（SSOT §5.2 `coordination/subscribed-sessions.ts`），壳无物可注、壳注入形态是超前契约；保持现状 console.log 占位形态，`BootstrapOptions` 不加 hooks 参数，无「未注入 warn vs 注入空函数」二义（A5「全程无 warn」因此可满足）。诚实边界：subscribed sessions 现状是 subscription-state 内存态模块级 Map、进程重启即失、无持久化可读；ws-client auth 握手 payload 仅含 token（ws-client.ts:209）、无 sessions 扩展点——「active/subscribed sessions 注入重连 auth」是 remote-use 的规划能力（SSOT §5.2 subscribed-sessions 模块未实现），等 core SessionService + 订阅持久化 + ws-client auth 扩展三件套落地（remote/mobile 波次）后在 core 内填充，本波不伪造既有语义）；**connected 驱动的视图初始化保持壳侧现状**（App.vue:98-105 `watch(connectionState, connected → onConnected → initApp)`，含 hasConnectedBefore/appBootstrapped 双守卫——现状已定位，不留白）。`BootstrapOptions` **删除 `connectionMode` 参数**（`init()` 实际只消费 `env.isMock`，双开关源删一；remote 模式等 mobile D2 落地时再扩展）。platform 注入收敛（R2 修正）：现状分叉实为两处——`main.ts` 与 `useSettingsShell.ts:65-70 bootstrapSettingsCore()` 自带的第二注入点（real 分支 `provideDesktopPlatform()` / mock 分支 `createMockPlatform()`）；收敛决策 = 壳装配函数 `resolvePlatform()`（分叉逻辑留 main.ts，模块级 memoized）落地时**删除 bootstrapSettingsCore 内的注入**（M5 交付物），分叉真收敛到一处。main.ts 早期注入保留的真实理由：保障 App.vue setup 期 settings init（settings-lifecycle.ts:88 `getSystem(getPlatform().storage)`，先于 onMounted 连接）与 HMR 场景的 platform 可用性（非「bootstrapSettingsCore 会 fail-fast」——R3 核实桥初始化 initExtensionHostBridge 无 platform 触点，setup 期 platform 消费点仅 settings-lifecycle 一处）；bootstrap 五步之首 providePlatform 幂等复注（纯赋值，无害）。
- **被否**：删除 bootstrap——mobile bootstrap.ts:20 的 `TODO(P1)` 明确等它对接；架构文档 §11.0.3 的五步时序链是既定设计。
- **证据**：bootstrap.ts:1-11 自述「P1+ 真实实现迁入后 bootstrap.ts 编排不动」；bootstrap.ts:28 TODO（core 无 SessionService）；mobile-renderer/src/bootstrap.ts:20-23；死锁事故注释 main.ts:17-28；App.vue:72/:96-105（init 语义 + connected 驱动现状）。
- **效果**：G5 成立（修正后口径：顺序结构化 + 死锁防线结构化，非「五步后 connected」）；providePlatform 先于连接编排由 await 链代码顺序保证。

### 6.3 D3：TransportPorts 降级为 core 内部测试 seam、ConnectionPorts 收窄

- **采用**：pending/events 迁入 core 后，route-inbound 与 use-connection 的**生产路径**直接 import（模块内单例）；`configureRouteInbound(ports?)` 参数改为可选（缺省 = 真实模块），保留为 **core 内部测试注入口**（内部 seam：仅测试可见，不出现在壳装配面——对齐「模块可有 internal seams」原则）；`ConnectionPorts` 删去 `pending/events/subscribe` 三字段，剩 `ipc / visibility / env / toast / t / effects / onRuntimeUnavailable`——全部是**真随壳变化**的端口。
- **连带改造**（全部枚举）：① `subscription-state.ts:94/:109` 的 `Pick<TransportPorts,'subscribe'>` 类型派生改为直接引用 core domains/session 的 subscribe 签名类型；② 4 个 core 测试文件（route-inbound.test / subscription-state.test / subscription-replay.test / ws-client.invariants.test）的注入方式适配（可选参数化后无需改断言，改构造方式）。
- **被否**：彻底删除 configureRouteInbound 参数化——core 测试失去 fake 注入点，只能 mock 模块 internals（脆弱）；保留 TransportPorts 作为壳装配接口——一个 adapter 是假想 seam（mock/real 分叉在 facade 层，不在 events/pending 层）。
- **证据**：route-inbound.ts:49-81 接口定义；use-connection.ts:50-105 注入与 requirePorts；subscription-state.ts:94/:109 类型派生；grep 全量无其他生产消费方（审查 R1 实证）。
- **效果**：G1/G2 成立；对外接口面净缩（壳装配不再需要 transport 三件套）；core 测试 seam 保留。

### 6.4 D4：facade 与 mock 的归位——facade 留壳、mock 逻辑迁 core、search 轨条件化

- **采用**：`api/index.ts`（VITE_MOCK 三元门面）留壳作装配层；`api/mock/` 全部数据与逻辑迁 `core/transport/mock/`，其中 `import.meta.env.VITE_E2E`（mock/index.ts:100）改为工厂参数由壳注入；`src/mock/mock-ws.ts` 并入 core mock。**search 轨专项**（R1 审查发现的 facade 外直连点）：`useSearch.ts:39` 与 `useSearchModalDeps.ts:28` 生产直连 `@/api/mock`，其中 `useSearchModalDeps.ts:57` `searchMock: mockApi.search.query` 是无条件属性引用——tree-shake 无法 DCE，mock fixture 大概率进生产包。三选一裁决：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| ① 统一 facade 补 search 分叉 | 低：search 无 real WS domain（D-026），facade 三元两分支同源无意义 | 中 | — | ❌ |
| ② 构建期常量静态分支引用 core mock | 高：mock 只在 VITE_MOCK 构建分支存在，生产包干净 | 中：两处消费点改造 + SearchPorts 契约改可选 + bundle 探针验证 | 中：Rollup 对跨包静态分支的 DCE 需实证（探针门 + fallback） | ✅ |
| ③ 接受进包 + 体积预算 | 低：与 G4 单一真源目标矛盾 | 最低 | 高：体积负债永久化 | ❌ |

  方案 ② 具体形态：两处消费点改为**顶层静态 import core mock 子路径 + 引用点整体条件化**——ESM 块内静态 import 非法，正确形态是顶层 import + deps 装配仅在 `VITE_MOCK === 'true'` 构建期常量分支构造 searchMock 端口（全部引用点条件化）+ core `package.json` 新增 `sideEffects: false` 声明（现状缺失，列入 M2 交付物）+ mock 模块链零顶层副作用，Rollup 摇除未引用导出。**契约前置决策（R3 实证冲突）**：core `SearchPorts.searchMock` 现为必填（search-ports.ts:106），real 模式省字段不可编译——裁决 a：`searchMock` 改可选 + `search.ts:123` isMock 分支内加守卫（守卫失败显式抛错；被否方案 b「real 分支装配 stub」会掩盖装配错误——误调用静默返空）；列入 M2/u3 交付物；**探针门**：M2 附 bundle 分析验证 search-data 等 fixture 不在生产包（⛔，见 §11-1）；fallback（探针失败）：死分支内动态 `import()`（Rollup 可移除死分支内动态导入）。
- **被否**：facade 也迁 core——VITE_MOCK 是 Vite 构建期 env，属壳装配关切；为它引入 env 端口换运行时开关是过度工程。
- **证据**：api/index.ts:26-40 三元结构与「search 无 real domain」注释；useSearch.ts:39 / useSearchModalDeps.ts:28/:57；mock/index.ts:98-100 VITE_E2E 用法；mock-ws.ts:3 注释。
- **效果**：G4 成立（含 search 轨，分叉点全部收敛在构建期常量）；mock/real 同居 core；壳只剩 ~40 行 facade。

### 6.5 D5：死代码 connect() 删除 + bridge 改锚

- **采用**：删除 `api/transport.ts` 的 `connect()`（生产零调用）；`send/on` 委托 core ws-client 同名导出；插件桥 3 处 `transport.send` 改 import core。**对上游 SSOT 的修订声明**：renderer-rebuild-architecture.md §10.1 规划 `api/transport.ts → transport/ 原样迁移`，本设计修订为「死代码 connect() 删除 + 文件终态删除（send/on 由 core ws-client 直接提供）」——修订理由是 R1 审查实证 connect() 生产零调用且自带第二条端口发现路径（失败模式 B 根因），「原样迁移」会迁移死代码。（extension-host 出站并入后，`watch(connected)` 防御保持——探针②降级为回归确认，因现状防御已存在。）
- **被否**：保留 connect 供「确保就绪」——use-connection 已是该语义的唯一所有者，双入口是失败模式 B 的根因。
- **证据**：§3.1 grep 实证零调用；bridge 三处 send 调用点行号。
- **效果**：G2/G3 成立。

**运行时断言与探针**（准则 7）：

- ✅ 已测（既有测试随迁）：ws-client 状态机/重连退避；pending 超时/rejectAll；route-inbound ROUTE_TABLE 分发——迁移后测试 import 改写、断言不动。
- ⛔ 实施期门（新增探针）：① 启动时序断言——bootstrap 步骤日志含顺序编号，实施期用 `pnpm dev` 实跑核对 providePlatform 先于连接编排、各步 await 顺序执行（探针失败则 G5 不成立）；② extension-host 出站回归确认——连接后观察 `plugin.mountPoints.sync` 在 auth 握手完成后发出（现状已有 watch(connected) 防御，本探针为迁移后回归确认）；③ 生产包 mock 排除——bundle 分析验证 search-data 等 mock fixture 不在生产包（随 M2 门，fallback 动态 import）。

## 7. 实现机制

**本章结论**：core 新增 `transport/api/` 与 `transport/mock/` 两个子目录；壳装配层瘦身；无新依赖引入。

**core 目标结构**：

```
packages/core/src/transport/
  ws-client.ts            （不动）
  use-connection.ts       （收窄 ConnectionPorts；pending/events/subscribe 改内部 import）
  api/                    ★ 新增：自 renderer/src/api 原样迁入
    pending.ts (212)  events.ts (133)  request.ts (62)
    domains/ (17 文件, 1,891)
  mock/                   ★ 新增：自 renderer/src/api/mock 迁入 + mock-ws 并入
coordination/route-inbound.ts  （TransportPorts 降级内部 seam：生产直连 transport/api，
                                 configureRouteInbound(ports?) 可选参数保留测试注入）
bootstrap.ts             （initConnection 真实现 + restoreSessions 保持 core 内 no-op 占位）
```

**壳目标结构**：

```
packages/renderer/src/api/index.ts        （留壳 facade：VITE_MOCK 三元 → core real/mock）
packages/renderer/src/api/               （其余文件删除，含 transport.ts）
packages/renderer/src/lib/ws-client.ts   （deprecated shim 随 M3 消亡：api/transport.ts 随 M3 删、
                                            api/mock/index.ts 迁 core 时改锚、
                                            useExtensionHostBridge.ts:51 getState 改锚 core、
                                            3 个测试改路径）
composables/features/search/useSearch.ts + useSearchModalDeps.ts（search 轨条件化，D4-②）
composables/useConnection.ts             （装配瘦身：去 pending/events/subscribe 字段）
composables/shell/useExtensionHostBridge.ts + extension-host-dialog.ts （transport.send → core；桥侧删
                                             :260-261 两行 void registerMountPoints()/scanContributions()（:259 注释随删，
                                             :258 setExtensionRegistries 注入保留）——注册收敛 bootstrap 第 4/5 步唯一触发点，M5 交付物）
App.vue                                   （onMounted → bootstrap(...)，connected 驱动初始化保持）
main.ts                                   （platform 装配分叉 resolvePlatform() + 早期注入保留）
composables/shell/useSettingsShell.ts      （bootstrapSettingsCore 内 platform 兜底注入删除——
                                             分叉真收敛 main.ts 一处，M5 交付物）
```

**core `package.json` exports 增量**：`.` barrel 已含 transport 导出（index.ts:9-10 模式延续）；如需子路径（`@xyz-agent/core/transport/api`）按 `./bootstrap` 先例追加。**mock 的 exports 策略**：mock 代码进 core 但仅在构建期常量分支（facade 三元 + search 轨 D4-②）被引用；生产包排除由 A7 bundle 探针门实证（fallback 动态 import，见 D4/§11-1）。

**改造关键点**（对齐「接管既有流程需枚举被绕过段」）：

| 被接管段 | 现实现 | 接管方 | 复刻/放弃 |
|---|---|---|---|
| 入站分发 | 壳 events 三通道（session/global/crossSession） | core transport/api/events | 原样复刻（crossSession 通道语义 ADR-0060 保持） |
| RPC 结算 | 壳 pending（含 resolveEnvelope envelope 展开） | core transport/api/pending | 原样复刻（ES1/R2 语义不动） |
| 端口发现 | 壳 transport.connect（死代码） | —— | 放弃（删除） |
| 连接生命周期 | core use-connection（不动） | 不变 | —— |
| mock 分叉 | 壳 facade 三元（留壳）+ search 轨直连（条件化） | facade 选项改 core 模块；search 轨 D4-② | 复刻分叉点语义 |
| route-inbound 注入 | TransportPorts 壳装配注入 | configureRouteInbound 可选参数（缺省真实模块） | 生产直连 + 测试 seam 保留（D3） |

## 8. 验收（真实场景，非单测非 mock）

**本章结论**：六个真实场景，全部回溯 §2 目标。

### 8.1 改动规模

大改动（~5.3k 行迁移 + 生产 ~46 处/测试 62 处 import 改写 + 接口删除 + 启动链改造）——按下方多场景验收。

### 8.2 验收场景

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| A1 | 真实对话流 | G1 | `pnpm dev` 连本地 runtime，在真实 session 输入「列出当前目录文件」 | 流式回复逐字渲染；bash 工具块、结果块完整；重开 session 历史一致（live ≡ reload） |
| A2 | mock 模式 | G4 | `VITE_MOCK=true pnpm dev`，发送消息触发 mock 流式分支（run-send-stream） | mock 流式/取消/E2E 分支行为与迁移前一致 |
| A3 | 断连恢复 | G1/G2 | 对话中 kill Agent Runtime 进程 → supervisor 自动重启 | 重连 + 订阅恢复；断连窗口内 pending 全部 reject 并以错误形态进对话流；恢复后新消息正常 |
| A4 | 插件挂载点上报 | G3 | A1 场景连接成功后查 runtime 日志 | `plugin.mountPoints.sync` 在 auth 握手完成后发出且恰一次；插件 view（ViewHost）正常渲染 |
| A5 | 启动编排 | G5 | dev 启动看 bootstrap 步骤日志顺序；临时实验：先删 bootstrapSettingsCore 兜底注入（M5 交付物），再把 main.ts 的 providePlatform 挪到 mount() 之后 | 正常态：五步按序执行、到 connected 全程无 warn；违反态：setup 期 settings init（settings-lifecycle.ts:88）触发 getPlatform fail-fast——console 含 platform 未注入 unhandled rejection + settings system 偏好未加载（initialized 守卫已消耗，本进程不可重试）+ 连接仍成功。实验证明 main.ts 早期注入是 setup 期消费点的唯一防线（「App.vue catch → 降级 UI」属 §5.2 bootstrap 自身 reject 路径，不在本实验覆盖） |
| A6 | 回归门 | 全部 | `pnpm typecheck && pnpm lint && pnpm test`（renderer + core 全量，本波 import 面大必须全量） | 全绿；renderer 测试断言语义不变（vi.mock 拦截目标重写除外，见 §11-2）；core 路由类测试仅构造方式适配、断言不动 |
| A7 | mock 不进生产包 | G4 | `pnpm build` 后分析产物：grep search-data / mock fixture 标识串 | 生产 bundle 零 mock fixture 命中（探针门③，失败则 fallback 动态 import 并复测） |

> 每个场景用真实 app 操作与真实 runtime/mock 进程，不用单测断言替代；A1/A3 为最高优先级（聊天主链路 + 生命周期）。

## 9. 实施

**本章结论**：六阶段串行，每阶段独立 commit + 验证（对齐「打包/子系统改动逐个 commit 逐个验证」纪律）。

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | core/transport/api 落位：迁 pending/events/request + 单测随迁（import 改写） | 中间件 core 内可用 |
| M1 | domains 17 文件迁移 + request 依赖对齐 | 出站链路 core 内闭合 |
| M2 | mock 迁移 + facade 改造（VITE_E2E 参数化）+ search 轨条件化 + SearchPorts.searchMock 可选化（search-ports.ts:106）+ search.ts 守卫 + 3 测试类型适配 + mock-ws 并入 + bundle 探针门③ | G4 |
| M3 | TransportPorts 降级内部 seam + ConnectionPorts 收窄 + useConnection 装配瘦身 + bridge 改锚 + connect() 死代码删除 + lib/ws-client shim 删除（含 subscription-state 类型改造与 core 测试注入适配） | G1/G2/G3（接口面收口） |
| M4 | import 改写 codemod（生产 ~46 + 测试 62 处/50 文件）+ A6 回归门 | 真源物理成立 |
| M5 | bootstrap 真编排 + App.vue 调用点 + resolvePlatform() 收敛（删 bootstrapSettingsCore 兜底注入）+ 注册触发收敛（桥侧删 :260-261 两行 void 自行触发，:258 注入保留，bootstrap 第 4/5 步唯一触发点）+ A5 探针 | G5 |

## 10. 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| u1 pending/events/request 迁移 | 3 文件 + 随迁单测，零接口改动 | 无依赖（其他模块的消费者），最先落位供后续引用 |
| u2 domains 迁移 | 17 文件按域分批（session/chat 先，其余批量） | request 依赖先行；session/chat 是 route-inbound/use-connection 装配的引用点 |
| u3 mock 迁移 | 数据文件 + index 工厂参数化 + search 轨条件化 + SearchPorts.searchMock 可选化 + search.ts 守卫 + bundle 探针 | 依赖 u1 已实证（R1：mock/index.ts `import * as events from '../events'`，随迁改路径） |
| u4 接口收口 | TransportPorts 降级内部 seam + ConnectionPorts 收窄 + bridge 改锚 + 死代码删除 + shim 删除 + subscription-state 类型改造 + core 测试注入适配 | 依赖 u1/u2 全部消费者切换完成，避免中间态双入口 |
| u5 import codemod | 脚本化替换 + 手工复核 + 全量回归 | 独立于 u4 可并行准备，落地必须在 u4 后（锚定最终路径） |
| u6 bootstrap 编排 | initConnection 真实现 + 调用点收敛 + 注册触发去重（桥侧删 :260-261 自行触发）| 最后做：依赖 u4 后的稳定连接层；A5 探针随此单元 |

## 11. 待验证检查点

设计阶段无法确定、留给实施期验证的点（诚实标注，不编造）：

1. **跨包静态分支的 DCE 效果**（D4-② 核心）：Vite/Rollup 对 `if (import.meta.env.VITE_MOCK === 'true')` 包裹的 core mock 子路径 import 能否整块裁剪（含 core `sideEffects` 字段影响）——A7 探针门实证；裁不掉则 fallback 动态 `import()`，成本另估。
2. **vi.mock 拦截链路**：8+ 个 renderer 测试 `vi.mock('@/api/transport')`，模块删除后 mock 目标改 core 子路径；core 是源码直引（main: src/index.ts），Vitest 对包内相对 import 的 mock 拦截链路需实证——预改一个 t4-api-layer 类测试验证（先例坑：re-export shim 的 mock 不拦截 core 内部 import，session-workflow-update-fallback.test.ts:31 注释）。
3. **core vitest 配置对随迁测试的兼容性**：pending 的 fake timers 用例、domains 的 mock 数据在 core vitest 环境是否直接跑通。
4. **`@xyz-agent/core` 在 renderer vite 构建下的解析路径**：新增子路径 exports 后 alias/优化器配置是否需调整（现状 `.` 入口已被 166 文件消费，风险低但需实测）。
5. **挂载点/贡献注册触发时序**：桥侧现行 fire-and-forget 自行触发（mount 前，useExtensionHostBridge.ts:260-261，:258 注入行保留），M5 收敛为 bootstrap 第 4/5 步唯一触发（onMounted）——若首屏渲染依赖 mount 前已注册的 mount points，fallback = bootstrap 调用点前移至 main.ts mount 前（pinia/i18n 在 main.ts 已就绪，不破坏 D2 前提）。fallback 自带裁定标准：实测订阅注册（bootstrapSettingsCore）仍先于 sendInitialState 首推——App.vue:59-64 [HISTORICAL] 订阅晚于首推的竞态不得重开；不满足则改窄形态（仅第 4/5 步注册提前触发，bootstrap 整体留 onMounted）。

（v1 版待验证项中「restoreSessions 钩子内容未定位」已消除——R1 定位到 App.vue:96-105 并在 D2 完成语义设计；「u3 依赖关系待核实」已消除——R1 实证 mock/index.ts import events。v3 版 restoreSessions 壳注入钩子形态经 R3 减法修正为 core 内占位，消除「未注入 warn vs 空函数注入」二义。）

## 附录：变更历史

- v1：2026-09-02 初稿（基于架构审查 C1/C3 候选 + 3 路调研实证 + D1 用户拍板「直接改写」）。
- v2：2026-09-02 吸收 R1 对抗式审查（2 must-fix + 8 suggestion 全修）：① D2 重写 await 语义（initConnection resolve = 编排已提交而非 connected，三方案对比裁决；删 connectionMode 双开关；restoreSessions 现状定位与注入语义）；② D4 增 search 轨专项（构建期常量静态分支 + A7 bundle 探针门 + fallback 动态 import）；③ 失败模式 A 改写为出口分裂（原描述与 watch(connected) 防御现状不符）；④ D3 降级为内部测试 seam 并枚举 subscription-state/4 测试连带；⑤ lib/ws-client shim 归宿入 §7；⑥ A5 具体化、A6 放宽、新增 A7；⑦ D5 增对 SSOT §10.1 的修订声明；⑧ 数字校正（测试 62 处/50 文件、App.vue:96、bootstrap.ts:33）。
- v3：2026-09-02 吸收 R2 对抗式审查（2 must-fix + 5 suggestion 全修）：① restoreSessions 诚实改写为 no-op 占位 + future 扩展点标注（R2 实证数据源与注入机制现状均不存在：subscription-state 内存态、auth payload 仅 token）；② platform 注入点全景修正（useSettingsShell.ts:65-70 是第二分叉注入点——收敛决策为删其兜底注入 + main.ts 保留理由修正 + A5 实验链条修复为先删兜底再挪注入）；③ D4-② 机制描述改正（块内静态 import 非法 ESM → 顶层 import + 引用点条件化 + core 声明 sideEffects:false）；④ §11 编号漂移修正（D4 §11.2→§11-1、A6 §11-6→§11-2）；⑤ §6.1 三处 53→62 处/50 文件；⑥ §7 route-inbound 行与 D3「降级内部 seam」对齐；⑦ G4 分叉表述与 D4 同步、D2 五步之首称谓统一。
- v4：2026-09-02 吸收 R3 对抗式审查（kimi k3-256k，1 must-fix + 3 suggestion 全修 + INFO①实证）：① D4-② 补契约前置决策——SearchPorts.searchMock 必填（search-ports.ts:106）与「real 模式省字段」冲突，裁决改可选 + search.ts:123 守卫（stub 方案掩盖装配错误，被否）；② restoreSessions 减法修正为 core 内 no-op 占位（删壳注入钩子形态——未来实现归 core coordination，壳无物可注；BootstrapOptions 不加 hooks，消除 warn 二义）；③ A5 违反态标准改写为实际可观察结果（settings init fail-fast + 偏好未加载 + 连接仍成功，R3 实证 bootstrap 首步幂等复注使降级 UI 尾句不可复现）；④ D2 main.ts 保留理由对齐实装（桥初始化无 platform 触点，承重消费点是 settings-lifecycle.ts:88）；⑤ INFO①实证桥侧 :260-261 已自行触发注册（:258 为注入行保留）——M5/u6/§7 补注册触发收敛去重决策 + §11 新增第 5 条注册时序检查点。
- v5：2026-09-02 吸收 R4 聚焦复审（0 must-fix，3 suggestion + 2 行号旧账全修后收尾）：① 桥删行范围五处校正 :258-261→:260-261（:258 是 setExtensionRegistries 注入行，删则 4/5 步永久 warn 降级）；② SearchPorts 可选化交付物联动补入 M2/u3（含 3 测试类型适配）；③ §11-5 fallback 补竞态裁定标准（[HISTORICAL] 订阅晚于首推不得重开）+ 窄形态备选；④ 行号旧账（App.vue:70 解构/:96 调用、bootstrap.ts:28 TODO）。R4 判定：v4 可进入实施。
