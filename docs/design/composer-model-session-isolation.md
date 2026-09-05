# composer per-session 模型/思考档位状态隔离与持久化

> **一句话结论**：per-session 模型/档位状态没有任何持久层，「全局默认」又被设计成跟随任意 session 的最后一次切换——切走再切回（尤其 pi 进程退出/app 重启后），session 自己的模型只剩空串占位，composer 兜底显示的就是被别的 session 污染的全局默认。修复 = 独立 sidecar（`.model.json`）持久化 per-session 终态 + restore 读回真值播种 + 全局默认与 session 级切换解耦 + 档位对齐 watch 加「显式切换」门禁。

- **层性质声明**：本文档是技术方案设计（slice 级），下一层产物 = 可实现的接口/数据模型/代码任务。准则 5（物理数据流）/6（错误恢复）/7（运行时断言探针）全适用。
- **状态**：已过 4 轮对抗式审查（r1：3 must-fix + 4 suggestion 全修；r2：0 must-fix + 3 suggestion 当轮吸收；r3：1 must-fix + 3 suggestion——must-fix 为 impl-plan U5 blocked 误诊更正，设计 D5 本体裁决无缺陷；r4 聚焦复审：r3 修复全部核验通过，2 must-fix 跨文档文字残留已修，审查方结论「无需 r5，设计就绪」。报告 `docs/design/composer-model-session-isolation.review-r1.md` / `.review-r2.md` / `.review-r3.md` / `.review-r4.md`）。**DoR 达成，可进入实施**。

---

## §1 背景目标

**SCQA**：

- **S（情境）**：xyz-agent 的 composer 工具条上，每个 session 可独立选择模型与思考档位；u3 设计（`docs/design/model-thinking-level-memory.md`）刚加了「per-model 档位记忆表」——切回某模型自动恢复上次档位。
- **C（冲突）**：用户在 session A 用 glm-5.3 对话，切到 session B 把模型换成 glm-5.3-flash，再切回 A——composer 显示的模型变成了 glm-5.3-flash。同时「切模型自动恢复上次档位」也不稳定：切 session 焦点时档位会被莫名改写。
- **Q（问题）**：为什么 session 间会互相污染？如何让「每个 session 独立的模型/档位配置」真正成立？
- **A（答案）**：per-session 模型/档位只存在于「pi 进程存活期间的内存」，无持久层；退出后退化为扫描占位空串，而 composer 对空串的兜底是「全局默认」，且全局默认被 runtime 设计成跟随任意 session 的最后一次切换。修复打四层：持久化（独立 sidecar `.model.json`）、restore 播种真值、兜底收紧（未知显示未知而非假值）、污染源解耦（全局默认不再跟随 session 级切换）；另给档位对齐 watch 加「显式切换」门禁，消灭切焦点改写档位。

**系统是什么**（给不熟悉本仓的读者）：composer 是聊天面板底部的输入区，工具条上有两个 popover——模型选择（ModelSelectPopover）与思考档位（ThinkingLevelPopover）。composer 有三种态：**已建 session**（对话中，读该 session 自己的真值）、**landing**（新任务未建，读本地暂存值）、**staging**（fork/handoff 暂存试选）。session 级状态分三层存放：

```
pi 进程内存（权威） ──RPC──> runtime 内存 Map（ManagedSession.modelId/thinkingLevel）
                                │
                                ├─ 快照实例（ReplicatedState，get_state 拉取）
                                └──广播（session.state_changed / config.sessions）──> renderer store（SessionSummary）
```

每开一个 session 就 spawn 一个独立 pi 子进程；进程退出（用户重启 app、开发期改 runtime 代码重启 `pnpm dev`、崩溃）后该 session 从「内存态」退化为「磁盘扫描态」。

**设计目标**（从使用者体验倒推）：

- **G1 会话模型跨退出保持**：session A 用 glm-5.3，无论 A 的 pi 进程退出过、app 重启过，切回 A 时模型 chip 显示 glm-5.3。
- **G2 档位记忆准确**：切到模型 M 时自动恢复「上次用 M 的档位」，且这个记忆不被切 session 焦点等非用户动作污染。
- **G3 会话档位独立性**：切换 session 焦点（A→B→A）不改变任何 session 的档位，也不对 pi 发多余的 setThinkingLevel。
- **G4 无假值显示**：任何时刻，composer 不显示「别的 session 的模型/档位」冒充本 session 的；不知道就显示未知占位，而非静默替换成全局默认。

**In scope**：

- per-session 模型/档位状态的持久化与恢复（runtime + core + renderer 显示层）
- 全局默认模型与 session 级模型切换的解耦（含 landing 新任务默认模型的显式化）
- 档位对齐 watch 的「显式切换」门禁（u3 设计登记过的「关联发现」欠账）
- 与上述行为绑定的文档/注释漂移修正

**Out of scope**：

- per-model 档位记忆表本身的机制（u3 已实现，本文只修它的污染源）
- runtime/pi 协议改动（不新增 RPC；sidecar 属 runtime 本地文件）
- 模型能力注册表、pattern 引擎静默换模的治理（已有 C-pi-13 回执生效值机制）
- 档位记忆的管理 UI、per-project 维度记忆（u3 D6 已否）

---

## §2 现状与问题分析

> **行号口径声明**：本章 file:line 行号为设计时快照（Before 分析），实施后行号已漂移，符号名仍可解析；处置见 impl-plan R4。

**现状结论：per-session 模型/档位状态只活在「pi 进程存活期间的内存」里；进程一退，renderer 手里的值被整表广播抹成空串占位；composer 对空串的兜底是被 session 级切换污染的全局默认。**

### 2.1 使用者视角的现状（真实复现，日志实证）

用户今天（2026-09-04）的真实使用轨迹（`~/.xyz-agent/logs/runtime-2026-09-04.log`）：

```
02:39:25 session 01a06a49-035e → model.switch glm-5.3-flash
02:41:51 session 01a06a4b-3dbb → model.switch glm-5.3
02:45:52 session 01a06a49-b050 → model.switch glm-5.3-flash
03:05:14 session 01a06a60-a51f → model.switch glm-5.3
03:08:02 session 01a06a5d-2fd8 → model.switch glm-5.3-flash
03:11:17 session 01a06a66-2fc2 → model.switch glm-5.3
03:20:43 session 01a06a6e-d246 → model.switch glm-5.3
03:22:15 十个 pi 进程被 SIGTERM（code 143）——runtime 重启
03:28:34 ensureActive: restoring 01a06290-…（用户切回旧 session，触发 restore）
03:28:43 ensureActive: restoring 835c6577-…
03:28:44.086  switch_session（pi 附着会话文件）
03:28:44.163  set_thinking_level   ← get_state 批次(.134/.135)后约 30ms、switch_session 后 77ms——非用户手动操作
```

用户全天在两个模型的多个 session 间跳，且开发流程（改 runtime 代码→重启 `pnpm dev`）让「进程退出→再切回」成为高频路径。

### 2.2 失败模式

**失败模式 A（模型串台，命中 G1/G4）**：A 用 glm-5.3 对话 → 切到 B 换成 flash → 切回 A，composer 显示 flash。

**失败模式 B（档位被改写 + 记忆污染，命中 G2/G3）**：切回 A 的瞬间（03:28:44.163），一个 `setThinkingLevel` RPC 自动发出，改写了刚恢复的 session 自己的档位；被改写的值随后写入全局 per-model 记忆表。

### 2.3 根因分析（六个机制，均经源码核实）

**术语定义**：
- **全局默认（defaultModel）**：用户在 Settings 页配置的默认模型，真源 = pi 的 `~/.xyz-agent/pi/agent/settings.json`（`defaultProvider`/`defaultModel` 字段）。
- **扫描占位（W15 占位）**：磁盘 session（pi 进程不在）的 summary 中 `modelId: ''`——这是「读不出真值」的占位，不是权威空值（`session-scanner.ts:85`）。
- **粘滞默认**：u3 设计依赖的行为——任意 session 切模型后，「全局默认」跟着变成刚切到的模型，landing 新任务默认模型即最后切换的模型（`docs/design/model-thinking-level-memory.md` §1 Out of scope 段）。
- **sidecar**：session 会话文件（JSONL）旁的伴生元数据文件。现状是**一个字段族一个独立文件**：`.meta.json`（终态 outcome，`persistSessionEnd` 全量覆写）、`.preset.json`/`.project.json`/`.agent.json`（绑定字段，`persistBindingSidecar` 家族骨架：原子写 + 缓存失效 + JSONL 存在性守卫）。

**机制 ①：session 级切模型污染全局默认（污染源）**。`packages/runtime/src/services/model-service.ts:88-108`：`ModelService.switchModel` 在 session 级切换后**无条件**广播 `config.defaults { defaultModel: <刚切到的模型>, source: 'model-switch' }`；renderer 侧有**两个**消费点：`packages/core/src/domain/settings/settings-lifecycle.ts:73`（写入 `settingsStore.defaultModel`）和 `packages/renderer/src/components/settings/provider/ProviderPage.vue:369`（`onDefaultsWithSource`——非用户主动 `default-set` 且值变化时弹 toast「默认模型自动更新」）。→ 在 B 切到 flash 的那一刻，renderer 的全局默认变成 flash；Settings 页开着时还会弹「默认模型已自动更新」的误导性 toast（机制 ① 的又一症状）。

**机制 ②：per-session 模型无持久层，退出即抹空**。pi 进程退出 → `session-service.ts:302` `removeSessionEntry` 删 runtime Map 条目 → 整表广播 `config.sessions`，A 的 summary 来自扫描器，`modelId: ''`（`session-scanner.ts:85`）。renderer 整表替换分支（`packages/core/src/domain/session/store.ts` `applySnapshot` 整表形态）**没有 W15 占位守卫**（守卫只在单条 `mergeViewSnapshot` 里）——A 之前已知的 glm-5.3 被直接替换成 `''`。

**机制 ③：composer 对空串兜底到被污染的全局默认（显示机制）**。`packages/core/src/domain/composer/model-thinking.ts:189`：

```ts
const regularModelId = computed(
  () => sessionState.value?.modelId || currentModel.value || defaultModel.value || '',
)
```

`''` 是 falsy → 对**已建 session** 也兜到 `flow.currentModel`（landing 单例残留）或 `defaultModel`（= 机制 ① 的 flash）。档位有同构的小型污染路径：`regularThinkingLevel = sessionState?.thinkingLevel ?? localThinkingLevel`——已建 session 档位 undefined 时回落本 composer 实例的 landing 残留值。

**机制 ④：restore 播种的是全局默认而非真值（放大窗口）**。切回死 session → `session.switch` → `ensureActive` → `restoreSession`（`session-lifecycle.ts:713`）：pi 侧其实恢复得对（`model: undefined, inheritSessionModel: true`，pi 0.84.4 从 session 文件 entries 恢复，见下），但 `registerSession`（`session-lifecycle.ts:260-264`）播种 `session.modelId = modelOverride ?? getDefaultModel()`——restore 不传 override → 初始元数据 = 全局默认。真值只能靠异步快照重拉收敛，且收敛前的组合投影回退播种值（`session-state-projection.ts:145`：`?? session.modelId`）。**restore 全程（spawn pi ~580ms + 重拉 ~250ms，531 条消息的 session 更久）composer 显示的就是机制 ③ 的假值。**

**机制 ⑤：档位对齐 watch 无法区分「切模型」与「切 session 焦点」（失败模式 B 主因）**。`packages/core/src/domain/composer/thinking-level-sync.ts` 的 watch 观察 `[当前模型 map, 可用档集]`——session 焦点切换同样改变 `currentModelId` → 触发「同体系映射/跨体系重置最高档」→ `onReset` → 对**刚切入的 session** 发 `setThinkingLevel` RPC（03:28:44.163 实证）。这正是 u3 设计登记过的关联发现：*「现状从 A 体系模型的 session 切到 B 体系模型的 session 时，sync watch 也会触发并把新前台 session 档位重置到最高可用档——疑似既有边界问题…是否修它另行决策」*——欠账到期。

**机制 ⑥：改写值进记忆表（污染 G2）**。`model-thinking.ts:263-287` 记录 watch「不区分来源，值生效即记录」（u3 条件 b 设计裁决）——机制 ⑤ 改写后的值随即写入全局 per-model 记忆表，用户期望的「上次用的档位」被覆盖。

**关键事实：pi 0.84.4 实装语义（本机 node_modules 核实）**：

- resume 恢复正确：`dist/core/sdk.js` `createAgentSession` → `getSessionContextSettings`（`dist/core/session-manager.js:146`）从 entry 路径取**最后一条** `model_change` 或 assistant message 的 provider/model 作为会话模型；仅恢复失败/空会话才落 `findInitialModel`（全局默认）。
- **`set_model` RPC 不持久化全局默认**：`dist/modes/rpc/rpc-mode.js:367-374` 调 `session.setModel(model)` 不传 `options.persist`；`dist/core/agent-session.js:1250-1268` 的 `setModel` 只在 `options.persist === true` 时写 settings.json。本机实证：切了 7 次 flash 后 `settings.json` 的 defaultModel 仍 = glm-5.3。→ `model-service.ts` 注释「全局默认的持久化由 pi 侧 setModel 完成」与 u3 设计「关键事实⑤（重启后 landing 默认模型即最后切换的模型）」**均已失效**——「粘滞默认」如今只在单次运行内靠机制 ① 的 volatile 广播成立，重启即丢，行为既污染又不完整。

### 2.4 当前物理数据流图（模型值从哪来、在哪断）

```
【pi 进程存活期】
  用户在 B 切模型 ──> pi B: setModel（写 model_change entry 进会话文件 ✅持久）
                └─> runtime session B.modelId = 生效值（内存）
                └─> 广播 config.defaults{flash} ──> renderer settingsStore.defaultModel = flash  ← 机制①
  renderer store: A.modelId = glm-5.3（来自 runtime Map 投影）✅

【B 的 pi 进程存活、A 的 pi 进程退出】
  runtime: Map 删 A ──整表广播──> renderer store: A.modelId = ''（扫描占位）     ← 机制②
                                        │
  用户切回 A ──session.switch──> restoreSession:
    pi 从会话文件恢复 glm-5.3 ✅（真值在磁盘的会话文件里，但 xyz 不读它）
    registerSession 播种 A.modelId = 全局默认（≠ 真值）                        ← 机制④
    composer 读 store: A.modelId='' ──|| 兜底 ──> defaultModel = flash          ← 机制③
    （异步快照收敛后才纠正为 glm-5.3）
```

**断点本质**：真值其实一直躺在 pi 会话文件（JSONL 的 `model_change` entry）里，但 xyz 的元数据层（runtime Map / 扫描器 / renderer store）没有任何一层在「进程退出后」持有它。

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**场景 1（已建 session，进程退出后切回）**：用户在 A（glm-5.3）对话 → 重启 app → 切回 A：composer 模型 chip 立刻显示 **GLM-5.3**（来自 `.model.json` sidecar 持久值，不等 restore）；档位 chip 显示 A 自己的档位，restore 完成前后一致；runtime 日志中**没有**自动 `set_thinking_level`。

**场景 2（切模型 + 档位记忆）**：用户在 A 把模型从 glm-5.3 切到 flash（此前用 flash 时记忆了 high）→ 档位 chip 自动跳 **high**；切回 glm-5.3（记忆 max）→ 自动 **max**。u3 记忆行为不变。

**场景 3（跨 session 切换零干扰）**：A（glm-5.3, max）↔ B（flash, high）反复切换焦点：两个 chip 组各自保持，Settings 页「默认模型」始终显示 Settings 里配置的值（glm-5.3），不随 B 切 flash 而变，也不再弹「默认模型自动更新」toast。

**场景 4（landing 新任务默认模型）**：用户最后一次显式选的模型是 flash → 新建任务的 landing 模型 chip 默认 **flash**（显式 lastUsedModel，跨重启仍成立——修复了 pi 0.84.4 下已失效的「关键事实⑤」）；若从未显式选过 → 显示 Settings 默认模型。

**场景 5（失败路径：sidecar 缺失/损坏的老 session）**：切回一个从没有 `.model.json` 的旧 session → 模型 chip 显示占位「…」而非任何具体模型名；restore 完成（≤2s）后显示真值。**恢复指引**：无需用户动作，restore 读回真值后自动纠正；若 restore 本身失败（会话文件丢失），走既有 SESSION_NOT_FOUND 错误路径（panel 提示 + 删除入口）。

### 3.2 整体方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：状态持久化 + 污染源解耦 + 显式门禁**（D1-D6 全套） | ✅ 消灭「无持久层」结构断点；全局默认回归「Settings 配置」单一语义；粘滞默认显式化后跨重启成立；档位对齐收口到用户显式动作 | 中：runtime 2 个单元 + core 3 处 + renderer 文案，~13 文件 | 低：各决策均有独立降级路径（见错误规格表） | ✅ **推荐** |
| B：仅显示层止血（restore 播种真值 + 兜底改占位） | ❌ 不持久——重启后死 session 仍只有占位可显示（G1 只修了一半）；失败模式 B（档位改写/记忆污染）完全未动 | 低 | 档位改写继续污染记忆表，用户对 G2/G3 的不满持续 | ❌ |
| C：扫描器直接读 pi 会话文件尾部提取终态模型（不加 sidecar） | ❌ 把「最后一条 model_change」语义绑定到 pi 私有文件格式；分支路径（fork 树）下「最后一条」≠「叶子路径上最后一条」，需全量解析（`buildSessionPath`），单文件可达数百 MB | 高：JSONL 尾读 + 分支感知 + 扫描缓存失效治理 | pi 升级改文件格式即碎（违反 pi 语义断言纪律） | ❌ |

**被否方案反例**：若用方案 B，场景 1 变成「重启后切回 A，模型 chip 显示『…』占位，restore 完成后才变 GLM-5.3」——G1 的「跨重启保持」只在 restore 后成立，侧栏/整表数据仍是空串；若用方案 C，一次 pi 小版本把 `model_change` entry 改名（pi 无此兼容承诺），扫描器静默读空，回退到占位——与 sidecar 显式写点相比，把可靠性押在外部格式上。

### 3.3 关键决策与权衡

**D1：per-session 模型 + 档位持久化到独立 sidecar `.model.json`（BINDING_FIELDS 新增第 6/7 个绑定字段）（选定）**

- **采用**：新建独立 sidecar 文件 `<sessionFile>.model.json`（内容 `{ modelId, thinkingLevel, version }`，生效值），走既有 `persistBindingSidecar` 家族骨架（`session-file-utils.ts:271`：原子写 tmpfile+rename、写后失效 sessionMetaCache + 目录级 TTL 缓存、JSONL 不存在绝不创建 sidecar 的守卫）。`modelId`（"provider/modelId" 复合串）与 `thinkingLevel` 作为绑定字段登记进 `packages/runtime/src/infra/pi/session-binding-fields.ts` 的 BINDING_FIELDS 矩阵（该注册表自带扩展路径：「新增绑定字段 = 本表加一行 + 各写点 persist helper 照旧，回填与守卫自动获得」；四入口列少一列编译红）。**四列矩阵语义显式取值**：
  - **create 列 = `'options'`**：值来自启动生效值（D2 create 读回）。
  - **handoff 列 = `'options'`**：承接 session 走 `sessionService.create`（CREATE_DERIVED_CALLERS），值 = handoff staging 暂存快照经 create 通道透传（暂存快照默认继承源 session 的当前模型——语义上「用户在 handoff 面板看到的模型」）。
  - **restore 列 = `'none'`（关键裁决）**：显式**不**从扫描 meta 回填。原因：`restoreSession` 中 `hydrateBindingMeta(session, …, 'restore')` 在 `registerSession` **之后**运行——若填 `'meta'`（restore 列现有惯用值），可能过期的扫描 sidecar 值会**覆写 D2 刚 get_state 读回的新鲜播种值**，反向破坏 E6 自愈闭环。也不选 `'resolved-in-entry'`（launchPresetId 的 restore 先例——值在入口解析后经注册表回填）：那会把播种点拆到 registerSession 与 hydrateBindingMeta 两处，形成双写源；统一在 registerSession 的 `metaOverride` 单点播种。restore 的播种由 D2 的 `metaOverride` 在 `registerSession` 内完成；D2 读回失败时的兜底链（sidecar 值 → 空串占位，r3 校准）在 D2 实现内部自行读取 `findScannedSession` 结果，不经 hydrateBindingMeta。
  - **fork 列 = `'options'`**：forkSession 既有优先级 `override > 源 preset.modelOverride`（`session-lifecycle.ts:936-940/997`），值在入口已解析。

  写点五处，全部写**生效值**（对齐 C-pi-13 回执纪律）：① `switchModel`（get_state 读回后）；② `setThinkingLevel`（钳制生效值）；③ create/landing（启动生效值；**Gate B 实证修正**：真实 create 流程中 get_state 时 pi 尚未首 flush、`sessionFilePath` 为 undefined，create 瞬间的写点恒被守卫跳过——故 ③ 的主落地形态为 **turn end ensure 补写**：`tryPersistModelBinding`（镜像 D14 `tryPersistProjectBinding` 先例）在 turn_end 主路径 + agent_end 兜底执行「sidecar 缺失才以内存生效值补写，已有值（写点①⑤所写）不覆写」）；④ fork（继承值；forkSession 对 forkedFilePath 既有防御性 sidecar unlink/写点同批落位）；⑤ restore（D2 读回值）。**连带改动**：删除路径的 `purgeSessionSidecars`（`session-lifecycle.ts:587-599`，注释明示「delete 是唯一清理点，防孤儿 sidecar」）显式后缀清单需 + `.model.json`，否则删除 session 留孤儿文件（纯磁盘垃圾，无正确性影响——扫描/统计均按 `.jsonl` 后缀过滤——但违背该函数自身清理承诺）。扫描器 `scanSessionMeta`（六读合一缓存管线）补提取这两字段，`scannedToSummary` 填入 summary——死 session 的整表广播从此携带真值。
- **被否**：
  - **写入 `.meta.json`（本设计第一版方案，被审查击穿）**——反例序列：`persistSessionEnd`（`session-file-utils.ts:198-208`）用 `atomicWrite` **全量覆写** `.meta.json` 且内容仅 `{type:'session_end', …}`，该写点**每 turn 结束无条件触发**（`handleTurnEndSideEffects` → `persistSessionOutcome`，`session-file-utils.ts:215` 注释明示「每 turn 写点」）→ 模型字段写进 `.meta.json` 后**下个 turn 结束即被抹掉**；且 `restoreSession` 中 `unlinkSync(target.filePath + '.meta.json')` 会删除整个文件。既有绑定字段家族也全部是独立文件（`.preset.json`/`.project.json`/`.agent.json`），无「共存一个 .meta.json」先例。
  - **改造 `persistSessionEnd` 为 read-merge**——与每 turn 写点引入并发窗口，动高频路径换来的只是文件数减一，不成比例。
  - **renderer 本地 KV 持久化**——模型真值产生于 runtime RPC 回执/get_state，renderer 存一份形成「runtime 内存 + renderer KV」双写不同步（renderer 重载丢失写时机）。注：D4 的 lastUsedModel 仍用 renderer KVStorage，二者判据不同——lastUsedModel 本身就是 UI 偏好（与 u3 记忆表同性质），无 runtime 侧真源，不存在双写冲突。
  - C（读会话文件尾部）——见 3.2。
- **证据**：`session-binding-fields.ts` 头注释（扩展路径声明）与 `BindingFieldSpec.entries` 四列强制类型；`session-file-utils.ts:271` `persistBindingSidecar` 家族骨架；`session-scanner.ts:85`（占位现状）；`session-model-control.ts`（switchModel/setThinkingLevel 均已持有生效值，写点零额外 RPC）。
- **效果**：G1 成立（场景 1）；机制 ② 消灭（整表广播携带真值，非占位）。
- **边界（显式声明）**：sidecar 是**死 session 的显示缓存（best effort）**，不是权威——pi 会话文件 entries 才是权威，restore 真值由 D2 读回并**覆写**可能过期的 sidecar。pi 侧 extension 改档位等旁路变化会让 sidecar 短暂过期，restore 后自愈——按此语义登记，不追求旁路实时同步。session 未首 flush 前（`sessionFilePath` undefined）跳过 sidecar 写（create 瞬间恒属此窗口）——补写由写点③的 turn end ensure 承担（首 turn 结束时文件已 materialize，见上）；该 session 若在首 turn 前死亡本就不进扫描列表（无文件即无条目，`persistBindingSidecar` 的 JSONL 存在性守卫天然覆盖）。

**D2：restore / create 用 get_state 生效值播种元数据（选定）**

- **采用**：`restoreSession` 在 `switchSession(file)` 成功后 `get_state` 读回生效 model + thinkingLevel，作为 `registerSession` 新参数 `metaOverride` 播种 `session.modelId/thinkingLevel`。**失败兜底链（实现于 D2 内部，不经 hydrateBindingMeta；r3 起按字段粒度）**：每个字段独立取值——get_state 读回值 → `findScannedSession` 结果的 sidecar 值（D1 落盘的最近生效值）→ 仍无则播种**空串占位**（D3 语义，不播种全局默认——G4：已建态「不知道」显示占位而非假值；假值窗口由快照实例异步收敛自愈）。任一兜底都不阻塞 restore。`create` 同理：现有流程已为拿 piSessionId 调过一次 `get_state`（`session-lifecycle.ts:403`），顺带读回生效模型播种（替代当前的 `presetClientOptions.model` 请求值播种，pattern 引擎静默换模时显示从第一毫秒起就是真值）。
- **被否**：只依赖快照实例异步收敛（现状）——收敛窗口内 `state_changed` 组合投影回退播种值（机制 ④），假值帧广播给 renderer。末级兜底播种全局默认（r2 版文字「仍无则维持现状的全局默认兜底」）——被 r3 击穿：全局默认播种 = restore 窗口向 composer 提供可能不属于本 session 的假值（机制 ④ 残余），与 G4「不知道显示占位」直接冲突；r3 起兜底链按字段粒度以空串占位收尾，双无值与单字段缺失两子分支统一（实现侧 `session-lifecycle.ts` restore 兜底随 U5 解 block 同批对齐此语义）。
- **证据**：`session-lifecycle.ts:713-830`（restore 现不传 override；hydrateBindingMeta 在 registerSession 之后——见 D1 restore 列裁决）；`session-state-projection.ts:145`（`?? session.modelId` 回退链）；日志 03:28:44（spawn→switch_session→三个并行 get_state，读回成本 ~250ms 且非新增）。
- **效果**：机制 ④ 消灭；G4 在 restore 窗口成立（配合 D3 占位，假值窗口归零）。

**D3：composer 已建 session 未知模型/档位显示占位，不再兜底全局默认（选定）**

- **采用**：`model-thinking.ts` 按态分流：`sessionId` 非空（已建 session）且 store 值为空 → 显示占位（ModelSelectPopover 新增 i18n 文案「…」；档位 chip 对称处理——`regularThinkingLevel` 已建态不再 `?? localThinkingLevel` 回落 landing 残留，undefined 时 ThinkingLevelPopover 显示占位）；`currentModel`/`defaultModel`/`lastUsedModel` 兜底链**仅 landing 态**（`sessionId === null`）使用。档位占位与 D5 门禁配套成立：已建 session 档位 undefined 时**不再触发**「无档位设最高档」的自动 RPC（见 D5 分支覆盖），显示占位直到 state_changed 到达。
- **被否**：维持 `||`/`??` 兜底链（现状）——机制 ③ 的直接载体，「显示一个错的」比「显示不知道」危害大（用户据此误发消息）；档位只登记不处理——与 modelId 同构的污染路径留着，D1+D2 落地后仍存在 D2 兜底到全局默认的窗口。
- **证据**：`model-thinking.ts:189`（modelId 兜底链）与 `regularThinkingLevel`（`?? localThinkingLevel` 同构回落）；ModelSelectPopover `currentName` computed（空值显示裸 id，需补占位文案）。
- **效果**：G4 兜底成立——即便 D1/D2 全部降级，最坏显示「…」而非他 session 的模型/档位。

**D4：全局默认与 session 级切换解耦 + landing 粘滞默认显式化（选定）**

- **采用**：① `ModelService.switchModel` 移除 `config.defaults` 广播（该消息语义是「全局默认变了」，session 级切换在新语义下不再改全局默认——广播错误内容比不广播更糟）；`settingsStore.defaultModel` 回归单一语义 = Settings 配置值（sendInitialState 推送）。② landing 新任务默认模型改为显式 **lastUsedModel**（renderer KVStorage 单键，与 u3 记忆表同基建同平台）：`onModelSelect` 显式选模型时写入（staging 试选不写；已建态在 switchModel RPC **成功后**写入、失败不写——与 armed「失败清」同向，切换未生效不污染粘滞默认；KV 加载窗口内的写入优先于在途旧快照，镜像记忆表守卫），landing 兜底链变 `currentModel || lastUsedModel || defaultModel`。
- **被否**：②' 完全移除粘滞默认（landing 恒用 Settings 默认）——砍掉已被用户习惯的「新任务接着用上次的模型」体验，而实现它的成本只是复用 u3 KV 基建的一个键；②'' 维持现状（靠 `config.defaults` 广播撑粘滞）——语义污染源本体，且 pi 0.84.4 下重启即丢，行为不完整。
- **证据**：`model-service.ts:88-108`（广播现状）；renderer 侧**两个消费点**（审查第 1 轮核实）：`settings-lifecycle.ts:73`（写 store）+ `ProviderPage.vue:369`（`onDefaultsWithSource`，非 `default-set` 且值变时 toast「默认模型自动更新」）；`model-thinking-memory.ts`（KVStorage 平台基建，lastUsedModel 照抄其 load/record 形态）；pi 实装「set_model 不持久化」（关键事实，见 §2.3）。
- **副作用（显式声明，正向）**：ProviderPage 的「默认模型自动更新」toast 在 session 级切换后不再出现——该 toast 本就是机制 ① 的症状（用户在别的 session 切模型，Settings 页却被告知「默认模型已更新」）；用户主动在 Settings 设默认（`source: 'default-set'`）或 provider 变更对账触发的路径不受影响（这些不经 `ModelService.switchModel` 的 session 级入口）。
- **效果**：机制 ① 消灭；场景 3/4 成立；G2 的记忆不再被「切 session 顺带改默认」间接干扰。
- **待验证检查点（实施期）**：以实施期全量 grep `onDefaults`/`onDefaultsWithSource`/`config.defaults` 的结果为准更新本节消费方清单（第 1 轮审查已证明分析期结论可被证伪——本节清单以审查核实版为基线，实施期复核防再漏）。

**D5：档位对齐 watch 加 armed 门禁——对齐只挂「用户显式切模型」（选定）**

- **采用**：`thinking-level-sync.ts` 的 watch 回调以**回调入口时的 armed 快照**（`consumeArmedRestore` 执行前捕获的 `getArmed()` 值，存局部变量）作为门禁判据——不能用消费块之后的 armed 值（`consumeArmedRestore` 在「未命中/幂等/不可用」回落路径**先清 armed 再 return false**，读后值会让「记忆未命中的显式切换」误入只读分支）。门禁覆盖**所有 onReset 对齐分支**：无 armed 快照时，「无档位设最高档」（分支 2）、「同体系映射」（分支 4）、「跨体系重置」（分支 5）一律跳过；**「可用性校验」（分支 3）保持不门禁**——它是数据不一致时的安全网，仅在**前一对 map 为 undefined 的触发**可达（挂载首触发 + providers 迟到后 map 首次到达），此时当前档位在新模型不可用才重置一次。armed 生命周期沿用 u3 既有防线（设立=显式 onModelSelect、成功/失败清、换绑清、5s 过期清、in-flight 豁免），零新状态。
  - **记忆未命中的显式切换**：armed 快照存在 → 对齐分支照常执行（同体系映射/跨体系重置），保持现状行为——记忆恢复（命中）与规则对齐（未命中）都只发生在显式切换上。
  - **landing 初值不受分支 2 门禁影响**：landing 挂载的初值由 u3 的 `followRememberedOrDefault` watch（`model-thinking.ts`，immediate）设定（记忆档 ?? 最高档），与 sync watch 分支 2 是双路径冗余——门禁分支 2 后 landing 初值仍由前者覆盖，行为不变。
  - **门禁语义边界（启发式声明，r3）**：入口快照是「本触发 = 显式切换」的**一次性抑制判据，非精确归因**——armed 在途（规则 3 不匹配保留）窗口内，providers 刷新等无关触发会因快照非 null 放行对齐分支（行为与无门禁现状等价，非本设计引入的回归）；同触发内规则 1 过期清同样放行。V3 偶发红的排查锚点：先查该时段是否恰有 armed 在途（`set_thinking_level` 时序紧邻 switchModel 回包 / config.providers 广播），再怀疑门禁回归。
- **被否**：① rebind 标志位（watch sessionId 设「重绑中」标志跳过一次对齐）——新增时序耦合状态（标志设置与 watch flush 顺序），且 armed 机制语义上就是「显式切换」的精确判据，重复造轮子；② 把对齐逻辑从 watch 移进 onModelSelect 内联调用——重构 sync 所有权，u3 记忆消费点也在 watch 里，连锁改动大；③ 门禁读消费块后的 armed 值（第一版表述的 ambiguity，被审查指出）——「先清再 return false」的回落路径会吞掉显式切换的对齐，V4 测不出（只测命中路径）。
- **证据**：`thinking-level-sync.ts` watch 结构（armed 消费块在回调顶部、三个 onReset 分支顺序）；`model-thinking.ts` armed 防线全集 + `followRememberedOrDefault`（landing 初值双路径）；日志 03:28:44.163（无 armed 的换绑触发对齐的反例实证）。
- **效果**：机制 ⑤ 消灭，G3 成立（场景 1/3）；G2 的污染源（机制 ⑥ 的上游）同步消灭——记录 watch「生效即记录」语义保持不变（u3 裁决），但被记录的值回归真值。
- **边界（显式声明）**：显式切模型后 5s 内换绑（armed 已被换绑清）→ 该次切换的档位对齐/记忆恢复不触发，session 保持 pi 侧生效档——用户切走即视为放弃本次对齐，可接受（显式换绑优先于在途意图，与 u3 规则 6 同向）。**既有错钳窗口（登记，维持现状）**：分支 3 不门禁 + providers 迟到（map undefined→defined 之间已发生换绑）的组合下，已建 session 档位 value ∈ {xhigh, max}（`DEFAULT_SUPPORTED_LEVELS` 五档之外）会被按五档归一误判不可用 → 钳到 high 并发一次 setThinkingLevel RPC + 记忆表写入。此为**现状既有行为，非本设计引入，D5 前后等价**（窗口窄：providers 早于 panel 加载即不出现）；留待后续治理，本设计不扩大也不修复——但 V3 实施期若偶发红，先查此窗口再怀疑 D5 门禁回归（排查锚点：日志中该 RPC 的时序紧邻 config.providers 广播）。**providers 迟到两步到达窗口（登记，r3）**：显式切换后目标模型的 map/supportedLevels 若分两步到达（首触发时 supported 尚未下发），首触发即消费 armed（记忆命中按默认五档 fallback 提前 onReset；未命中走对齐/分支 3 后清 armed），第二次触发（真实数据到达）被门禁拦截 → 该次切换「用真实数据再对齐」的一次性机会丢失，session 保持 pi 侧生效档（无错误 RPC，仅对齐不理想）；若两步到达形态为 supported 先到、map 后到，第二次触发 oldMap 仍 undefined，落不门禁的分支 3，可用性安全网照常可达（r4 补记）。窗口窄：popover 可选本身要求 providers 已知该模型，仅能力注册表下发晚于切换回包时出现。**被否的根治候选**：门禁对「armed 已清 + oldMap 有值 + 模型确实变化」的触发放行——重演击穿：session 焦点切换（A→B）恰好同构满足三条件（换绑清先执行 → armed null；oldMap = A 体系 map；模型变化），放行即复活机制 ⑤；故仅登记观察，V4/Gate B 偶发红的排查锚点 = 该时段 config.providers 是否晚于 switchModel 回包到达。

**D6：记录 watch 维持「生效即记录」+ 漂移文档修正（选定）**

- **采用**：记录 watch 不加新门禁——机制 ⑥ 的污染输入是机制 ⑤ 的改写值，D5 消灭后记录值回归真值（含 session 加载即记录，u3 条件 b 原语义，保持）。同批修正两处漂移登记：`model-service.ts` 失效注释（「pi 侧 setModel 持久化全局默认」→ 按 0.84.4 实装改写）+ u3 设计文档「关键事实⑤」勘误（附本设计链接）。**Gate B 纪元精确化（V4 冻结批次补记）**：Gate B 实测发现跨纪元中间 flush 仍会污染记忆（切模型的生效链是两次独立 store 写——modelId 回包先落、恢复档位回包后落，中间 flush 读到错配对），已加 **sessionId 纪元判据**（观察源加 sessionId，跳过「同 session、modelId 已变而 level 未变」的中间 flush，commit `1f5024380`）——被拒收的对中 level 从未生效于该 modelId，故「值生效即记录」语义保持，非用户意图判别轴（不违背被否②）；第三形态（app 实测）另见下段。**第三形态追击（第三轮，根因闭环）**：取证确认第二瞬态方向「档位变、模型未变」——pi setModel 内部经 _getThinkingLevelForModelSwitch 为新模型归一档位（pi 侧 per-model 记忆档 > 全局默认 > 保持）并 emit thinking_level_changed，runtime 转独立帧 session.thinkingLevelSet{level}（不经 300ms 防抖、早于 `model.switched` 回包与原子 `state_changed` 到达），renderer useChat handler 单字段写 thinkingLevel → store 呈 (旧模型, 新档位) 瞬态，纪元判据（只拦「模型变、档位不变」镜像方向）不命中 → pi 归一值写穿旧模型槽位（实测 mem[flash] ← max）。修复 = 记录 watch 增加 **armed 不匹配守卫**（armed 在途且 modelId ≠ 目标 → level 变化属切换链、从未生效于该 modelId，不入表；单测 W5）。已知边界：level 先落形态下 (目标模型, 归一值) 的落表被既有判据一并跳过——记录缺失非污染，后续手选档照常补记。
- **被否**：给记录 watch 加「仅用户手选才记录」门禁——u3 对抗审查已裁决过该问题（判别轴错位，D2 被否③），重开无新证据；且 session 加载值入表是「切回模型恢复上次档位」的正当数据来源。
- **证据**：`model-thinking.ts` 记录 watch（条件 b 注释 + 纪元判据）；`docs/design/model-thinking-level-memory.md` §1。
- **效果**：D5 消灭主要污染源；Gate B 发现跨纪元中间 flush 残留，已加时序精确化（覆盖单测可复现的两类窗口）；第三形态由第三轮 armed 不匹配守卫关闭（实机 V4 场景复验待跑，状态见 impl-plan R6）——文档与实装一致（漂移守卫纪律 C-proc-10 同向）。

### 3.4 终态物理数据流图

```
【B 切模型（session 级）】
  onModelSelect ──RPC──> runtime switchModel:
    pi B setModel（会话文件 entry ✅）
    session B.modelId = get_state 生效值
    <sessionFile>.model.json ← {modelId, thinkingLevel} 生效值  ← D1 新增（persistBindingSidecar 家族）
    state_changed{生效值} ──> renderer store B ✅
    （不再广播 config.defaults                                    ← D4）
  renderer: lastUsedModel KV ← 刚选的模型（仅显式选择）           ← D4 新增

【A 的 pi 进程退出】
  runtime Map 删 A → 整表广播：A.modelId = .model.json 值（glm-5.3）← D1 替换占位
  renderer store: A.modelId = glm-5.3 ✅（不再被抹成 ''）

【切回 A】
  composer: store 有值 → 直接显示 GLM-5.3（无假值窗口）            ← 机制②③消失
  restoreSession: switch_session → get_state 读回 → metaOverride 播种（hydrateBindingMeta restore 列='none' 不覆写）← D1×D2
  sync watch: 无 armed 入口快照 → 对齐分支全跳过，不发 setThinkingLevel ← D5

【landing 新任务】
  模型 chip = currentModel || lastUsedModel || Settings 默认       ← D4
```

### 3.5 错误规格表

| # | 失败场景 | 行为 | 恢复指引 |
|---|---|---|---|
| E1 | `.model.json` 写失败（磁盘满/权限） | 双层吞错：persist 层 console.error（家族先例，`session-file-utils.ts` `persistBindingSidecar` 家族 catch）+ 写点①②外围 catch console.warn（`session-model-control.ts:113/171`）；内存态不受影响 | 无需动作：本运行期显示正确；仅「退出后重启」回落到 D3 占位，restore 后自愈 |
| E2 | restore 的 get_state 读回失败 | 按字段兜底链：`.model.json` 扫描值 → 空串占位（D3 语义，不播种全局默认），快照实例异步收敛纠正 | 重新切回该 session 触发再次 restore；日志排查关键字按路径分两条：restore 路径 `get_state readback failed, falling back to sidecar values`（`restore-seeding.ts:214` catch，无连字符）、switchModel 路径 `switchModel get_state read-back failed`（`session-model-control.ts:89` catch，read-back 带连字符） |
| E3 | 老会话无 `.model.json` | summary.modelId=''、summary.thinkingLevel=undefined（`session-scanner.ts:85` 扫描占位恒空串）→ composer 显示 D3 占位 | restore 完成（≤2s）自动显示真值；无需迁移脚本（向后兼容） |
| E4 | lastUsedModel KV 读失败/未加载 | landing 兜底 `defaultModel`（同 u3 E7① 语义：未加载不阻塞，回落默认） | 无需动作；KV 惰性加载完成后自动生效（模块级响应式 ref，`last-used-model.ts:22-27`，KV 到达当次 landing 即更新，无需重进） |
| E5 | armed 过期（switchModel RPC >5s 后才回包） | 规则 1 清 armed → 该次切换无档位对齐/记忆恢复，session 保持 pi 生效档 | 用户手动调档（一次性成本）；既有 u3 规则，非本设计新增 |
| E6 | pi 侧 extension 旁路改档位（不经 runtime RPC） | sidecar 不更新（短暂过期），内存快照经事件失效自愈 | restore 时 D2 读回覆写 sidecar，自愈闭环（D1 restore 列='none' 保证回填不反向覆写读回值） |

---

## §4 验收（真实场景，非单测）

> 验证环境：`pnpm dev` 起真实 Electron app（dev renderer :1420），真实 pi 子进程，真实数据目录。浏览器侧用 browser-automation skill（连 :9222）截图断言；runtime 侧行为用日志 grep 探针。下述 session A/B 均为真实对话过的 session（各发过 ≥1 轮消息保证会话文件存在）。

| # | 验证场景（回溯目标） | 步骤 | 通过标准 |
|---|---|---|---|
| V1 | 跨 pi 退出模型保持（G1） | ① A（zai-coding-cn/glm-5.3）对话一轮；② B 切到 glm-5.3-flash 对话一轮；③ 重启 `pnpm dev`（杀全部 pi）；④ 侧栏点 A | A 的 composer 模型 chip 显示 **GLM-5.3**（进入即显示，无需等待 restore 完成）；`cat <sessionFile>.model.json` 含 `"modelId": "zai-coding-cn/glm-5.3"` |
| V2 | restore 窗口无假值（G4） | ① 构造无 `.model.json` 的老会话（手动删除该 sidecar 文件）；② 重启后点它 | 进入后模型 chip 显示占位「…」，restore 完成 ≤2s 内变为真值；**全程不出现 glm-5.3-flash**（即使上一步刚在别的 session 切过 flash） |
| V3 | 切焦点零改写（G3，负面验证） | ① B 手动调档位到 high；② 切到 A 再切回 B；③ grep 本时段 runtime 日志 | B 档位 chip 恢复显示 high（不被重置为 max）；日志中**无**本时段的 `set_thinking_level`（对照现状反例 03:28:44.163——switch_session 后 77ms 内出现的自动调用） |
| V4 | 档位记忆恢复（G2，含未命中路径） | ① A 中把 flash 调到 high（写入记忆）；② 切到 glm-5.3 调到 max；③ 再切回 flash；④ 换一个从未用过、无记忆的模型（如 glm-5.2）显式切换 | ③ 档位 chip 自动变 **high**，再切回 glm-5.3 自动变 **max**（命中路径）；④ 档位按对齐规则落位（同体系映射/跨体系最高档——未命中路径不因门禁丢失对齐，对照 D5「记忆未命中的显式切换」裁决） |
| V5 | 全局默认不被 session 切换改写（G1/G4，负面验证） | ① Settings 默认模型确认 = glm-5.3；② B 切到 flash；③ 打开 Settings 页看「默认模型」；④ grep 日志 | Settings 页「默认模型」仍显示 glm-5.3；日志无 `source: 'model-switch'` 的 config.defaults 帧；Settings 页开着时②步**不弹**「默认模型自动更新」toast（对照 `ProviderPage.vue:369` 现状行为） |
| V6 | landing 粘滞默认显式化（场景 4） | ① B 切到 flash（显式选择）；② 回 landing 新建任务；③ 重启 app 再回 landing | landing 模型 chip 显示 **flash**（重启后仍成立——lastUsedModel KV 持久）；从未显式选过的全新环境下显示 Settings 默认 |

每场景均可 testable（截图断言 / 文件断言 / 日志探针），回溯关系：V1/V2→G1+G4，V3→G3，V4→G2（命中+未命中双路径），V5→G1+G4（污染源根除+toast 症状消除），V6→场景 4 行为保持。V3/V5 是关键负面验证——本设计刻意让「不该发生的事不发生」，只验正向会漏掉「一有切换就过度反应」的回归。

---

## §5 下一层拆分

### 实施路径（三阶段，各自可独立验收/回滚）

- **P1 约束登记 + runtime 数据层**（U0+U1+U2）→ 验收 V1/V2 的 sidecar 与播种部分。**约束登记先行**（项目纪律：新增约束先登记再写代码；改 constraints.json 后跑 `node scripts/render-constraints.mjs` 重生成 md，随首次提交）
- **P2 行为层**（U3-U6）→ 验收 V3/V4/V5/V6 + V2 占位部分
- **P3 文档收尾**（U7 文档部分 + U8 测试三连全量回归）

### 拆分单元清单

| 单元 | 内容 | justification（为什么这么拆） | 对应验收 |
|---|---|---|---|
| U0 | constraints.json 登记三条新约束（per-session 模型/档位必须持久独立 sidecar；全局默认不得由 session 级切换改写；档位对齐仅挂显式切换）+ `render-constraints.mjs` 重生成 | 项目纪律「先登记再写代码」——放代码之后违反纪律；三条约束正是 D1/D4/D5 的机器可读投影，先登记让后续单元有登记号可引 | — |
| U1 | runtime：`modelSidecarPath`/`persistModelBinding`（persistBindingSidecar 家族）+ BINDING_FIELDS +`modelId`/`thinkingLevel` 两行（create/handoff/fork='options'，restore='none'）+ 扫描器 `scanSessionMeta`/`scannedToSummary` 提取 + 五写点接入（含 forkSession 侧 sidecar 落位）+ `purgeSessionSidecars` 清单 +`.model.json` + `CREATE_DERIVED_CALLERS` 守卫契约核对（`passedBindingFields: ['projectId']` 是否需 + 两新字段，含 user-facing/agent-managed 行） | 数据层先行——U2-U6 全部依赖「持久值存在」或与之正交；sidecar 注册表自带编译级守卫（漏登记矩阵列 = 编译红）；restore 列裁决在矩阵层固化，防实施惯性填 'meta' 覆写 D2 播种；删除清理清单与守卫契约是 r2 审查抓出的连带改动，随数据层同批防孤儿/防契约漂移 | V1 |
| U2 | runtime：restore `get_state` 读回 → `registerSession` `metaOverride` 播种（兜底链 sidecar 值 → 空串占位（r3 校准），实现在 D2 内部）；create 路径同款读回播种 | 与 U1 同包同层，先于行为层落地可独立验收 restore 窗口（V2 的真值部分） | V2 |
| U3 | runtime：`ModelService.switchModel` 移除 config.defaults 广播（source=model-switch） | 单点删除、独立回滚；先于 U4 落地可让「默认不被污染 + toast 症状消失」立即成立 | V5 |
| U4 | core：`regularModelId`/`regularThinkingLevel` 按态分流（已建 session 空值→占位，不回落 landing 残留）+ lastUsedModel KV（写点=onModelSelect 非 staging 分支）+ landing 兜底链 | 显示语义与 KV 属 core 域同一 composable 家族，一起改保持 `model-thinking.ts` 内聚 | V2/V6 |
| U5 | core：`thinking-level-sync` armed 门禁（回调入口快照判定；覆盖分支 2/4/5，分支 3 保持） | 单文件单 watch 的行为门禁，独立可测（core vitest 直接覆盖换绑/显式命中/显式未命中三路径） | V3/V4 |
| U6 | renderer：ModelSelectPopover + ThinkingLevelPopover 占位 i18n 文案（en-US/zh-CN） | 纯文案，随 U4 的占位语义一起交付 | V2 |
| U7 | 文档：`model-service.ts` 失效注释修正 + u3 设计文档「关键事实⑤」勘误（附本设计链接） | 与 P2/P3 代码行为绑定的漂移修正（C-proc-10 同向）；约束登记已提前至 U0，此处只剩纯文档 | — |
| U8 | 测试三连：runtime vitest（scanner 提取/model-control 写点/restore 播种兜底链/BINDING_FIELDS 矩阵守卫）+ core vitest（model-thinking 分流/thinking-level-sync 三路径门禁/KV）+ renderer 组件测试（占位显示） | 每单元的回归防线独立成测，避免跨包大集成测试互相阻塞 | 全部 |

### 文件改动地图

```
packages/runtime/src/infra/pi/session-binding-fields.ts        [+2 字段矩阵行（restore 列='none'）]
packages/runtime/src/infra/pi/session-file-utils.ts            [ScannedSessionMeta +2 字段 + scanSessionMeta 提取；persistModelBinding/readModelBinding 已提取至 session-model-sidecar.ts（Gate A），本文件保留 re-export 导入面]
packages/runtime/src/infra/pi/session-model-sidecar.ts         [新（Gate A 提取自 session-file-utils）：modelSidecarPath/persistModelBinding/readModelBinding]
packages/runtime/src/services/session/session-scanner.ts       [scannedToSummary 填真值]
packages/runtime/src/services/session/session-model-control.ts [switchModel/setThinkingLevel 写点]
packages/runtime/src/services/session/session-lifecycle.ts     [restore/create 读回播种 + 兜底链（Gate A 提取 restore 播种段至 restore-seeding.ts）, registerSession metaOverride, purgeSessionSidecars 清单 +.model.json, fork 侧 sidecar 落位]
packages/runtime/src/services/session/restore-seeding.ts       [新（Gate A 提取自 session-lifecycle）：restore get_state 读回 + 按字段 metaOverride 构造 + E6 sidecar 覆写]
packages/runtime/src/services/session/session-service.ts       [Gate B：tryPersistModelBinding（写点③ turn-end ensure）]
packages/runtime/src/services/session/session-state-projection.ts [Gate B：handleTurnUsageSideEffects/handleTurnEndSideEffects 两调用点]
packages/runtime/src/services/model-service.ts                 [移除 config.defaults 广播 + 注释修正]
packages/core/src/domain/composer/model-thinking.ts            [regularModelId/regularThinkingLevel 分流 + lastUsedModel 写点]
packages/core/src/domain/composer/thinking-level-sync.ts       [armed 入口快照门禁（分支 2/4/5）]
packages/core/src/domain/composer/last-used-model.ts           [新文件：KV 单键，仿 model-thinking-memory]
packages/renderer/src/components/panel/ModelSelectPopover.vue  [占位显示]
packages/renderer/src/components/panel/ThinkingLevelPopover.vue [占位显示]
packages/renderer/src/i18n/locales/{en-US,zh-CN}/panel.ts      [占位文案]
docs/constraints.json + docs/design/model-thinking-level-memory.md [约束登记（U0 先行）+ 勘误]
（+ 对应 __tests__ 文件）
```

### 运行时断言与探针清单

- **A1**（⛔实施期门，V3 探针）：restore 完成后不再自动发 `set_thinking_level`——重演 03:28:44 场景（切回死 session），日志断言 switch_session 后无自动 set_thinking_level。降级路径：若门失败，检查门禁是否误读消费块后的 armed 值（D5 已声明入口快照语义）或分支 2 未被门禁覆盖；另确认分支 2 门禁生效且 landing 初值由 `followRememberedOrDefault` 正常写入（两种 watch 注册顺序均收敛，无需调整注册顺序）。若时序紧邻 config.providers 广播，先按 D5「既有错钳窗口」排查锚点排除非门禁因素。
- **A2**（⛔实施期门，V1 探针）：switchModel 后 `.model.json` readback 含生效值（cat 文件断言）。降级路径：E1（写失败吞错）不阻塞主流程，验收转 V2 占位路径。
- **A3**（⛔实施期门，V1 探针）：session 退出后整表广播携带 sidecar 真值（renderer store 断言）。失败处置：检查 `scannedToSummary` 字段透传与 `persistBindingSidecar` 的 sessionMetaCache/TTL 缓存失效是否接线（缓存未失效 = 恒旧值）。
- **A4**（⛔实施期门，V5 探针）：session 级切换不再产生 `config.defaults` 帧（日志 grep）。失败处置：grep 确认无其他 `source: 'model-switch'` 生产点（预期唯一生产点 = ModelService.switchModel；若发现第二生产点，按 D4 语义一并移除并更新消费方清单）。
- **A5**（✅已测）：pi 0.84.4 `set_model` 不持久化全局默认——本机 settings.json 实证（7 次 flash 切换后 defaultModel 仍 glm-5.3）；`dist/modes/rpc/rpc-mode.js:367-374` 源码核实。

### 待验证检查点（设计阶段无法确定，诚实标注）

- `onDefaults`/`onDefaultsWithSource`/`config.defaults` 消费方全集（✅ 已闭环 2026-09-04：实施期全量 grep 履行完毕，无新消费方，D4 清单两点即全集——详见 impl-plan R1）
- `CREATE_DERIVED_CALLERS` 的 `passedBindingFields` 守卫映射：modelOverride/thinkingOverride 参数如何映射到绑定字段取决于守卫的静态扫描实现（r2 提出，实施期核对并同步登记）
- ModelSelectPopover/ThinkingLevelPopover 空值占位的具体 UI 形态（「…」vs「未知」文案定稿）
- sidecar 写频率上限评估：仅显式切换/restore 触发，量级 = 用户手动操作频次，预判无 debounce 需求（实施期如实测有高频写再加）
