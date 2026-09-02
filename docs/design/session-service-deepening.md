# SessionService 深化重构设计：拆解上帝类回归

> **一句话结论**：把 SessionService（2603 行 / 106 方法）按概念域逐域迁出为独立模块，同时归正依赖方向（写点随状态所有权走、宽接口 ISP 化）、补上行数守卫，消除「拆完还会再长回来」的三个结构引力。
>
> - **S（情境）**：Agent Runtime 是 xyz-agent 唯一的后端进程，SessionService 是 session 域核心服务；ADR-0002 曾删除 SessionPool 上帝类并将职责收口于此。
> - **C（冲突）**：架构走查（2026-09-02，四路并行 + 行号抽查验证）发现 SessionService 重新长成上帝类——7 个概念域与一个薄 Facade 同体，子模块经 21 方法宽接口回调本体，eslint max-lines 守卫对它显式关闭。
> - **Q（问题）**：怎么拆，才能让拆解结果不再被同样的引力重新长回去？
> - **A（答案）**：逐域增量迁出（而非一次性重写），每刀同时做三件事——迁实现、归正写点归属、收窄接口——并在收尾恢复行数守卫。本文展开这个答案。

## 0. 本次设计的层定位

- **当前层**：技术方案（SessionService 深化的目标形态、拆分策略、关键决策）。
- **下一层产物**：slice 级实现计划（§5 拆出 6 个 slice，各自独立可验收可回滚）。
- **层敏感准则适用性**：本设计涉及运行时行为（重构期的行为等价断言）与失败恢复，准则 5/6/7 全部适用；验收按准则 11 用真实场景。

---

## 1. 背景目标

### 1.1 系统是什么

Agent Runtime（`packages/runtime/`）是 xyz-agent 的 Node.js 后端进程：托管 pi 子进程生命周期、做协议翻译（pi stdin/stdout JSON RPC ↔ WebSocket）、负责 session CRUD 与配置持久化。分层为 transport（WS 入口与消息路由）→ services（业务核心）→ infra（pi 适配与系统 IO），手动 DI 在 `index.ts` 组装（ADR-0001）。

SessionService（`packages/runtime/src/services/session/session-service.ts`）是 session 域对 transport 层的统一入口：transport 的 41-case `SessionMessageHandler` 经 56 方法的 `ISessionService` 接口消费它。2026-05 重构（ADR-0002）删除了承担 5 种职责的 SessionPool 上帝类，把 session 生命周期收口到 SessionService，并把 convertPiHistory 提为纯函数。当时 SessionService 453 行，ADR 明确预警「仍有进一步拆分空间」。

### 1.2 问题定义（先于方案）

- **用户描述的问题**：架构审查要求回答「runtime 有哪些可优化的架构问题」，走查发现 SessionService 长到 2603 行 / 106 方法，是全场最大摩擦源。
- **这是不是真问题**：是。它不是「行数审美」问题，而是三个可验证的功能性伤害：① 测任一域要构造 10 个构造依赖 + 9 个 setter 的整个世界；② 理解「创建 session」「发送消息」必须在两个文件间对跳（编排在子模块、写点在 Facade）；③ 约束 C-comm-01「禁上帝类」被违反且守卫被关闭（`eslint.config.mjs` 对它 `max-lines: 'off'`，注释自述「属独立重构任务……长期应拆分」——本文档就是那个被推迟的任务）。
- **隐藏的根本问题**：为什么 ADR-0002 拆完后它又长了 5.7 倍？如果只做「再拆一次」而不回答这个问题，三年后还会再拆第三次。§2.3 给出根因：三个结构引力未除。

### 1.3 设计目标（从使用者——runtime 开发者——倒推）

- **G1 自然家**：新增一个 session 域功能时，存在明显的归属模块，不需要、也不被允许「顺手挂到 SessionService」。
- **G2 测试面收窄**：测 session 域任一概念，stub 面降到个位数方法；单域测试不再需要构造 Facade 全家桶。
- **G3 行为等价**：这是纯重构——renderer、pi、插件系统观察到的行为逐字节不变。
- **G4 不再复发**：拆解完成后有机器守卫阻止 Facade 重新膨胀。

### 1.4 In scope / Out of scope

**In scope**：`services/session/` 内 SessionService 与其子模块（lifecycle / dispatcher / scanner / interpreter / extractor 系）的边界归正与逐域迁出；`ISessionServiceInternal` 的 ISP 化；session-service.ts 的行数守卫恢复。

**Out of scope**：① 架构审查报告的其他候选（C2 EventAdapter 协议路由、C3 port 旁路、C4 JsonStore 收编、C5 transport handler 表驱动与胖接口拆分等）各自独立成文，本文只在决策衔接处标注交接点；② renderer 侧任何改动；③ IoC 容器（ADR-0001 明确禁止，不作为候选）。

---

## 2. 现状与问题分析

**本章结论：SessionService 不是「没拆」，而是「拆了一半」——编排迁出去了，写点和状态留在 Facade，子模块靠 21 方法宽接口回调本体；加上 transport 直摸 56 方法接口、行数守卫被关闭，三股引力让任何新 session 功能最省事的去处都是 Facade。**

### 2.1 现状（全部经行号核验）

SessionService 实测量：2603 行、106 个方法（方法签名 grep 计数）、9 个 `setXxx` 时序注入（session-service.ts:391-578，含委托型 setSendMessageHook:578）、9+ 块 per-session 私有 Map/Set。方法按概念域归类：

| 概念域 | 代表方法（行号） | 附属私有状态 |
|---|---|---|
| 会话注册表 + handoff | `initializeManagedSession`:1916 / `getSession`:1796 / `markHandedOff`:1813 | `sessions` Map |
| history 重建 | `getHistory`:942 / `doGetHistory`:952 / `getFullHistory`:1043 | historyCache、inflightGetHistory |
| subagent/workflow 记录 | `getSubagents`:1051 / `getWorkflows`:1186 / `invalidateRecordEntries`:755 + 缓存族 :767-884 | recordEntriesCaches |
| trace/system-prompt 同步 | `syncTraceEntries`:1252 / `pollOnceForPromptEntry`:1389 / `ensurePromptBaseline`:1374 | traceLeafCache、traceSyncChains |
| context/usage 副作用 | `applyContextUpdate`:1584 / `handleTurnEndSideEffects`:1620 / `fetchAndBroadcastContext`:2271 | — |
| replicated states 快照投影 | `registerReplicatedStates`:1993 / `fetchStateSnapshot`:2024 / `publishCommandsSnapshot`:2125 等 9 方法 | replicatedStates |
| 图片/附件/segment 存储 | `writeImage`:2292 / `migrateImage`:2346 / `writeSegmentsMetadata`:2381（约 310 行，占全文 12%） | — |
| launch 参数组装 | `getSkillPaths`:1664 / `getExtensionPaths`:1688 / `getLaunchPresetOptions`:1721 | — |
| 模型/思考等级 | `switchModel`:601 / `setThinkingLevel`:665 | — |

已迁出的三个子模块与 Facade 的关系（这是「拆了一半」的实证）：

- 构造期注入 self：`new SessionLifecycle(this, ...)`（session-lifecycle.ts:165 构造器五参，首参是 Facade）、`new MessageDispatcher(this, ...)`（message-dispatcher.ts:39 构造器四参，首参同上）。
- 回调通道 = `ISessionServiceInternal`（session-internal.ts:22，实测 21 个方法，接口内有按消费者的分组注释）。文件头注释自述存在理由：「打断模块级循环」——type-only import 打断了编译期模块环，但**运行期调用环真实存在**。注意：分组注释与实际消费关系并不一致（`fetchAndBroadcastContext` 被注释归在 dispatcher 组，但 lifecycle 的 restore 路径同样消费它——gate 测试 stub 为证），接口的真实消费面必须按调用点逐个数，不能按注释数。
- 写点外置的实例：lifecycle 的 create 流程走到末尾，注册新 session 的 `initializeManagedSession` 实现在 Facade:1916，不在 lifecycle 里。且它是**三个 per-session Map 的共同注册汇聚点**——除 `sessions.set`（:1966）外，还注册 replicatedStates（projection 域资产）与 recordEntriesCaches（record 域资产），附挂 modelCapabilityReconciler 对账回调与 send 通知闭包（bus/broker/onMessageComplete）。销毁侧的真实形态（经源码核验）：多 Map/多回调的清理汇聚点是 `removeSessionEntry`（:1837-——sessions.delete + historyCache/trace 缓存清理 + onSessionDelete/onSessionDestroyedHandlers 回调扇出）；而 `destroyAll`（:1654-1660，shutdown 路径）只做 detach adapter → pm.destroyAll() → sessions.clear()，不触碰其他 Map（进程将亡，各缓存随进程同灭）。`this.sessions` 全文 33 处出现：写点仅 3 处，其余 ~30 处是散布在 trace / projection / context 副作用 / 模型切换各域的读点。

### 2.2 真实失败模式

- **A. 测试的类型面被宽接口绑架**：`session-lifecycle-gate.test.ts` 测 lifecycle 门禁逻辑，真实消费只有 10 个方法，但 stub 必须 `as unknown as ISessionServiceInternal` 强转绕过 21 方法宽接口的类型检查（外加 IProcessManager / IConfigStore / ISessionStore / WorkspaceService 四个 mock）。接口每加一个方法，所有子模块测试的类型面就被牵连一次——哪怕新方法与被测路径毫无关系。
- **B. 理解一个概念要双文件对跳**：读「创建 session」——编排在 session-lifecycle.ts:create（157 行单方法），收尾写点却跳回 session-service.ts:1916。概念的「始」与「终」不在同一模块。
- **C. 新功能默认长进 Facade**：最近实例是图片/附件存储——`writeImage`（2292-2345）与 `migrateImage`（2346-）只用 `getAttachmentsDir` / `tmpdir` / `IMAGE_LIMITS` / `isStrictlyUnder`，与 sessions Map、bus、子模块**零共享状态**，却仍然住进了 SessionService。零耦合功能尚且如此，有耦合的更不必说。
- **D. 守卫被合法关闭**：`eslint.config.mjs` 对 session-service.ts 设 `max-lines: 'off'`（[HISTORICAL] 注释自述「短期 override 避免阻塞，长期应拆分」）——膨胀没有任何机器拦截。

### 2.3 根因分析：三个结构引力

1. **引力一：transport↔services 之间没有更深的海岸线。** 41-case handler 直摸 56 方法 `ISessionService`，任何 session 功能加进 SessionService 即可被 transport 立即消费——Facade 是阻力最小的路径。
2. **引力二：半深化拆分制造了回调环。** 编排迁出、写点留守，子模块要干活必须回调 Facade；于是「给 Facade 加方法」比「新建模块并接线」省事，方法持续净流入 Facade。
3. **引力三：守卫关闭。** max-lines 对 session-service.ts 失效，膨胀无机器信号，靠人自觉。

只拆不除引力 = 三年后拆第三次。本方案的每个 slice 都同时削引力（迁实现 + 归正写点 + 收窄接口），并在收尾恢复守卫。

### 2.4 物理调用流（写点外置的完整路径）

「创建 session」一次调用的真实路径（行号已核验）：

```
renderer session.create
  → transport/session-message-handler.ts（41-case switch 中一路）
    → SessionService.create（Facade 委托）
      → session-lifecycle.ts:265 create（157 行编排：门禁/模型解析/spawn 参数）
        ├─ 回调 ISessionServiceInternal（session-internal.ts:22，21 方法）：
        │    create 体内 `this.svc.` 调用 7 处（getLaunchPresetOptions / getExtensionPaths /
        │    getSkillPaths / getReplaceSystemPrompt / initializeManagedSession / toSummary /
        │    notifySessionCreated）
        └─ 收尾 → 回到 Facade initializeManagedSession（session-service.ts:1916）
                  三 Map 汇聚注册：sessions.set（:213 声明）+ registerReplicatedStates（:313）
                  + ensureRecordEntriesCache（:320）+ reconciler 回调 + send 通知闭包
```

「始」（编排在 lifecycle）与「终」（写点在 Facade）分置两文件——失败模式 B 的物理形态。

---

## 3. 解决方案

### 3.1 终态（开发者视角）

**本章结论：终态下 SessionService 只剩「装配 + 委托」，session 域由一组概念域模块组成；新增功能有自然家，单域测试只 stub 窄接口。**

终态模块地图（session 域）：

```
services/session/
├── session-service.ts        瘦 Facade：装配子模块 + 一行委托（目标 ≤500 行，恢复 max-lines 守卫）
├── session-lifecycle.ts      生命周期编排 + sessions Map 所有权与写点（registerSession）
│                             + 注册事件 onSessionRegistered（同步直发，订阅者组装根接线）；
│                             销毁无 lifecycle 事件——编排 wrapper 在 session-service.ts（第 ⑤ 步直调各域 onSessionDisposed）
├── message-dispatcher.ts     消息动作（sendMessage/abort/steer/compact）
├── session-scanner.ts        扫描（现状已内聚，不动）
├── attachment-store.ts       新增：writeImage / migrateImage / writeSegmentsMetadata（§2.1 附件域）
├── trace-sync.ts             新增：trace 编排半截（Facade:1206-1432）与 session-trace.ts 纯函数合并
├── session-state-projection.ts 新增：replicated states 快照投影族（Facade:1993-2197）
│                             + context/usage 副作用域（applyContextUpdate/handleTurnEndSideEffects/
│                               fetchAndBroadcastContext——可观察输出同为 session 级状态发布）
└── extractor 系 / event-interpreter.ts   不动（走查判定的健康样本）

状态注册的所有权切分（创建/销毁两侧机制不对称，按清理逻辑的质量分布归属）：
- 创建：lifecycle.registerSession（原 initializeManagedSession）在 sessions.set 后同步直发 onSessionRegistered(id)，
  订阅者（组装根接线）执行各域注册——S3 时是 Facade（按现状体内顺序），S5/S6 后是 projection/record 模块。
- 销毁：removeSessionEntry 编排权留 Facade wrapper（9 步体内顺序是行为等价的一部分）：summary 预取 →
  委托 lifecycle 删条目 → onSessionDelete → 插件 didDestroy 扇出 → 同步直调各域清理 → messageBus.clearSession
  垫底（:350 约束：exited publish 先于此）。
- destroyAll 是 shutdown 路径：进程将亡、缓存随进程同灭，现状不清理其他 Map——本方案保持该行为，
  不引入 dispose 通知，与 G3 行为等价一致。
```

终态下的开发者体验对比（以「给 session 域新增 X 能力」为例）：

- **现在**：改 session-service.ts（往 2603 行里找位置）→ 接口加进 ISessionServiceInternal（21 方法继续涨）→ 测试 stub 全套。
- **终态**：定位概念域模块（如 trace 相关 → trace-sync.ts）→ 只动该文件 → 测试只 stub 该域窄接口（lifecycle 域 ≤13，余域更少）。若情不自禁想往 Facade 挂，max-lines 守卫在 pre-commit 拦下。

失败路径体验（重构期）：任一 slice 测试红或发现隐藏耦合 → 该 slice 整体回滚（每 slice 独立 commit），已完成的 slice 不受影响；具体恢复动作见 §3.4。

### 3.2 方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 逐域增量迁出（strangler 式）**：每刀迁一个域，同时归正写点 + 收窄接口；Facade 渐进瘦身，最后恢复守卫 | 终态形态清晰；每 slice 削一股引力；extractor 系是已验证的形态样本 | 单 slice 小（第一刀 ~310 行机械搬移）；6 个 slice 各自独立交付 | 低：每 slice 测试绿才前进；单 slice 可整体回滚 | ✅ 选 |
| **B. 一次性 big-bang 重写**：一次 PR 把 2603 行拆成 7 模块 | 终态同 A | 单 PR 巨大；106 方法 + 全部 session 测试同时动 | 高：行为等价证明困难；与并行开发冲突（session 域是热点）；review 不可行 | ❌ |
| **C. 不拆，只加守卫/纪律**：恢复 max-lines + 发文要求「新功能别挂这」 | 引力一、二原样存在——宽接口和写点外置继续把方法吸进 Facade；纪律对抗结构引力必败 | 最低 | 名义成本最低，实际最高：症状暂停，根因还在 | ❌ |

**推荐 A**。理由：本问题的根本是「结构引力让 Facade 净流入方法」，A 是唯一每步都在削引力的方案；B 的终态形态与 A 相同但把等价性风险集中在一次交付；C 只压症状（准则 0：只解决表面问题的方案不合格）。

**被否方案的代价具象化**：若用 B，§2.4 的创建路径会在一次 PR 里同时改 5 个文件的行为链路，等价性只能靠「测试全绿」一句断言担保，任何一处隐藏耦合（如 §2.1 trace 域的两个缓存 Map）都变成全有或全无的发布风险；若用 C，失败模式 C（writeImage 式零耦合功能住进 Facade）会继续发生，因为「省事路径」没有变。

### 3.3 关键决策与权衡

**D1：零耦合域先行——附件存储是第一刀（选定）**
- **采用**：slice 1 只迁 `writeImage` / `migrateImage`（+ `writeSegmentsMetadata` 经探针 P2 核验后同批）为独立 `attachment-store.ts`。
- **被否**：先拆大的（trace 域 / projection 族）——首刀要验证的是「迁移模式」本身（测试随迁、Facade 委托保留、import 涟漪范围），零耦合域把变量减到最少。
- **证据**：§2.2 失败模式 C——writeImage 方法体（2292-2345）经走查定段阅读确认只用路径工具与 mime 校验，零 sessions Map/bus/子模块依赖；writeSegmentsMetadata 方法体未核验，标为探针 P2（证据不足不声称，准则 7）。
- **效果**：G1/G2 立得一个完整样本；SessionService 立减 ~310 行（12%）。

**D2：依赖方向归正——写点随状态所有权走，注册扇出用窄事件而非回调 hub（选定）**
- **采用**：分三步归正。① `ISessionServiceInternal`（21 方法）按**逐文件去重调用点实测**（`grep -o 'this\.svc\.'`）拆分：lifecycle 13 / dispatcher 6 / scanner 2，其中 4 个方法跨消费者共享（detachSession/getSession/removeSessionEntry 被 lifecycle+dispatcher 共用，getActiveSummaries 被 lifecycle+scanner 共用）——共享方法按消费者在各窄接口**重复声明、单一实现**（真 ISP：scanner 可见面 = 实际消费的 2 个；类型声明重复 ~7 行是可接受成本）。21 方法中 4 个的消费者不在三子模块内，不进入任何窄接口：`applyContextUpdate`/`handleTurnUsageSideEffects`/`handleTurnEndSideEffects` 由 event-interpreter 经组合根回调注入消费（event-interpreter.ts:75/78/83 实证），留在 Facade 的组合根接线面（S5 迁 projection 域时随迁）；`markHandedOff` 由 handoff-service 消费（handoff-service.ts:282 实证；该方法现仅声明于 internal 接口、不在 ISessionService 56 方法内，handoff-service:31 绑定具体类）：S2 将其迁至 ISessionService（对外接口 +1 行，属迁移非新增业务方法，与 D3 不冲突——D3 约束 slice 完成后不再新增）；备选「为 handoff-service 定义更窄消费接口」被否：单消费者场景收益低于接口面成本。② `initializeManagedSession` 与 `sessions` Map 所有权迁入 SessionLifecycle；Facade 残留域的 ~30 处 `this.sessions` 读点统一改道 lifecycle 暴露的查询接口 `ISessionRegistry`（按读点形态归纳为 get/has/keys 迭代/values 迭代 4 种，≤6 方法可期；**Map 结构只读**——无 set/delete/clear——**元素视图沿用现状可变语义**，IManagedSessionView 字段写不包不可变壳），Facade 对外查询方法退化为一行委托；写/删操作（removeSessionEntry 级）不经 Registry，由 Facade 委托 lifecycle（Map 所有者）。③ 三 Map 汇聚拆分（创建/销毁两侧机制不对称，按清理逻辑的质量分布归属）：**创建侧** initializeManagedSession 迁入 lifecycle（内部名 registerSession：session 对象构造 + sessions.set + onSessionRegistered 同步直发——直接方法调用扇出，禁异步 bus/microtask）；订阅链路在组装根接线，S3 时订阅者是 Facade（按现状体内顺序执行 registerReplicatedStates → ensureRecordEntriesCache → reconciler，与现状逐一等价），S5/S6 后订阅者换成 projection/record 模块自身；adapterFactory/send 闭包经窄依赖随迁；订阅扇出不设异常隔离、异常直接传播（与现状体内顺序调用等价，reconciler 自身 fire-and-forget 除外——现状如此）。**销毁侧** removeSessionEntry 的编排权留在 Facade wrapper——其体内 9 步顺序是行为等价的一部分（:1837-1890 实测）：①summary 预取 → ②委托 lifecycle 删 Map 条目（所有者执行，纯删除不发事件）→ ③onSessionDelete → ④onSessionDestroyedHandlers 扇出（插件 didDestroy）→ ⑤在此位置同步直调各域清理（现状 = Facade 内联的 historyCache/trace 缓存/replicatedStates dispose/recordEntriesCaches/lastPublishedStateChanged；S4/S5/S6 后 = 对应域模块的 onSessionDisposed 方法，组装期接线）→ ⑥messageBus.clearSession 垫底（:350 硬约束：session.exited publish 必须先于本方法，clearSession 之后再 publish 等于送空集合）。被否「lifecycle 拿走整条删除编排」：会把 dispose 提前到插件 didDestroy 回调之前（现状相反，处理器将读到已 dispose 实例 = G3 级时序偏移），且把 Facade 域回调注册表与缓存清理卷入 lifecycle。destroyAll 是 shutdown 路径（现状只清 sessions Map），不引入 dispose 通知——保持 G3 行为等价。`notifySessionCreated(summary)` 不并入该通知：两者语义与时机不同（注册发生在 toSummary 之前，无 summary 可发；plugin 域公告需完整 summary 且在 return 前），各自保留，不为收敛而加机制。
- **被否**（含被击穿的早期形态，记录以免重提）：
  - 「按文件分组注释划分窄接口（lifecycle 12 / dispatcher 7 / scanner 2）」——被调用点实测击穿：lifecycle 实为 13（getActiveSummaries:574 被注释归入 scanner 组实为 deleteByCwd 消费；detachSession/removeSessionEntry 跨组共用），且注释分组遗漏 interpreter/handoff 两个真实消费者。接口划分只能按调用点矩阵，不能按注释。
  - 「整方法原样搬入 lifecycle」——被三 Map 汇聚结构击穿：`registerReplicatedStates`（projection/S5 域资产）与 `ensureRecordEntriesCache`（record/S6 域资产）会被迫一并迁移，S3 scope 渗入 S5/S6，与 slice 解耦（D6）直接矛盾。
  - 「lifecycle 经 ISessionServiceInternal 回调 Facade 完成两 Map 注册」——引力二以新形式残留：回调 hub 换个名字回来，接口面不降反升。
  - 「共享基座接口被三窄接口 extend」——被 ISP 纯度检查击穿：基座让 scanner 可见面 5 ≠ 实际消费 2（类型面获得从不使用的删除权），与 G2「stub 面 = 消费面」矛盾；改为按消费者重复声明。
  - 「只做接口 ISP，写点留 Facade」——失败模式 B（双文件对跳）不消失，引力二只削一半。
- **证据**：调用点矩阵（lifecycle 13 / dispatcher 6 / scanner 2 / interpreter 回调 3 / handoff 1，共享 4 方法）经 `grep -o this.svc.` 逐文件去重实测；removeSessionEntry 清理汇聚点实装（:1837-，sessions.delete + historyCache/trace 缓存 + 回调扇出）；destroyAll 实装（:1654-1660，仅清 sessions Map）；session-service.ts:1916-1985 三 Map 汇聚实测；`this.sessions` 全文 33 处（写 3：set:1966/delete:1844/clear:1659；读 ~30，形态归纳 get/has/keys 迭代:715/values 迭代:1655,1904,1909）。
- **效果**：失败模式 B 消灭（创建概念的始与终同模块）；G2 达成路径可判定——gate 类测试 stub 从「类型面 21 / 强转绕过」收窄为「窄接口 = 实际消费面」；S3 一次性建立的通知 seam 让 S5/S6 变成「换订阅者」而非「再拆一次」。

**D3：Facade 终态 = 装配 + 委托，不再新增业务方法（选定）**
- **采用**：所有 slice 完成后，SessionService 只承担「构造子模块 + ISessionService 委托」；业务方法新增必须落在概念域模块。transport 侧 `ISessionService` 的消费域拆分属 C5 候选范围，本文只做 session 域内归正，衔接点：域模块接口即未来消费域接口的原材料。
- **被否**：拆完即收工、不管 transport 接口——引力一（41-case handler 直摸 56 方法接口）仍在，新功能仍可经 Facade 加方法被 transport 立即消费。
- **证据**：§2.3 引力一；transport 走查发现 ISessionService 56 方法 / IConfigService 63 方法（interfaces.ts:128-344 / 350-519）。
- **效果**：G1 成立的前提；为 C5 备料但不越层实施（准则 10）。

**D4：测试与代码同批随迁（选定）**
- **采用**：每迁一个域，该域测试同批迁移/新建；禁止「代码拆走、测试留在原处测旧入口」。迁移完成的判定含「新模块有直接测试面」。
- **被否**：先拆代码后补测试——pi 适配层走查发现的「拆代码不拆测试」漂移实例（pi-provider-store 拆分后三个拆出模块零直接测试；session-file-utils 测试已按域分家而代码没有）证明后补会赖账。
- **证据**：pi-adapter 走查发现 #3/#7；本区域正例 counter-sample：extractor 系纯函数 + 独立测试（subagent-extractor×3、workflow-extractor×2）。
- **效果**：G2 不被掏空；探针 P3 的定义依据。

**D5：收尾恢复行数守卫（选定）**
- **采用**：最后一个 slice 把 session-service.ts 从 `eslint.config.mjs` 的 `max-lines: 'off'` override 清单移除（该 override 注释自述「长期应拆分」，本文即该任务的兑现）；目标 ≤500 行。
- **被否**：改为登记一条纯文档约束（constraints.json）——C-comm-01「禁上帝类」早已登记，照样复发；没有机器信号的约束管不住引力。
- **证据**：§2.2 失败模式 D（eslint.config.mjs override 段实测）。
- **效果**：G4 成立；event-adapter.ts 在同一张 override 清单上，其守卫恢复归 C2 候选收尾，本文不动。

**D6：slice 间解耦交付，不追求一次拆完（选定）**
- **采用**：6 个 slice 各自独立 PR、独立验收、独立可回滚；slice 2 之后的排序允许按并行开发冲突情况调整。
- **被否**：排死顺序串行推进——session 域是并行开发热点，僵硬的顺序会把重构变成阻塞源。
- **证据**：ADR-0002 教训的正面利用——当年「整体删除 SessionPool」一次完成是因为只 472 行；本次 2603 行 + 21 方法回调环，量级不同。
- **效果**：风险摊薄；任一 slice 发现问题不牵连已交付部分。

### 3.4 错误与恢复（重构期失败场景）

| 失败场景 | 信号 | 恢复动作 |
|---|---|---|
| 迁移中发现目标方法有未预期耦合（如 P2 探针发现 writeSegmentsMetadata 依赖 Facade 状态） | 探针失败 / 编译错 | 该方法留 Facade，slice 范围收缩后在 slice 描述中记录耦合点；不强行迁 |
| slice 测试红且 30 分钟内定位不到 | `pnpm vitest` 红 | 该 slice 整体 `git revert`（每 slice 独立 commit），回到绿基线再分析 |
| 行为等价被破坏（验收场景 1 与 main 分支行为分叉） | §4 场景 1 比对失败 | 停止后续 slice；回滚当前 slice；把分叉点记入该 slice 的探针清单再重做 |
| 写点归位（slice 3）后 create/restore/fork 任一路径异常 | P4 探针失败 | 降级为半深化形态：写点留 Facade、lifecycle 经窄接口调用——D2 的接口收窄成果保留，写点迁移放弃并记录原因。**降级对后续 slice 的影响**：S5 迁出的 projection 模块读 sessions 统一经 S2 建立的窄查询接口（不新增回调方法族），Map 单写者仍由 Facade 担任，读通道与现状等价——S5 成立，但 G2 对 lifecycle 的收窄效果打折，在 S5 实施文档中如实记录；若连窄查询接口也不成立，S5 暂停并重新评估 |

### 3.5 探针清单（运行时/等价性断言，准则 7）

| ID | 验证的断言 | 探针 | 状态 | 失败降级路径 |
|---|---|---|---|---|
| P1 | writeImage / migrateImage 与 sessions Map、bus、子模块零耦合 | 走查定段阅读方法体（2292-2345、2346-）+ grep 方法体内无 `this.sessions`/`this.messageBus` | ✅ 已验证（架构走查） | — |
| P2 | writeSegmentsMetadata 同样零耦合 | slice 1 实施前读方法体（2381-2422），grep 同上 | ⛔ slice 1 门 | 失败 → 留 Facade，slice 1 只迁两个 image 方法 |
| P3 | 每 slice 迁移后行为等价：runtime 测试套件的**行为断言不修改**而通过；stub 类型引用、接口 import 与 stub 成员面允许随接口拆分随迁（S2 预期：stub 面从 10 收窄到窄接口实际消费数，`as unknown as` 强转消失） | `pnpm vitest` 全绿 + 行为断言 diff 为空 | ⛔ 每 slice 门 | 失败 → 回滚该 slice（§3.4） |
| P4 | 写点归位后行为等价：create/restore/fork 三路的 sessions Map 注册、onSessionRegistered 扇出（projection 播种/record 注册/reconciler 对账）与 notifySessionCreated 公告时序逐一一致且同步直发（异常传播路径一致：订阅扇出不设异常隔离）；**销毁侧 removeSessionEntry 九步内部时序逐段比对**（summary 预取 → 委托删条目 → onSessionDelete → didDestroy 扇出 → 各域清理 → clearSession 垫底；:350 约束 session.exited publish 先于 clearSession 成立），destroyAll 保持现状不触发 | slice 3 内跑 lifecycle 既有 10+ 专项测试 + §4 场景 1 实跑 | ⛔ slice 3 门 | 失败 → 半深化降级（§3.4 末行） |
| P5 | 收尾时 session-service.ts ≤500 行且 max-lines override 可移除 | `wc -l` + 移除 override 后 `pnpm run lint` 绿 | ⛔ slice 6 门 | 失败 → 保留 override 并把残余行数构成写成下一候选的输入 |

---

## 4. 验收（真实场景，非单测非 mock）

**本章结论：验收分两层——每个 slice 的等价性验收（真实 app 行为比对），与整体收口验收（开发者体验 + 守卫生效演示）；单测全绿只是门槛，不算验收。**

### 4.1 Slice 级等价性验收（每个 slice 都做，回溯 G3）

- **场景**：开发者在 `pnpm dev` 启动的真实 xyz-agent 应用里完成一轮 session 全流程：新建 session → 发送文本消息 → 发送带图片的消息 → fork 该 session → 关闭重开（restore）→ 删除。
- **步骤**：同一组操作先在 main 分支构建的 app 跑一遍记录行为（消息流内容、图片显示、fork 后历史一致、restore 后状态完整），再在实施了 slice 的分支跑一遍。
- **通过标准**：两轮行为逐项一致；附件 slice（S1）额外要求：图片文件落盘位置与内容不变、renderer 图片气泡正常显示、landing 降级路径（无 session 时 tmpdir 暂存 → 创建后 migrateImage 迁移）实测走通。运行时探针 P3（测试套件）作为前置门槛，不计入验收本身。

### 4.2 整体收口验收（全部 slice 完成后，回溯 G1/G2/G4）

- **场景 A（回溯 G1 自然家）**：模拟一次「新增 session 域能力」演练——给 trace 域加一个**需要对 renderer 暴露**的导出方法（走主路径：引力一所指的常态路径，不选内部能力的例外情况）。通过标准（逐项可判定，以 `git diff --stat` + diff 内容裁决）：改动闭合于 ① `trace-sync.ts` 与其测试文件；② `interfaces.ts` 的 ISessionService 加一行接口方法；③ `session-service.ts` 仅加一行委托——diff 中除该委托行外无其他任何改动（无业务逻辑增量）；④ `session-message-handler.ts` 加一个 case。任一文件出现标准外改动即不通过。（说明：③④ 的形态在 C5 候选落地后会变为域接口注册，本验收以当前结构为准。）
- **场景 B（回溯 G2 测试面）**：新模块的直接测试实跑：attachment-store 的边界用例（20MB 上限、路径穿越拒绝）直接对模块测试，不经 WS 链路、不构造 Facade；lifecycle 的 gate 类测试从「类型面耦合 21 方法宽接口（`as unknown as` 强转，实 stub 10 方法）」收窄为「stub 面 = lifecycle 窄接口实际消费面（≤13），强转消失」。通过标准：`packages/runtime` 全量 `pnpm vitest` 绿；gate 测试文件 grep 无 `as unknown as ISessionServiceInternal`；attachment-store 测试文件的 import 不含 session-service。
- **场景 C（回溯 G4 守卫，负面验证）**：往 session-service.ts 里加 50 行无关注释提交。通过标准：pre-commit 的 max-lines 规则拦截该提交（守卫生效的负向证明）；同时 §4.1 全流程复跑一遍仍与 main 一致（守卫恢复没顺手改坏行为）。

### 4.3 验收投入说明

本次是 2603 行核心服务的行为等价重构（大改动），投入多场景真实验证；其中 4.1 是每 slice 的重复动作，4.2 是收口一次性动作。renderer、pi、插件均为真实运行实例，无 mock。

---

## 5. 下一层拆分

**本章结论：6 个 slice，按「先验证迁移模式、再归正依赖方向、后收尾守卫」推进；每个 slice 可独立验收（§4.1）与回滚。**

| Slice | 内容 | Justification（为什么这么拆） |
|---|---|---|
| S1 | 附件存储迁出：`writeImage`/`migrateImage` → `attachment-store.ts`（`writeSegmentsMetadata` 过 P2 后同批）；Facade 保留一行委托；测试随迁 | D1：零耦合域验证迁移模式，变量最少 |
| S2 | `ISessionServiceInternal` ISP 化：按逐文件去重调用点实测拆 lifecycle 13 / dispatcher 6 / scanner 2 三个窄接口，4 个跨消费者共享方法按消费者重复声明、单一实现（真 ISP：scanner 可见面 = 2）；interpreter 消费的 3 方法留在组合根接线面；markHandedOff 迁 ISessionService（对外接口 +1 行，迁移非新增）；子模块构造器改收窄接口 | D2 前半：接口收窄不动写点，风险与 S3 分离 |
| S3 | 写点归位：initializeManagedSession 迁入 lifecycle（registerSession）+ sessions Map 所有权随迁；汇聚拆分——创建侧 onSessionRegistered 同步直发（订阅者组装根接线），销毁侧 removeSessionEntry 编排权留 Facade wrapper（9 步时序契约，第 ② 步委托 lifecycle）；Facade 残留域 ~30 处 `this.sessions` 读点改道 lifecycle 的查询接口（ISessionRegistry） | D2 后半：依赖方向归正。本方案风险最高的一刀（写点迁移 + 汇聚拆分 + 读点改道三位一体），单独成 slice 便于回滚降级（§3.4）；工作量按三件套计，不按「搬一个方法」计 |
| S4 | trace 合并：Facade 编排半截（1206-1432）+ `session-trace.ts` 纯函数 → `trace-sync.ts`；补编排层直接测试（当前零覆盖） | 概念 locality：一个概念一个模块；顺带有测试缺口 |
| S5 | 状态投影迁出：replicated states 快照族（1993-2197）+ context/usage 副作用域（applyContextUpdate:1584 / handleTurnEndSideEffects:1620 / fetchAndBroadcastContext:2271）→ `session-state-projection.ts`；订阅者从 Facade 换为 projection 模块自身 | 两域的可观察输出同为「session 级状态向 renderer 发布」，同族合并；排 S3 后——通知 seam 已在 S3 建立，本 slice 只换订阅者；降级分支下的形态见 §3.4 |
| S6 | 收尾：残余域（history 缓存族 / record 缓存族 / launch 参数组装 / 模型切换）逐域评估归属或留下并写明理由；移除 max-lines override（P5）；ISessionService 消费域拆分移交 C5 候选 | 剩余域互相独立性低，合并评估避免过度拆分 |

**文件改动地图**：
- 新增：`services/session/attachment-store.ts`、`trace-sync.ts`、`session-state-projection.ts`（及各自测试文件）。
- 改写：`session-service.ts`（2603 → ≤500）、`session-lifecycle.ts`（写点接入 + Registry 查询接口 + 注册/销毁通知发布）、`session-internal.ts`（21 方法 → 3 个窄接口 + `ISessionRegistry`）、`message-dispatcher.ts`（构造器收窄）、`eslint.config.mjs`（删 override 段）。
- 不动：extractor 系、`event-interpreter.ts`、`session-scanner.ts`（走查判定的健康样本）。
- 待同步：若 `ISessionServiceInternal` 更名/拆分，消费方 import 与 ADR-0049 相关注释批量随迁。

**待验证检查点**（设计期无法确定，实施期必验）：
1. P2：writeSegmentsMetadata 的耦合面（决定 S1 范围）。
2. S3 中 `sessions` Map 的全部读写点清单（grep `this.sessions` 穷尽，实测 33 处：写 3 / 读 ~30）：每处读点映射到 ISessionRegistry 的具体查询方法（无对应方法 = 接口设计缺口，回到 S2 补）；写点 3 处逐一核对归属；removeSessionEntry 拆管时 9 步体内顺序逐段归属核对（lifecycle 只承接第 ② 步 Map 删除，①③④⑤⑥ 均留 Facade wrapper 或随域迁出）；destroyAll 为 shutdown 路径现状不清理其他 Map，不引入 dispose 通知。
3. S6 各残余域的最终归属——以 S1-S5 完成后的实际行数构成决定，不预判。

---

## 附录

- **溯源**：本文档源于 2026-09-02 runtime 架构走查（4 路并行探索 + 关键论断行号抽查），审查报告 HTML 在 `$TMPDIR/architecture-review-20260902-133837.html`；本文档自包含，不依赖该报告。
- **术语**：Module/Interface/Depth/Seam/Locality 取 `improve-codebase-architecture` skill 的定义；Facade 指 SessionService 的「装配 + 委托」形态；「写点」指 per-session 状态的实际写入位置；「ISP」= 接口隔离原则（按消费者拆窄接口）。
- **关联约束与 ADR**：C-comm-01（三层单向无环、禁上帝类）、ADR-0001（手动 DI）、ADR-0002（SessionPool 删除，本设计的上游）、ADR-0049（per-session Map 分区——写点归位须保持其范式）、ADR-0055（MessageBus，本设计不动消息通道）。
