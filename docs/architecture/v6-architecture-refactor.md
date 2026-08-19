# v6 架构重构设计（2026-07）

> **状态**：**已 supersede（2026-08-20）**——终态架构以 [renderer-rebuild-architecture.md](renderer-rebuild-architecture.md)（现行 SSOT，以包为层）为准；本文档保留作历史参考，新代码落位不要按本文档的分层。
> **性质**：长期方案。架构归位（数据/逻辑在应在的层），不引入新技术债，未来扩展不需推翻重写。
> **关联**：
> - 承接 `docs/page-design/v6-design.md` §6/§7/§8（已定稿架构决策，本文档是其执行展开）
> - 承接 handoff-architecture.md（阶段 0/A/B），**本文档对 handoff 做了独立验证与重心修正**
> - 修订 `docs/architecture/runtime-three-layer-design.md`（runtime 三层，本文档确认其方向正确，仅缝补）

---

## 0. 与 handoff 的关键分歧（先读这一节）

handoff-architecture.md 把「runtime 三层契约名实不符」列为整体-1 最高优先级。**独立验证后这个优先级判断是错的**——runtime 不是本次重构的重点，renderer 才是。

### 0.1 handoff 数字失准对照表

handoff 的**定性诊断全部成立**，但**定量数字普遍不可信**（5 个 explorer 独立交叉验证）：

| handoff 主张 | 实测 | 偏差 |
|---|---|---|
| services→infra 直连「12 处」 | **22 处**（非测试） | 低估 83% |
| Composer import「16 个 composable」 | **20 个** | 低估 25% |
| chat.ts「20+ 个 *Impl 函数」 | **6 个**（含所有 helper 10 个） | 严重夸大 |
| routeInbound「跨 5 个 store」 | **4 个直接 / 7 个含 helper** | 站不住 |
| Sidebar「22 个 store/composable」 | **~20 个**（量级吻合） | 基本准确 |
| shared「污染 renderer 依赖图」 | **renderer 零 import** git-status-parser/ignore-parser | 不成立（见 §3.2） |

教训：handoff 作者存在「为强化叙事调整数字」的倾向。**本文档所有数字均经 explorer 独立验证**，带 `[实测]` 标注。

### 0.2 重心修正：renderer 才是重点

| 层 | handoff 定性 | 独立验证后定性 | 结论 |
|---|---|---|---|
| runtime 三层 | 整体-1 最高优先级 | **核心能力全部架构正确**（10/13 域「架构正确」，3 域「需缝补」，0 域需重构）。22 处直连中 59% 在扩展能力（quota/migration 可裁剪域），进入核心的 8 处中 6 处是良性路径/类型依赖，**仅 session 域 2 处真业务绕过** | runtime **缝补即可**，不推翻 |
| shared 包 | 整体-2 | git-status-parser/ignore-parser 确实职责越界（放 shared 只被 runtime 用），但 **renderer 零 import，无实际 bundle 污染**。下沉是长期正确但非紧急 | 下沉（机械移动） |
| IPC 边界 | 整体-3 | 诊断全部属实（45 方法、3 业务持久化、proxy 命名错配、持久化链分裂） | 收敛 |
| **renderer 编排层** | 「局部，降级」 | **这才是真问题区**：useChat 违反 ADR-0049（编排层中枢用裸 Map）、stores↔composable 双向倒置依赖、Sidebar 全局快捷键 88 行内联、settings 与 v6 全屏覆盖根本形态冲突、bg-accent 98 处危险双义 | **重点重构** |

**一句话**：handoff 把力气放错了位置。runtime 已经够好，renderer 的编排层与状态隔离才是欠债最重的地方。

---

## 1. 架构现状总评（独立验证）

### 1.1 整体架构图（跨进程/跨包）

```
┌─────────────────────────── Electron App ───────────────────────────┐
│                                                                     │
│  MAIN PROCESS (Node)          PRELOAD (contextBridge)               │
│  apps/electron/main/           apps/electron/preload/               │
│   ├ WindowManager              window.electronAPI {45 methods}       │
│   ├ ShortcutRegistry              │                                 │
│   ├ BrowserViewManager ◄──IPC─────┘                                 │
│   ├ ipc-handlers (gateway/)                                        │
│   └ RuntimeSupervisor ──spawn runtime subprocess                   │
│                                                                     │
│  RENDERER (Chromium, Vue3) ◄────── WebSocket ──────►  RUNTIME (Node)│
│  packages/renderer/                                    packages/runtime│
│   ├ api/ (30 file)           ClientMessage ◄──WS──► ServerMessage  │
│   ├ composables/ (125 file)                              ├ transport/ │
│   ├ stores/ (30 file)                                    ├ services/  │
│   └ components/ (176 file)                               └ infra/pi/  │
│                                                        │ stdin/stdout │
│                                                        ▼ JSONL RPC    │
│                                                  PI SUBPROCESS        │
│                                                        │              │
│                                   services/plugin ──spawn Worker─────┤
│                                                       PLUGIN WORKER   │
│                                                                     │
│  数据隔离: ~/.xyz-agent/ (xyz-agent) ↔ ~/.pi/agent/ (系统 pi, 隔离) │
└─────────────────────────────────────────────────────────────────────┘
```

**整体评价**：跨进程/跨包这一最顶层设计扎实、边界清晰、文档详尽。进程职责干净（main 是壳、runtime 是唯一 pi 适配点、renderer 零 `node:` 导入），包依赖单向无环（`shared ◄── runtime ◄── electron`，`shared ◄── renderer`），四套通信机制各有不可替代场景。**问题集中在 renderer 编排层，非顶层**。

### 1.2 各层健康度（独立验证后）

| 层 | 健康度 | 核心证据 |
|---|---|---|
| 进程拓扑 / 包依赖 | ✅ 优秀 | 单向无环，职责干净 |
| runtime 三层 | ✅ 良好（85% 落地） | 16 port 接口 + 构造注入 DI 就位；22 处直连多数良性（见 §4） |
| shared 包 | 🟡 职责越界 | 2 个 Node-only 算法放 shared 只被 runtime 用（见 §3） |
| IPC 边界 | 🟡 过宽 | 45 方法含 3 业务持久化 + proxy 命名错配（见 §5） |
| **renderer stores** | 🔴 契约破裂 | stores↔composable 双向倒置，事件逻辑泄漏进 store（见 §6.2） |
| **renderer composables** | 🔴 编排层中枢违规 | useChat 违反 ADR-0049 + routeInbound 巨型路由（见 §6.1/§6.3） |
| **renderer components** | 🔴 上帝组件 + 形态冲突 | Sidebar 6 职责域 + settings modal 与 v6 冲突（见 §7） |
| renderer ui/ 双名 | 🟡 危险残留 | bg-accent 98 处双义（见 §8） |

---

## 2. 重构原则（最长期最合理）

1. **架构归位**：数据/逻辑放回应在的层。判断标准——三个月后回来看，会不会想骂人。
2. **沿用成熟范式**：项目已有的好范式（ports 依赖倒置、useSessionScopedState 工厂、R2 composable 四层）优先复用，不另起炉灶。
3. **缝补优于推翻**：runtime 已 85% 正确，补全 ISessionStore 缺口 + logger 决策，不重写 services。
4. **每波独立 commit + 测试门**：架构波过测试门（coverage 不退 + CI 绿），视觉波过视觉验收。
5. **删旧测试随重构同步**：重构到哪个模块，删该模块旧测试 + 写新行为测试，模块级原子化，无覆盖空窗。

---

## 3. 阶段 A：整体架构（3 项，优先级 A2 > A3 > A1）

> handoff 把 A1（runtime）排最高。独立验证后 A1 降为「缝补」，**A2（shared）+ A3（IPC）是真正该先做的整体清理**。但 A1 风险最低、最机械，可最先做暖身。

### A1. runtime 三层契约缝补（整体-1，降级为缝补）

**诊断修正**：handoff 说「12 处 services 直连 infra」[实测 22 处]，但分布揭示这不是架构错误：

| 能力域 | 直连数 | 核心性 | 性质 | 处理 |
|---|---|---|---|---|
| quota | 7 | 扩展 | provider-store 读写 + logger | 缝补（或新建 IProviderStore） |
| migration | 6 | 扩展 | 4 处 type-only + logger | 缝补（一次性导入工具，低优） |
| **session** | **6** | **核心** | 3 路径 + 1 类型 + **2 运行时业务** | **收口 2 处**（见下） |
| config | 1 | 核心 | getConfigDir 路径 | 放行（注释已说明） |
| extension | 1 | 核心 | 3 路径函数 | 放行 |
| handoff | 1 | 扩展 | 纯 type import | 无害 |

**结论**：22 处中 13 处（59%）在扩展能力（可裁剪），进入核心的 8 处中 6 处是良性路径/类型依赖，**只有 session 域 2 处是真业务绕过**。

**A1 动作（缝补，非重构）**：

1. **补全 ISessionStore port**（唯一核心改动）：
   - `parseSessionHeader` / `persistHandedOff`（session-file-utils）[session-service.ts:34]
   - `rebuildHistoryFromEntries`（entry-tree-builder）[session-service.ts:23]
   - 这 3 个函数收入 `ports/session.ts` 的 `ISessionStore` 接口，infra 侧 `PiSessionStore` 实现，session-service 改走 `this.sessionStore.*`
   - 收口后 session 域直连从 6 → 3（全是 pi-paths 路径 + 1 纯类型，良性）

2. **logger 策略决策**（6 处静态 import）：
   - **长期方案（推荐）**：logger 是跨切面基础设施，多数三层架构允许它例外。在 `runtime-three-layer-design.md` 显式声明「logger 豁免 ports 契约」+ 在 services 顶部约定。这样 6 处静态 import 合规化，不必为 6 处改 DI 接线（成本不匹配收益）。
   - 短期方案：若坚持零直连，logger 改构造注入（每个 service 加 `private logger: ILogger`）。不推荐——6 个 quota-provider 小文件为 logger 加构造参数是过度工程。

3. **quota/migration**（扩展能力，低优，可后置）：
   - quota 7 处：可选新建 `IProviderStore` port 封装 `getApiKeyForProvider/getProviderConfig/upsertProvider`，给 quota-service 补 DI 接线（当前漏接 IConfigStore）。
   - migration 6 处：一次性导入工具，PiProviderConfig 类型泄漏可接受，或迁移到 ConfigProviderConfig service 视图类型。

4. **pi-paths 路径函数**（5 处）：
   - **长期方案（推荐）**：按 handoff 建议归为 "kernel" 层（与 infra 平级的共享内核，services 可合法依赖纯路径函数）。在文档声明 pi-paths 为 kernel。
   - 不必为纯路径函数加 port（`getPiAgentDir` 是无副作用的路径计算，加 port 是仪式主义）。

**验收**：`rg "from '.*infra" packages/runtime/src/services/` 仅剩 logger（若豁免）+ pi-paths（若归 kernel）+ quota/migration（若后置）。session 域零运行时业务直连。

---

### A2. shared 包瘦身（整体-2）

**诊断修正**：handoff 说「shared 混入运行期实现，污染 renderer 依赖图」——前半属实，**后半不成立**。

独立验证 [实测]：renderer **零 import** `parseGitStatus` / `compileIgnoreRules` / `matchPath` / `parseNumstat` / `xyToGitStatus` / `deriveCounts`。这三个 Node-only 解析器虽经 shared barrel 导出，但 renderer 从未消费，**不存在实际 bundle 污染**。

真正的问题是**职责越界**：Node-only 算法放在 shared（协议下沉层），违反「shared 是单向下沉」。runtime 是唯一消费方，应该归 runtime。

**shared/src/ 文件分类** [实测]：

| 性质 | 文件 | 归属 |
|---|---|---|
| 纯类型/接口（协议 DTO） | protocol/message/message-metadata/session/provider/settings/panel/subagent/workflow/update/migration/quota-types/segments(FileNode 部分) | ✅ shared 正确 |
| 纯常量/数据 | constants.ts / recommended-extensions.json / sound-defaults.ts / pi-default-prompt.ts | ✅ shared 正确 |
| 跨进程路径推导（Node-only，刻意不进 barrel） | paths.ts | ✅ 设计正确的隔离范例（index.ts:47-49 注释明确） |
| **跨端纯函数（renderer 复用）** | segments.ts 的函数 / quota-presets.ts / message.ts 的 parseBgNotifyDetails / pi-preset.ts | ✅ shared 正确（renderer 真复用） |
| **Node-only 算法（仅 runtime 用）** | **git-status-parser.ts / ignore-parser.ts** | 🔴 **下沉 runtime** |
| file-tree.ts | 仅 FileNode 类型，无算法 | ✅ shared 正确 |

**A2 动作**（机械移动，低风险）：

1. `git mv packages/shared/src/git-status-parser.ts` → `packages/runtime/src/infra/git/git-status-parser.ts`
2. `git mv packages/shared/src/ignore-parser.ts` → `packages/runtime/src/infra/fs/ignore-parser.ts`
3. 从 `shared/src/index.ts` barrel 移除这两个 re-export（index.ts:50-52）
4. runtime 唯一消费方改 import 路径：
   - `git-service.ts:21` → `../infra/git/git-status-parser`
   - `file-service.ts:21` → `../infra/fs/ignore-parser`
5. 对应测试文件随之移动（shared 测试删除，runtime 侧已有同名测试或合并）

**验收**：`grep -r "git-status-parser\|ignore-parser" packages/renderer/src/` = 0（本就为 0，验证不退）。shared barrel 不再导出 Node-only 算法。

---

### A3. IPC 边界收敛（整体-3）

**诊断全部属实** [实测]：electronAPI **45 方法**（非 40+），其中：

- **3 个业务持久化**（违反「OS 特权才走 IPC」）：`writeSessionImage` / `migrateSessionImage` / `writeSegmentsMetadata` [preload.ts + main/gateway/privileged-handlers.ts:200/235/310]。落盘到 `<getDataDir()>/attachments/<sessionId>/`，由 **main 进程**写。
- **命名错配**：proxy 三方法（`getProxyConfig`/`setProxyConfig`/`testProxy`）挂在 `update:*` 通道 [main/gateway/update-handlers.ts:185/190/212]，与升级职责无关，纯历史粘连。
- **持久化链分裂**：图片/segments.json 由 main 经 IPC 写到 attachments/，session JSONL 由 runtime 写到 pi/agent/sessions/。runtime 还需**直接读** attachments/segments.json [session-service.ts:1157]，形成「main 写 IPC / runtime 直读文件」的跨进程默契（靠共享路径约定耦合）。

**A3 动作**：

1. **proxy 命名修正**（最低成本，先做）：
   - 从 `update-handlers.ts` 抽出 proxy 三 handler 到独立 `gateway/proxy-handlers.ts`
   - 通道名 `update:getProxyConfig` → `proxy:get` / `proxy:set` / `proxy:test`
   - preload 别名保留兼容窗口，或直接改（用户授权不考虑兼容性）

2. **业务持久化迁移到 runtime（WS）**（核心改动，消除持久化链分裂）：
   - 新增 runtime WS handler：`session.writeImage` / `session.migrateImage` / `session.writeSegments`
   - runtime 侧复用既有 `getAttachmentsDir()`（shared/paths），写到 attachments/（同一目录，写者从 main 改 runtime）
   - main 侧删除 `privileged-handlers.ts` 的这 3 个 handler
   - preload 删除这 3 个方法，renderer 改走 `api/session.writeImage` 等 WS 调用
   - **收益**：所有 session 相关数据走单一 runtime 出口，消除 main 写/runtime 读的跨进程默契。runtime 重启后数据一致性由 runtime 自管，不靠约定。

3. **playSystemSound 评估**：可用 renderer `new Audio`，但系统提示音（非文件音）需 OS API。保留 IPC 但确认必要性。

**验收**：electronAPI 从 45 → ~41（移除 3 持久化 + 1 别名）。`update-handlers.ts` 不再含 proxy。session 数据 100% 走 runtime。

---

## 4. 阶段 B：renderer 编排层重构（重点，3 项）

> 这是本次重构的**真正重点**。handoff 把它降级为「局部」是误判——renderer 编排层是状态隔离和事件分发的中枢，欠债最重。

### B1. chat 编排层状态隔离（局部-1，最高优）

**问题** [实测]：`useChat.ts`（编排层中枢）违反 ADR-0049：
- `:45` `const streamSubscriptions = new Map<string, () => void>()`（模块顶层 per-session Map）
- `:52` `const historyTruncatedSessions = ref<Set<string>>(new Set())`（模块顶层 per-session Set）
- `:66-83` 导出 `resetChatModuleState()`，注释**自认反模式**：「跨 useChat() 调用共享…测试间不 reset 会泄漏」

**扩散范围** [实测 6 个生产代码 reset 函数]：
| 文件 | 模块级 per-session 状态 |
|---|---|
| useChat.ts:66 | Map + Set + subscriptionStates |
| useMessageBusSubscription.ts:162 | 模块级 Map |
| useNewTaskFlowState.ts:118 | 6 个模块级 ref |
| useSideDrawer.ts:131 | pendingOpenMap + refs |
| useSidebar.ts:76 | sessionListSubCount/unsub/appBootstrapped |
| useForkNoticeEffect.ts:103 | feedMap + trackedBranchesRef |

**讽刺点**：`useSessionScopedState` 工厂**已存在且部分 composable 已正确使用**（useSideDrawer:66 同时有正确工厂用法和反模式的 pendingOpenMap 共存）。范式就在隔壁，useChat 却没用。

**B1 动作**：

1. **useChat 迁移**（核心）：
   - `streamSubscriptions` Map → `useSessionScopedState` 分区
   - `historyTruncatedSessions` Set → 同上
   - 删除 `resetChatModuleState`，依赖 `triggerSessionCleanups(id)` 自动清理

2. **逐个迁移其余 5 个 reset 反模式**：
   - useMessageBusSubscription / useNewTaskFlowState / useSideDrawer(剩余) / useSidebar / useForkNoticeEffect
   - 每个迁完删 `reset*ModuleState`，确认无测试显式调用这些 reset（若有，改用 `triggerSessionCleanups`）

3. **范式守护**：在 ADR-0049 补一条 lint 规则或 code-review checklist：禁止新的模块级 per-session Map/Set，必须用工厂。

**验收**：`grep -r "reset.*ModuleState\|reset.*States" packages/renderer/src/composables/` = 0。`grep -r "new Map<string" packages/renderer/src/composables/features/` 仅在 useSessionScopedState 内部。

---

### B2. stores 依赖契约修复（局部-2，高优）

**问题** [实测]：
- `stores/chat.ts:9` 头部契约：「依赖方向：无（stores 间禁止互相 import）」
- `stores/chat-message-effects.ts:55` `import { useTasksStore } from './tasks'`（store→store 违规）
- `stores/chat-message-effects.ts:60` `import { usePanelStore } from '@/stores/panel'`（store→store 违规）
- `stores/chat-message-effects.ts:59` `import { useSideDrawer } from '@/composables/features/useSideDrawer'`（**store→composable 倒置依赖**，更严重）

`chat-message-effects.ts` 是 737 行的 effect 注册表，导出 `dispatchMessageEvent`，内含 `routeToolResultToTasks` / `routeToolStartToTasks` / `openTasksDrawerOnFirstData`——**message.* 事件的业务分发逻辑物理驻留在 stores/ 目录**，耦合 tasks store + panel store + sideDrawer composable。

**根因**：事件消费（「message 到达后该干什么」）是编排职责，不属于 store（store 是 SSOT 状态容器，不该编排跨 store 副作用）。它被放在 stores/ 是历史误归位。

**B2 动作**：

1. **抽独立事件消费层** `composables/features/useMessageEffects.ts`（或复用 effects/ 层）：
   - 订阅 message.* 事件流
   - 分发到 chat store（消息入流）/ tasks store（tool_call 路由）/ panel store / sideDrawer
   - store 回归纯职责：只管自己的状态，不编排跨 store

2. **store 契约守护**：
   - chat.ts 头部契约保留并强化
   - 补 code-review checklist：stores/ 内禁止 import 其他 store 或 composable
   - chat-message-effects.ts 的逻辑迁出后，该文件降级为纯 chat store 的内部 effect（若无跨 store 逻辑则并入 chat store 私有）

**验收**：`grep -rE "import.*use[A-Z].*Store.*from" packages/renderer/src/stores/*.ts` 仅匹配同 store 的辅助模块（chat-mutations 等），无跨 store import。`grep -rE "import.*from.*composables" packages/renderer/src/stores/` = 0。

---

### B3. routeInbound 声明式路由（局部-3，中优）

**问题** [实测]：`composables/useConnection.ts:95-198` routeInbound 函数 **104 行** if-else 兜底路由：
- 「兜底」注释出现 **5 次**（行 155/168/177/190 + 文件级 54/80）
- 7 个 `if (msg.type === ...)` 串行分支
- 混了：error envelope 展开 + session 通道分发 + seq gap 检测 + 各事件类型兜底
- 函数体直接触达 4 个 store（panel/subagent/workflow/toast），含 helper 共 6-7 个 store

**根因**：没有显式的消息分发注册表，所有 ServerMessageType 的兜底处理都堆在一个函数里。

> **远程化影响**（`feat-remote-use` 合并后）：routeInbound 会新增 5 类消息分支——`session.deleting` / `session.deleted`（软删 + 清 store 分区）/ `session.busy` / `session.idle`（lease acquire/release） / `presence.update`（全局协同态）。B3 的 ROUTE_TABLE 设计必须把这些纳入为路由表条目，而非回退 if-else。routeInbound 归属 **T&C 层**（见 `renderer-target-architecture.md` §2.2）。

**B3 动作**：

1. **声明式路由表**：
   ```ts
   // 声明式：type → { channels, handler } 注册表
   const ROUTE_TABLE: Record<ServerMessageType, RouteRule> = {
     'message.*': { channels: sid => [sid], handler: dispatchSession },
     'session.exited': { channels: 'global', handler: handleSessionExited },
     // 远程化分支（合并后纳入）
     'session.deleting': { channels: sid => [sid], handler: handleSessionDeleting },
     'session.deleted': { channels: sid => [sid], handler: handleSessionDeleted },
     'session.busy': { channels: sid => [sid], handler: handleSessionBusy },
     'session.idle': { channels: sid => [sid], handler: handleSessionIdle },
     'presence.update': { channels: 'global', handler: handlePresenceUpdate },
     // ...
   }
   ```
   routeInbound 退化为查表 + 执行，消除 if-else 串。

2. **seq gap 检测抽独立中间件**：当前混在 routeInbound 里，抽成 `detectSeqGap(msg)` 纯函数，在路由前/后调用。

3. **error envelope 下沉**：error 展开逻辑移到 `api/pending.ts`（RPC 通道层），routeInbound 不处理 envelope。

4. **远程协同消息分发下沉事件消费层**：`session.busy`/`session.idle`/`presence.update` 的 store 写入，从 routeInbound 内联代码迁到 B2 抽的独立事件消费层（`useMessageEffects.ts`），routeInbound 只做路由查表，不触达 store 内部方法。lease/presence 是 T&C 层职责，但分发机制走 Feature 层的事件消费层（经依赖铁律允许的 T&C→Foundation 路径）。

**验收**：routeInbound 查表 + 执行，无业务逻辑内联（远程化分支作为 ROUTE_TABLE 条目注入，不回退 if-else）。seq gap / error envelope 独立可测。远程协同消息（busy/idle/presence）经事件消费层分发，不在 routeInbound 内联。

---

## 5. 阶段 B：renderer 模块级重构（3 项）

### B4. Composer 合并（局部-4）

**问题** [实测，比 handoff 更严重]：Composer.vue import **20 个 composable**（handoff 说 16，少算），其中 `useComposer*` 系列 13 个。`useContenteditableInput.ts` **873 行**是上帝模块。Composer.vue 411 行，script setup 282 行逼近上限。

**B4 动作**：按变化轴（不是按减行）合并为 3 个内聚 composable：
- `useComposerInput`：编辑能力（contenteditable + chip + dragdrop + paste + history）——吸收 useContenteditableInput 873 行 + 相关
- `useComposerDispatch`：发送模式路由（send/steer/followup/bash/handoff/fork）
- `useComposerContext`：注入 + staging

合并后 Composer.vue import 从 20 → 3-5 个核心 composable + 若干轻量 hook。

---

### B5. Sidebar 拆分（局部-6）

**问题** [实测]：Sidebar.vue 467 行（template 180 / script 285），承担 **6 职责域**。最严重的内联逻辑：
- **全局快捷键 ~88 行内联**（:379-466）——⌘K/⌘N/⌘B/⌘G/⌘J/⌘⇧G/⌘⇧P，**与 sidebar 语义完全无关**，是全局快捷键误放此处
- **8 个 tab 计数 computed 堆本体**（:245-266）——fileCount/subagentCount 等
- **session handler 群**（:273-362）——未抽到 useSidebarSessionActions（已有 useSidebarSubagentActions 但 session 没对称抽取）

**B5 动作**：
1. **全局快捷键抽出**：新建 `composables/features/useGlobalShortcuts.ts`，88 行快捷键逻辑迁出。Sidebar 不该管全局快捷键。
2. **tab 计数抽出**：新建 `useSidebarCounts.ts`，8 个 computed 迁入。
3. **session handler 抽出**：新建 `useSidebarSessionActions.ts`（对称于 useSidebarSubagentActions）。
4. Sidebar.vue 退化为纯布局容器（< 200 行），每个职责域一个子组件（SessionList/SubagentSection/WorkflowSection/FileTreePanel/SidebarFooter，部分已存在）。

---

### B6. chat store 重组（局部-5）

**问题修正** [实测]：handoff 说「11 文件 + 20+ *Impl」——文件数准确（10 个 chat-*.ts + chat.ts 本体），但 **\*Impl 实际仅 6 个**（disposeSessionImpl/evictVirtualKeyImpl/appendSystemNoticeImpl/applySubagentStreamDeltaImpl/finalizeSubagentStreamImpl/finalizeMessagesImpl），含所有 helper 共 10 个。handoff 严重夸大。

chat.ts 仍 906 行，*Impl 是为绕 max-lines-per-function lint 而搬出的模块级函数。

**B6 动作**：
1. **流式消息状态机内聚**：applySubagentStreamDeltaImpl + finalizeSubagentStreamImpl + finalizeMessagesImpl 合一为深模块（流式消息的 mutate/timer/chunk 合一），消除「为绕 lint 拆函数」。
2. **LRU/changeset/handoff/bash-effects 保留**：这些是独立子域，当前拆分合理。
3. chat.ts 目标 < 600 行（消除 *Impl 后逻辑内聚到 store 方法或深模块）。

---

## 6. 阶段 B：renderer 整理级重构（3 项，低风险）

### B7. settings 重构（局部-7）——与 v6 视觉线交叉

**问题** [实测]：21 vue + 1 ts 平铺无子目录，6 个 vue 超 400 行（ExtensionPage 514 / SystemPage 488 / ProviderPage 471 / PiPresetsPage 435 / ProviderEditModal 408 / CodingPlanSection 330）。`compat-fields.ts`(362 行) 数据文件混入。

**与 v6 视觉冲突** [实测]：当前 `SettingsModal.vue` 是 reka Dialog 居中 modal（900px + backdrop-blur），v6-design §4.5 要求**全屏覆盖 FullSettingsOverlay**（fixed inset-0，无遮罩，手写非 reka Dialog）。ProviderEditModal 当前是双层 modal，v6 要求改嵌入式面板。

**B7 动作**：
1. **目录分层**：按域分子目录 `settings/provider/`、`settings/preset/`、`settings/system/`、`settings/extension/`、`settings/worktree/`、`settings/terminal/`。
2. **数据文件移出**：`compat-fields.ts` → `stores/` 或 `lib/`。
3. **形态重构**（与 v6 视觉线协作）：SettingsModal → FullSettingsOverlay（全屏）。ProviderEditModal → 嵌入式面板（非双层 modal）。这部分视觉形态由 v6 视觉线定稿，架构线负责目录分层和数据流。

---

### B8. ui/ 双名清洗（局部-8）

**问题修正** [实测]：handoff 说「业务用 shadcn 命名，靠别名维系」——**部分不属实**。业务组件**绝大多数已用 v3 命名**（v3 命名 1060 处 vs shadcn 命名 105 处，~10 倍）。

真正危险的是 **`bg-accent` 98 处残留**：同一个 class 在 ui/ 内部是 shadcn 的「hover 软底」语义，在业务组件里被当 v3 的「主色选中态」用——**双义危险**。两处根本冲突（`--accent` v3=主色蓝 / shadcn=hover 软底；`--muted` v3=次级文字 / shadcn=背景）在 style.css:108-111 注释自认。

**B8 动作**：
1. **`bg-accent` 双义消除**（优先）：业务组件的 `bg-accent`（主色选中态语义）改用显式 v3 类（如 `bg-accent-soft` 或新增 `bg-selected`），与 ui/ 内的 hover-soft 语义彻底分离。
2. **ui/ 内部 shadcn 命名清洗**：Input.vue/Textarea.vue 的 `border-input`、DialogContent/Checkbox/Switch 的 `ring-offset-background`/`focus-visible:ring-ring` 改 v3 命名。
3. **决策**：保留 ui/ 作为 fork 后的 v3 原语库（不回归 shadcn 上游），style.css 别名映射层逐步消除。彻底 fork 改名 vs 业务全转 shadcn 命名——二选一，倾向前者（v3 命名已是主流）。

---

### B9. composables 分层规则统一（局部-9）

**问题修正** [实测]：R2 四层规则（features/effects/logic + panel/new-task）**实际存在且被遵守**（每个文件头部 JSDoc 自标层级）。问题在：
- **features(41) / panel(37) 两巨型桶**：无业务域二次分组（无 features/sidebar/、features/provider/）
- **顶层 12 文件混入业务**：useComposerChipCommands（panel 子域）/ useCompletionNotify / useCompletionSound（业务副作用）3 个不属于全局基础设施；slashIcons.ts / sound-defaults.ts 2 个纯数据文件不该混放顶层

**B9 动作**：
1. **features/ 按域分子目录**：`features/sidebar/`、`features/chat/`、`features/provider/`、`features/search/`、`features/fork-handoff/` 等。
2. **panel/ 按子域**：`panel/composer/`、`panel/message-stream/`、`panel/turn/`。
3. **顶层只留全局基础设施**：useToast / usePlatformShortcut / useSessionScopedState / useMessageBusSubscription / useExtensionUI / useSessionMarkers（6 个真·全局）。
4. **T&C 层独立分组**：useConnection 归 **T&C 层**（见 `renderer-target-architecture.md` §2.2），不进 features/panel 桶。建议 `composables/transport/` 子目录收纳 useConnection + 未来远程化 composable。useConnection 当前是 mobile 的 MANUAL_FORK，路径变更需同步 sync 脚本。
5. **下沉**：useComposerChipCommands → panel/composer/；useCompletionNotify/useCompletionSound → effects/；slashIcons.ts/sound-defaults.ts → logic/ 或新建 constants/。

> **⚠️ sync 兼容纪律**（远程化合并后强制）：以下 B 项改动会影响 `sync-mobile-from-renderer.sh` 的 COPY_MAP（整目录 copy composables/stores/components），重构时必须遵守：
> - **B4 Composer 合并**：useContenteditableInput 被吸收进 useComposerInput，mobile copy 了 composables 整目录——若 mobile 直接 import 被删文件，需保留 re-export 兼容层或同步更新 mobile。
> - **B5 Sidebar 拆分**：抽出的 useGlobalShortcuts/useSidebarTabCount 等，若放新子目录（features/sidebar/），COPY_MAP 整目录 copy 会自动带过去，但需确认无遗漏。
> - **B9 路径重组**：features/panel 按域分子目录后，COPY_MAP 的 `"composables:composables"` 整目录 copy 仍生效（copy 子目录），但**被删/合并的文件**会让 mobile 侧 import 断裂。建议 COPY_MAP 从整目录改为显式文件清单。
> - **MANUAL_FORK 锁定**：`composables/useConnection.ts` 是 mobile 的人工 fork（砍本地模式分支），B9 重组时**路径锁定不移动**，或同步更新 sync 脚本的 MANUAL_FORK 数组。

---

## 7. 阶段 0：测试基础设施（为重构护航）

> 详见 handoff §4 + v6-design §7。本节确认方向，测试规范细节以 TEST-STRATEGY.md 重写为准。

### 0.1 现状 [实测]

- 规模：505 文件 / ~4750 case
- **零 coverage 配置**（4 个 vitest.config.ts 均无 coverage 字段，@vitest/coverage-v8 装了没用）
- **E2E 完全不在 CI**（11 spec）
- 大量测试断言「内部调用/mock spy/payload」而非「用户可见行为」（api/ 全 10 文件）

### 0.2 动作

1. **启用 coverage + 设观察门槛**：起步只观察不卡（收集基线），逐步设 line/branch 阈值。
2. **E2E 进 CI**：mock 轨（不起 runtime，VITE_MOCK）快跑 + real 轨（真 runtime+pi）独立慢 job。
3. **补建 dev-smoke 闸门**：堵 mock 盲区，关键功能首屏渲染验证。
4. **重写 TEST-STRATEGY.md**：分层（单测/集成/E2E mock/E2E real）+ 断言标准（每条集成至少一个用户可见断言）+ 护栏门。
5. **关键功能 E2E 补建**（现状零覆盖）：对话流 chat-flow / session 生命周期 / 设置持久化（改→重启→恢复）。
6. **低价值测试删旧随重构同步**：删断言内部调用的测试（api/ 10 文件等），靠新行为测试覆盖，模块级原子化无空窗。

---

## 8. 实施波次与优先级

> 顺序已根据「renderer 是重点」修正。runtime（A1）降为暖身，renderer 编排层（B1-B3）提前。

```
阶段 0（测试基础设施，最先）
  0.1 coverage  →  0.2 E2E 进 CI  →  0.3 dev-smoke  →  0.4 TEST-STRATEGY 重写
  （0.1-0.4 可并行）

阶段 A（整体架构）
  A1 runtime 缝补（暖身，最机械，先做验证流程）
  A2 shared 下沉（机械移动）
  A3 IPC 收敛（proxy 命名 → 业务持久化迁移）

阶段 B（renderer 编排层，重点）
  B1 useChat 状态隔离（最高优，编排层中枢）
  B2 stores 契约修复（事件消费层抽出）
  B3 routeInbound 路由表

阶段 B（renderer 模块级）
  B4 Composer 合并
  B5 Sidebar 拆分
  B6 chat store 重组

阶段 B（renderer 整理级，低风险）
  B7 settings 重构（与 v6 视觉线协作）
  B8 ui/ 双名清洗
  B9 composables 分层

每波：独立 commit + 过测试门（coverage 不退 + CI 绿）+ 删旧测试随重构同步
```

**关键依赖**：
- 阶段 0 必须先于 B（无测试护栏不重构）
- B1（useChat）必须先于 B6（chat store）——状态隔离范式先固化
- B7 settings 形态部分依赖 v6 视觉线定稿（FullSettingsOverlay 视觉规格）
- A1/A2/A3 与 B 系列无硬依赖，可并行（A 是跨包清理，B 是 renderer 内部）

---

## 9. 验收基准

**架构**：
- runtime 三层契约：session 域零运行时业务直连（仅剩 logger 豁免 + pi-paths kernel + 扩展能力可后置）
- shared 包：barrel 不导出 Node-only 算法，renderer 依赖图可证明无 Node 逻辑
- IPC：45 → ~41 方法，业务数据 100% 走 runtime WS 单一出口
- renderer stores：零跨 store import，零 store→composable 倒置
- renderer composables：零 `reset*ModuleState`，零模块级 per-session Map/Set（除工厂内部）

**测试**：
- coverage 启用并进 CI
- E2E（mock + real 双轨）进 CI
- 对话流/session 生命周期/设置持久化有 E2E 覆盖
- 删除的测试对应功能有新行为测试覆盖（随重构同步，无空窗）

---

## 10. 文档同步清单（实施时更新）

- [ ] `docs/architecture/runtime-three-layer-design.md`：补 logger 豁免声明 + pi-paths kernel 归类 + ISessionStore 收口记录
- [ ] `ARCHITECTURE.md`：IPC 方法数 45→~41，通信边界表更新
- [ ] `docs/adr/0049-session-isolation-map-partition.md`：补 lint 规则 / code-review checklist
- [ ] `TEST-STRATEGY.md`：重写（阶段 0.4）
- [ ] `docs/page-design/v6-design.md` §6：本文档落地后回链

---

## 附：独立验证方法说明

本文档所有 `[实测]` 数字来自 5 个 explorer subagent 对源码的独立 grep/read 交叉验证，非 handoff 转述。关键验证点：
- services→infra 直连 22 处：grep `from '.*infra'` in services/ 逐文件核对
- renderer 零 import Node-only 解析器：grep `parseGitStatus|compileIgnoreRules` in renderer/src/ = 0
- electronAPI 45 方法：逐个读 preload.ts 的 contextBridge.exposeInMainWorld
- useChat 模块级状态：读 useChat.ts:45/52/66-83 原文
- bg-accent 98 处：grep `bg-accent` in components/ 计数

任何带数字的论断，实施前回到代码复核（handoff 数字失准教训）。
