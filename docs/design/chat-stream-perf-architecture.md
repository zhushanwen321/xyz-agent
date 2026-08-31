# 聊天链路性能架构改造（A/B/D 三候选 + C 撤销登记）

> **一句话结论**：针对性能扫描产出的 4 条架构级候选，经评估后实施 3 条——消息分组尾部快车道（O(n_msgs)→O(delta)）、entry 重放 transient fold（O(n²)→O(n)）、useSidebar 双轨绞杀收尾（删 567 行副本），并撤销 1 条已被前期修复消解的候选（railTurns 跨包改造）登记；全部已实施，行为等价验证通过（测试级；G1/G2 收益实证待 §4.2 S1-S5 执行，时点见 §4.2 引言与 §5.2）（commits `3fa710aee` / `3c099d409` / `af96fa94c`）。
>
> **文档状态**：设计已实施（事后设计记录——grilling 决策与方案对比的事后沉淀，代码先行）。**已审查**（2026-09-01 对抗式审查，主 agent 会话内执行、报告未落盘：0 must-fix / 3 suggestion 本轮全修；§5.2 自报三攻击面全部独立重演闭合）。层性质：技术方案层（接口/数据模型层，层敏感准则全适用）。关联：上游 scan/fix 见本仓 git 历史（c5b82db0f…45b78c1ba、e28495e0b）；架构范式依据 ADR-0039 / ADR-0049 / ADR-0062。

## 1. 背景目标

**SCQA**：xyz-agent 前端的消息流已是 virtua 虚拟滚动 + 三层节流的成熟形态（情境），但一轮 5 组并行性能扫描（覆盖 renderer/core/ui 三包 106 文件）显示，节流层之下仍有 4 处结构性成本不在局部优化射程内（冲突）：用户拍板对架构级候选全量处置（问题），本文记录 4 条候选的评估结论、设计决策与实施结果（答案）。

**系统是什么**（给不熟悉内部的读者）：聊天消息从 pi 进程到屏幕经过三层——`packages/core/src/domain/chat/`（领域层：WS 消息 → delta 合帧 → 不可变消息数组 → turn 分组）、`packages/renderer/src/`（壳层：MessageStream 用 virtua 虚拟滚动渲染分组结果，sidebar 管理 session 编排）、`packages/ui/src/features/chat/`（展示层：Turn/MarkdownRenderer 等组件）。性能契约有三条既定范式：消息数组 shallowRef 不可变替换（ADR-0039，引用相等即内容相等）、per-session Map 分区（ADR-0049）、消息流三层节流（microtask 合帧 → 分区替换 → rAF+增量 markdown）。**"不可变替换"是本篇所有方案的正确性基石**：数组每个 commit 都是新数组，所以"逐项引用比对"可以零成本判定"内容是否变了"。

**目标**（从使用者体验倒推）：

| # | 目标 | 度量 |
|---|------|------|
| G1 | 长会话（数千消息）streaming 期间，消息分组派生成本与消息总量解耦 | 每合帧批只处理尾部变化区 |
| G2 | 切入超长会话 / load-more 翻历史的重放延迟与 entry 总量解耦 | 重放从 O(n²) 降 O(n) |
| G3 | session 编排只存在一份实现，编排修复不再双打 | 删除旧轨副本，消费方单轨 |
| G4 | 防止已被消解的问题被重复提议（候选 C） | 撤销登记 + 重启信号 |

**Scope**：in——上述 4 条候选的设计与实施；out——消息流渲染链路的既有范式（虚拟滚动/三层节流/shallowRef/Map 分区）、真实 pi 进程联调（real-pi 测试池归 CI）、UI 组件层优化（已在先行 commits 完成）。

**层声明**：技术方案层 → 下一层为代码实施（已完成）。本文 §5 以实施记录形态呈现拆分。

## 2. 现状与问题分析

### 2.1 消息流物理数据流（改造前）

```
pi 进程
  └─ WS message.* ──→ renderer api/events.ts（三通道总线，按 sessionId 路由）
        └─→ core delta-coalescer（第1层节流：delta 按 microtask 合帧，约 30-120 批/秒）
              └─→ commitMessages：分区内层 shallowRef 整体替换（新数组，ADR-0039）
                    ├─→ [A 的战场] toRenderItemsIncremental：消息数组 → turn 分组（renderItems）
                    │       └─→ renderer MessageStream（virtua）→ ui Turn/MarkdownRenderer
                    ├─→ [C 的战场] railTurns 派生 → TurnRail（导航浮层）     ┐ 前期修复
                    └─→ [B 相关] applyEntry（entry → 消息的 reducer）        │ 已消解/缓解
runtime 侧：pi session 文件 entries ─→ convertPiHistory（lift + replayEntries）
              └─→ getHistory（切入会话）/ getFullHistory（load-more）       ← [B 的真实痛点]
[ D 的战场 ] renderer sidebar：useSidebar（旧轨）∥ useSidebarNew（新轨）双编排
```

### 2.2 候选 A：toRenderItemsIncremental 的 miss 路径全量重扫

turn 分组函数的快路径条件是 `cache.lastSourceRef === sourceMessages`（源数组引用未变则零重算——这是 ADR-0039 下的合法捷径）。但 streaming 期间每个合帧批都 commit 新数组，快路径**恒不成立**，于是每批走全量路径：`groupRenderInput` 遍历全部消息（3000 消息约 0.3-1ms）+ 每 turn 2-3 个 spread 构建签名临时数组（每帧百级小分配）。turn 对象复用机制保护了 DOM patch（该范式生效中），残余成本是**纯 JS 派生重扫随消息数线性增长 + GC 压力**，长会话流式期间每秒 30-120 次持续支付。

关键结构性事实：分区数组的变化受不可变替换约束，只有四种形态——尾部 append、尾部替换（长度不变）、头部前插（load-more）、引用全变（hydrate/reconcile）。**streaming 高频场景 100% 落在前两种，前缀引用恒不变**——这是原实现没有利用的 locality。

### 2.3 候选 B：apply-entry 的 copy-on-write 样板与 O(n²) 重放

「live ≡ reload」等价契约（实时帧与文件重放喂同一 reducer，ADR-0062 登记的合法例外）要求 entry handler 纯函数化，代价是每个 handler 手写全量拷贝（`[...state.messages, msg]` 形态 8 处 + Map/Set 各处的整表拷贝）。单条 O(n) 无感，但 `replayEntries` fold n 条 entry 结构性 O(n²)：10k entry ≈ 400MB 内存流量 + 10k 次数组分配 ≈ 100-400ms。

发生场景修正（评估期核实，原 scan 前提部分不成立）：renderer 实时帧是权威帧（message_end 等）而非每 token，单帧 µs 级可忽略——**真实痛点在 runtime 侧**：启动后首次切入长会话（HistoryRebuildCache 未覆盖的冷路径）与每次 load-more（`getFullHistory` 全文件重放、无缓存防线）。

### 2.4 候选 D：useSidebar 双轨冻结态

w3-w5 绞杀者迁移（旧实现逐步替换为新实现、共存过渡）进行到 90% 后冻结：新轨 `useSidebarNew`（core createUseSession + 壳端口适配）已有 10 个静态消费方，旧轨 `useSidebar`（567 行独立重复实现）剩 2 个运行时消费点（useChatViewDeps 的 fork/handoff 静态 import、useTraceJump 的 selectSession 动态 import）。三类持续成本有实证：① selectSession 12 步编排两处各一份，修 bug 必须双打（commit `266754c09` 即一次真实双打）；② 新功能只进新轨（restoreSession / assignSessionToProject / 重连重拉），旧轨已是行为落后副本；③ 登记未清的回退债务（useSidebarNew 的 deleteSession wasActive 回退走 core headless selectSession，缺 ensureStreamSubscription）已在活跃路径。运行时双订阅本身成本可忽略（低频广播 × 幂等 applySnapshot）——**真正的成本是编排双份维护与漂移**。

### 2.5 候选 C：railTurns 跨包改造（评估后撤销）

原记录：TurnRail 每 token 整树重渲的根治需跨包数据流改造。评估期基于当前代码重新核实：前期两个修复（railTurns 引用恒等 + TurnRail WeakMap memo，commits `c5b82db0f`/`a8a8373a1`）已将其消解——剩余重渲全部是「末位 turn 内容真变」的必要更新或 O(n≤20) 引用比较常数，拆「结构通道 + 末位内容通道」双速率 seam 会让本已 deep 的模块（shallow 接口背后三层实现）复杂化，Depth 净下降。结论：**Resolved，不改造**，登记重启信号（§3.4）。

## 3. 解决方案

处置总览：

| 候选 | 处置 | 方案 | commit |
|------|------|------|--------|
| A 分组重扫 | 实施 | 尾部快车道三车道演进 | `3fa710aee` |
| B 重放 O(n²) | 实施 | transient fold + collector seam | `3c099d409` |
| D 双轨并存 | 实施 | 一次性切换收尾 | `af96fa94c` |
| C railTurns | 撤销 | 消解确认 + 重启信号登记 | — |

### 3.1 候选 A：分组尾部快车道

**终态**（调用方视角）：`toRenderItemsIncremental` 签名、`TurnRenderCache` 消费方式零变化。效果上，接口的性能承诺从「源数组不变 → 零重算」升级为「commit 只有尾部变化 → 只处理尾部变化区」——streaming 期间每合帧批成本与消息总量解耦，MessageStream 无需任何改动即继承。

**方案对比**：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|------------|------|
| **①尾部快车道双特例（采纳）** | 高：miss 路径变「双快特例 + 全量兜底」三车道，共享同一分组 SSOT；依据 ADR-0039 自证式判定，无需上游声明 commit 模式（无跨模块耦合） | 低：单文件 +205 行；`groupRenderInput` 仅加 `from` 参数 | 低：不触碰分组规则本体（历史事故区零接触）；等价性由「每步 deepEqual 全量」既有测试形态锁定 |
| ②通用分叉点重扫 | 中：从尾向前找第一个引用不等处、回退 turn 边界重扫，额外覆盖前插/中删 | 高：边界逻辑多，等价用例要求陡增 | 中高：触碰分组状态机的重开切面 |
| ③持久化结构 / chunked 数组 | 低：分组是顺序状态机（current turn 依赖前文），复杂结构换不来高频路径收益 | 高 | 高：破坏产物类型与全部消费方 |

否决 ②③ 的理由：收益仅覆盖低频场景（前插/中删本身就是一次性 O(n) 可接受），违反"遇子问题先问减法"原则。若用 ②，§2.2 的例子（streaming 每批全量重扫）同样被解决，但多付 3 倍改动面与边界风险；若用 ③，TurnRenderCache 的所有消费方（MessageStream 及测试）都要感知新结构。

**关键决策**：

- **D-A1 车道判定用「逐项引用比对」而非上游 commit 模式标记**。被否：store 侧标记 commit 形态——引入跨模块耦合，且 ADR-0039 已保证引用相等即内容相等，自证式判定无需任何人声明。证据：四种变化形态中 streaming 100% 落在尾部两种，前缀比对 O(n) 指针比较零分配（3000 项约 1-3µs）。
- **D-A2 尾部重建起点 = 末位 turn 的源数组起始下标**（cache 新增内部字段 `turnStartOffsets`）。该点具有「分组状态归零」性质：该处消息只可能是 user 锚 / 隐藏完成通知边界 / assistant 自启，三者都以 openTurn 起始（处理时 current 必为 null），所以**子数组从 current=null 重跑与全量路径在该区间逐字一致**——三车道共享同一分组函数（`groupRenderInput` 加 `from` 参数），零第二份分组语义。运行时断言：✅已测（36 个既有用例零修改全绿 + 8 个新车道用例全部断言与全量路径 deepEqual）。
- **D-A3 车道①条件从「仅末条不同」放宽为「前 n-1 项相等」**（实施期兼容扩展）：末条相同但数组引用不同时，子重跑判定 unchanged → 整体引用恒等复用，正是设计承诺语义的零成本超集。
- **D-A4 拒绝「给共享类型 MessageTurn 加 idx 字段」**（对照前期 rail 优化决策）：侵入共享 domain 类型换局部便利不值，WeakMap 索引已够。
- **D-A5 tail 快车道省略 `filterInvisibleItems` 是有意省略（2026-09-01 审查补登）**。依据：display===false 消息在分组层必被规则 2（隐藏完成通知边界）或透明分支消化，static 槽位（规则 4 退化 / 规则 5）结构性不含 display:false——全量路径（车道③）的 `filterInvisibleItems` 是不变量守卫（自证零命中），tail 路径省略它与全量逐字等价，等价性由「每步 deepEqual 全量」测试形态锁定。**已知不对称登记**：未来若新增绕过 display 检查的 static 产出分支，车道③兜底而快车道漏防——新增 static 分支的同步义务 = 在 `rebuildTailFromLastTurn` 补 O(tail) 同款过滤（或在函数注释显式声明分支顺序不变量）。

### 3.2 候选 B：entry 重放 transient fold

**终态**（调用方视角）：`createInitialChatViewState` / `applyEntry` / `replayEntries` 三函数签名、`ChatViewState` 导出类型、产物结构零变化。效果上，runtime 冷切入与 load-more 的重放成本降两个数量级（10k entry：数百 ms → 个位数 ms），全部消费方零改动继承。

**方案对比**：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|------------|------|
| **④transient fold + collector 拆段（采纳）** | 高：handler 拆「派生段（共享纯函数）+ commit 段（collector seam）」，拷贝策略从 8 处手写样板收敛为单点——新 handler 不再可能漏拷贝；两条 fold 路径共享派生段，「单条 ≡ 批量」构造性成立而非靠纪律 | 中：单文件 150-250 行结构重组 | 中低：两条 fold 路径漂移是历史事故区（W20/W21 曾产 4 条漂移 bug），由共享派生段 + 824 行等价性测试 + runtime 五套 fixture 守卫 |
| ⑤仅优化 replayEntries、不动 handler | 低：需要 handler 的可变变体 = 第二份规则实现，违反分组 SSOT 精神 | 中 | 高：双实现漂移正是历史事故根因形态 |
| ⑥持久化结构 / chunked array | 低：破坏 `ChatViewState.messages: Message[]` 导出类型与全部产物消费方 | 高 | 高 |

否决 ⑤⑥ 的理由：⑤ 制造第二条规则实现路径，恰是 ADR-0062 例外形态要防的漂移源；⑥ 侵入远超收益。若用 ⑤，§2.3 的例子同样解决，但「单条 ≡ 批量」从构造保证退化为测试约定。

**关键决策**：

- **D-B1 collector 双实现 + 派生段共享**。collector 接口 = 读口（messageCount / 幂等键查询 / 配对锚点 peek / clientUuid peek）+ 写口（appendMessage / replaceMessageAt / addOrphan / recordDelivered / putClientUuid / markLastAssistant / snapshot）。copy-on-write 实现保证 `applyEntry` 单条行为逐字不变（no-op 路径仍返回原 state 引用，`toBe` 断言锚点保持）；mutable 实现 O(n) 累积、终态组装同构产物。运行时断言：✅已测（fold≡reduce 元断言全类型 entry + 确定性交叉验证 + 10k 序列）。
- **D-B2 mutable 中间态只在 fold 过程内存在，产物不加运行时冻结**。依据：state 构造入口已穷尽核实（只有 createInitialChatViewState + fold，所有调用方从空 state 出发），可变性不外泄；加冻结是给不存在的暴露面付运行时成本。已知唯一可观察差异：空 entries 且传 initial 时返回值从「initial 同引用」变为「内容 equal 的新对象」——全仓无调用方传 initial，无观察者。
- **D-B3 renderer 实时帧不在优化范围**（评估期对 scan 前提的修正）：权威帧频率下 copy-on-write 单条成本 µs 级，优化它属于反向信号。

### 3.3 候选 D：双轨一次性收尾

**终态**（消费方视角）：session 编排只有一个入口 `useSidebar`（重命名后的新轨：core createUseSession + 壳端口适配），12 个消费方（迁移前 10 新轨静态 + 2 旧轨运行时消费点合流）+ 全部测试单轨；编排修复单点化，新轨能力（restoreSession 等）成为唯一事实。旧轨 567 行删除。

**方案对比**：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|------------|------|
| **⑦一次性切换收尾（采纳）** | 高：绞杀终态一次到位，双打成本立即归零；接口已对齐（w5 C-W5-4）、core 已沉淀，剩余面小 | 低-中：2 个运行时消费点 + 1 个 core 端口 + 测试改指向，机械为主 | 中：唯一非机械点是回退债务（D-D1），须先清 |
| ⑧按消费方分批迁移 | 中：每批风险小，但双轨期拉长，双打/漂移成本持续发生 | 分散但总量更高 | 中：批次间新功能继续只进单侧 |

否决 ⑧ 的理由：剩余面只有 2 个运行时文件，分批反而延长双轨期——「绞杀拖着的每一天都在产生真实成本」。若用 ⑧，§2.4 的双打例子会继续发生。

**关键决策**：

- **D-D1 先清回退债务再切换（步骤硬序）**：core `use-session` 新增可选端口 `selectSessionFallback`，壳注入完整 12 步 selectSession——deleteSession/deleteFolder 的 was-active 回退从 core headless（缺 ensureStreamSubscription，有 handoff 回复丢失同款回归前科）升级为壳版。缺省仍走 headless（headless/mobile 形态不变）。
- **D-D2 空态出口承接（实施期发现补齐）**：core 空态分支原本只 push 路由，旧轨删除路径空态出口另有 D7 startFlow 承接（flow=idle 时面板会落入无输入面死态）。不补齐则删除旧轨即行为回退——新增 `enterEmptyChatState` helper，core 既有测试零破坏。
- **D-D3 重命名兑现头注释承诺**：`useSidebarNew` → `useSidebar`（其头注释自述「消费方切换完成后重命名取代」），测试 reset 函数对齐旧轨习惯名。部分消费方与 mock 文件因此零改动（路径重命名后恰好解析到新实现）。
- **D-D4 启动时序差异查实非回归**：新轨 initApp 在 newSession 前多 `await projectStore.init()`（D14 归属约束）；生产环境 Landing.vue 的 onMounted idle 兜底 startFlow 双入口幂等覆盖该窗口，仅测试环境需显式推进微任务。

### 3.4 候选 C：撤销登记（防重复提议）

**决议**：railTurns 跨包数据流改造不再作为候选——前期修复已消解，剩余开销是内容真变的微秒级常数；拆双速率 seam 是负 Depth 收益。

**重启信号**（满足其一再议，届时走组件边界 memo 而非数据流改造）：① profile 显示 TurnRail vnode diff 进入火焰图显著位；② 会话 turn 数量级升至百级。

## 4. 验收

验收回溯 §1 目标。分两类：**已执行**（实施期完成）与**待执行**（真实场景验收，标注触发条件）。

### 4.1 已执行的验证（实施期，全部通过）

| 验证 | 覆盖 | 回溯 |
|------|------|------|
| core 全量 vitest | 94 文件 / 1397 passed（A：36 既有零修改 + 8 新车道用例；B：fold≡reduce 元断言 + 确定性 + 10k 序列；D：core session 60 tests 含 4 新端口用例） | G1/G2 的行为等价基线 |
| renderer 受影响面 | 27 文件 / 206 tests（sidebar 全家 + app-bootstrap + MessageStream.wire + rail + 各 mock 迁移文件） | G3 行为保持 |
| runtime 增量 | message-converter / session-history 等 81 tests（经 convertPiHistory 间接覆盖 replayEntries 新路径） | G2 |
| 三包 typecheck + `dev-smoke` exit 0 | D 的 import 结构改动（模块加载期闸门） | G3 |
| `check-doc-symbol-drift` | 零悬空引用（D 的改名清扫） | G3 |

### 4.2 真实场景验收（待执行，不阻塞——行为等价已由测试锁定，以下是收益实证项）

> 执行时点登记（2026-09-01 审查补登）：S1-S4 随下次 prerelease 真机验收一并执行，执行后回写 §5.2 销账；S5 随本分支首次 push 后的 CI（截至登记时三主 commit 尚未 push 到任何远端分支）。

| 场景 | 步骤 | 通过标准 | 回溯 |
|------|------|---------|------|
| S1 长会话 streaming 派生成本 | Playwright 连 dev app（:9222），构造 2000+ 消息会话，发起 streaming，Performance profile 30s | 火焰图中 `groupRenderInput` 全量调用仅出现在低频形态（load-more/hydrate），streaming 批只有尾部重建；对比改造前 profile 单帧派生耗时有量级下降 | G1 |
| S2 冷切入超长会话 | dev 环境构造 10k entry session 文件，冷启动后切入该会话，console.time 打点 getHistory | 重放耗时个位数 ms 级（改造前数百 ms） | G2 |
| S3 load-more 翻历史 | 同会话连续点击加载更多 5 次，每次打点 | 单次重放无随页数增长的延迟劣化 | G2 |
| S4 双轨删除后日常使用 | 真实使用：新建/切换/删除/fork/handoff/deleteFolder（含删除活跃 session 的回退与空态）、重连 | 全部行为与删除前一致；删除活跃 session 回退后消息流正常订阅（无「切回后流停滞」） | G3 |
| S5 real-pi 池（CI） | push 后 CI 跑 live-reload / relay-live-reload / broadcast-getstate / pi-protocol-contract / chaos | 全绿 | G2 的 live ≡ reload 终检 |

### 4.3 错误与降级规格

| 边界 | 行为 |
|------|------|
| A：形态判定不命中（前插/中删/引用全变） | 退化现有全量重扫路径——行为与改造前逐字一致，永不出错只会变慢 |
| A：cache 为空 / 首帧 | 走全量路径建立 turnStartOffsets 基线 |
| B：entries 含未建模类型 / 幂等命中 / 形状不匹配 | collector 无 commit → 返回原 state 引用（与改造前 `toBe` 语义一致） |
| B：replayEntries 传入非空 initial | mutable 路径浅拷贝起步，initial 不被 mutate（契约保持，元断言锁定） |
| D：core 被无壳环境（headless/mobile）使用 | `selectSessionFallback` 缺省 → 走原 core headless selectSession，形态不变 |
| D：flow 端口未接线时删空 session | `enterEmptyChatState` 的 startFlow 调用 no-op（`deps.flow?.`） |

## 5. 实施记录与残留

### 5.1 commit 映射

| commit | 内容 | 规模 |
|--------|------|------|
| `3fa710aee` | A：message-turns.ts 三车道 + 8 用例 | +401/-25 |
| `3c099d409` | B：apply-entry.ts collector 拆段 + fold 等价套件 | +501/-173 |
| `af96fa94c` | D：双轨收尾（59 文件） | +543/-1017 |
| `c5b82db0f` / `a8a8373a1` / `a7e078b86` / `45b78c1ba` / `e28495e0b`（先行） | scan 阶段 S1/S2 候选的局部优化 + B 档终端选区 | 另见各 commit |

### 5.2 残留与后续

- **real-pi 池待 CI 终检**（§4.2 S5）：本地未跑（需真实 pi 子进程 + LLM 轮次）；对外 API 与产物结构零变化，风险低但须盯 CI。触发 = 本分支首次 push（截至 2026-09-01 三主 commit 未 push 到任何远端分支）。
- **S1-S4 真机实证待执行**（§4.2）：行为等价已由测试锁定，此为 G1/G2/G3 的收益实证项；触发 = 下次 prerelease 真机验收一并执行，执行后回写本节销账。
- **候选 C 重启信号**（§3.4）已登记于本文，后续审查者以此为准，不再重复提议数据流改造。
- **perf plan 08-render-layer 文档不在本仓**（cw harness 目录）：A 是其 D-4「可选优化第三期」的兑现，本文即仓内登记载体。
- **对抗式审查已执行**（2026-09-01，主 agent 会话内，报告未落盘）：0 must-fix / 3 suggestion（本轮全修：消费方计数口径、本节执行时点登记、D-A5 补登）。自报三攻击面全部独立重演闭合——A：空 trigger turn 经收尾 closeTurn 折叠永不入 cache，`turnStartOffsets` 末位恒指向分组状态归零重启点，恒等判定含尾部剩余项检查兜底；B：collector 每次 fold 新建闭包、`dispatchEntry` 无回调 fold 的路径，重入结构上不可能，`replayEntries` 生产唯一调用方 `convertPiHistory` 不传 initial（D-B2 披露差异无观察者属实）；D：`selectSessionFallback` 以箭头函数延迟解析壳 selectSession，调用时机远晚于 setup 完成，无初始化时序窗口。
