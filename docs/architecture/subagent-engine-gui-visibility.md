# Subagent 统一引擎协议与 GUI 可见性设计（engine 统一接管 · 分阶段协议闭合）

> 状态：定稿（tech-design-review 对抗式审查 3 轮：r4-1 报 1 must-fix + 5 suggestions、r4-2 报 4 suggestions，全部修复；r4-3 确认无新问题通过。**实施状态：阶段 1（U0-U6）已全部落地（2026-08-25）**——U0 路由分叉 + U1 字段贯通 + U5 skill（wave 1）、U2 编排完备 + U3 引擎标识 UI（wave 2）、U4 drawer 终态渲染（wave 3）、U6 约束登记 C-ext-16..18 + ACP 注记；验收 A1-A6 真机场景待 `pnpm dev` 环境执行。阶段 2 K1-K4 各需独立详设。
> 层声明：当前层 = 功能设计；下一层 = 阶段 1 的实现任务（可实施）+ 阶段 2 的接口级决策（各需独立详设）。
> 父设计：[subagent-engine-abstraction.md](subagent-engine-abstraction.md)（EnginePort 协议 SSOT；本设计是它在「统一接管 + GUI 可见性」维度的落地路径）。

**一句话结论**：终态是**协议闭合**——chat 工具域与 workflow 域的派发都只对 EnginePort 说话（EnginePort = pi 协议的中立化投影，pi 为主语义锚点、zcode 适配补充），宿主层持有 record 生命周期与完成通知、引擎层纯执行；迁移分两阶段（阶段 1 入口路由分叉快速交付 GUI 可见性，阶段 2 职责拆分后 pi 路径也经协议转发闭合），ACP 不迁移但做词汇校准与适配器插槽预留。

## 1. 背景目标

### SCQA

- **S（情境）**：EnginePort 协议抽象（run/interact/read/probe/capabilities 五面）与 pi/zcode 双引擎实现已就绪，PiEngine 已是「委托 wrapper」模式（run 委托 runSpawn 本体、interact 委托续聊全套、read 委托 session ①级）；workflow 域已经协议化（SAR → routeEngine → 引擎）。
- **C（冲突）**：两重断裂。**派发未统一经协议**——chat 工具域（GUI 对话派 subagent 的主通道）的入口 `SubagentService.execute` 直钻 `runSpawn`（pi 专属执行栈），不经 engine 转发；`defaultEngine=zcode` 对它不生效。**可见性 pi-only**——workflow 域 zcode 任务不产生 record（GUI 完全不可见），record 的 `engine`/`engineFallback`/`engineHandle` 字段在 runtime 投影时被丢弃，drawer 对话流与实时流绑死 pi 专属数据源（sessionFile + relay 字节流），GUI 无处区分引擎。
- **Q（问题）**：如何让 engine 统一接管两个派发域（对外协议 = 对内协议 = 同一套 EnginePort），并让 record → GUI 可见性与对话流展示对全引擎成立？
- **A（答案）**：见一句话结论。

### 系统是什么（受众补认知）

xyz-agent 桌面 GUI 的 subagent 体系，当前实为**两套并行执行栈服务三个用户可见面**：

| 执行栈 | 入口 | 经 EnginePort？ | record（GUI 数据源） | 服务哪个面 |
|---|---|---|---|---|
| chat 工具域 | `subagents` 工具 action:'start' → `SubagentService.execute` → `runSpawn`（pi 直 spawn） | ❌ 直钻 pi 栈 | ✅ 有 | 侧边栏 Agents tab、drawer 对话流 |
| workflow 域 | workflow 脚本 step → SAR → routeEngine → PiEngine / ZcodeEngine | ✅ | ❌ 无（WorkflowTab 走独立提取器） | WorkflowTab（阶段 2 前不改） |

「引擎」一句话：pi = 深度集成的默认执行引擎（子进程 pi CLI，实时流、会话文件、续聊、fork；**EnginePort 的语义锚点**——协议词汇从 pi 抽象而来）；zcode = 适配补充引擎（ZCode.app 内置 CLI，单轮、终态单 JSON、sqlite 存储）。

### 设计目标

- **G1 协议统一接管（终态）**：两域派发都只对 EnginePort 说话；宿主层持有 record 生命周期与完成通知，引擎层纯执行；缺省 pi 路径在阶段 1 **字节级零变化**、阶段 2 闭合后**行为等价**（守护口径升级，见 D2）。
- **G2 字段贯通**：`record.engine` / `engineFallback` / `engineHandle` 从 extension entry 贯通到 renderer（缺省 = pi，存量零迁移）。
- **G3 zcode 对话流**：zcode 任务出现在 Agents tab，drawer 渲染完整对话（面向 SessionView 协议，不面向引擎）。
- **G4 引擎标识**：侧边栏 item 最左引擎 icon；drawer badge；fallback 兜底留痕警告条。
- **G5 配置自助**：`subagent-ext-config` skill（含生效时机与 probe 缓存语义）。
- **G6 生命周期完整**：cancel / 会话级联 / 进程终止无孤儿（A10 延伸到 chat 域全引擎）。
- **G7 展示层面向协议**：对话流/标识/能力提示从 `record.engine + SessionView + capabilities` 派生；ACP 词汇校准使未来映射成本低；trace 切换与第三引擎接入不堵死。

### In / Out of scope

**In**：G1 的**阶段 1 全部 + 阶段 2 接口级决策**；G2-G6 全部（阶段 1 交付）；G7 的协议预留与词汇校准（不实施 trace/实时流改造）。

**Out**（阶段边界即 scope，防蔓延）：

- 阶段 2 的实现级设计（executeAndAwait 拆分签名、K1-K4 详细方案）——各需独立设计文档，本设计只定接口与守护。
- zcode 运行中逐字实时流（引擎无此能力，伪造流式是反模式）；实时流 AgentEvent 统一面 = 阶段 3 预留（D12）。
- trace 切换的 read 协议实施（D13 只做数据模型预留）。
- workflow 域（WorkflowTab）UI 接入——阶段 2 record 统一后按 D15 倾向另行设计。
- GUI 设置面板（用户明确走 skill 方向）。
- ACP 迁移（调研结论，见 §2.4）。
- zcode 的 conversation/fork/worktree 仿真（capabilities 拒绝 + 指引）。

## 2. 现状与问题分析

### 2.1 物理数据链（现状，两域两栈）

**chat 工具域（阶段 1 主战场）**：

```
GUI 对话「派个 subagent 做 X」
  → 主 agent 调 subagents 工具 action:'start'
  → startHandler（interface/subagent-actions.ts）          ← 参数无 engine
  → SubagentService.execute()
      record 创建（内存 store）
      → runAndFinalize → runSpawn（session-runner.ts）      ← 无路由，pi 直 spawn
  状态迁移点 → pi.appendEntry 自描述快照 → 主 session JSONL
runtime
  subagent-extractor.scanSubagentEntries()
    → projectSelfDescribedSubagentRecord() 逐字段守卫投影   ← engine/engineFallback/engineHandle 全部丢弃
    → shared SubagentRecord[]（契约类型无 engine 字段）
  WS → renderer（SubagentList.vue / SubagentTab.vue）
```

**workflow 域（已协议化，供对照）**：

```
workflow step（engine: "zcode"）
  → SAR.run → routeEngine（三层 + probe + fallback 守卫）
      pi 快路径 → PiEngine.run → service.executeAndAwait（runSpawn 本体）
      zcode → registry → ZcodeEngine.run（隔离池 + journal + kill-chain）
      journal 落盘 engines/<engineId>/<poolKey>/journal-<taskId>.jsonl
      run 返回 handle（SAR 再 backfill journalPath）
  ← 无 record：结果只回流 workflow，Agents tab 看不到
```

**drawer 历史链与实时链**：历史 `SubagentTab → getAgentCallHistory RPC → getSubagentHistory`——按 `record.sessionFile` 直读 pi session JSONL，非 pi 分支 `subagent-engine-history` 三级降级（①zcode sqlite ②journal 重放 ③outcome-only，读侧已就绪、防御式等待写侧字段）；实时 `pi 子进程 stdout → relay tee 字节流 → subagent.stream_delta WS → 逐字渲染`（仅 pi spawn 通道）。**展示层绑死两个 pi 专属数据源——这是 zcode 进不来的根因，也是 trace 切换做不了引擎无关的根因。**

### 2.2 五个断点（逐行实测，含审查复证）

- **断点 1（chat 入口绕过协议）**：`startHandler → service.execute` 参数无 engine，`execute → runSpawn` 全链路无路由——chat 域直钻 pi 执行栈，不经 EnginePort。证据：`subagent-actions.ts` start 分支参数清单；`session-runner.ts` 全文无路由；SAR 消费方仅 orchestration launcher。
- **断点 2（workflow 域 zcode 无 record）**：`ZcodeEngine.run` 全链路不触碰 record 创建/appendEntry——zcode 任务在 Agents tab 不出现。
- **断点 3（投影丢三字段）**：shared `SubagentRecord`（`packages/shared/src/subagent.ts:38`）与 extractor 投影（`subagent-extractor.ts:206-247`）均无 `engine`/`engineFallback`/`engineHandle`；写侧 entry 已有前两项（`record-entry.ts:88` 一带）。
- **断点 4（engineHandle 无写入）**：SAR run 返回的 handle（`sessionRef`/`poolKey`，SAR backfill `journalPath`）只存在内存，无路径进 record entry。
- **断点 5（职责混居）**：`executeAndAwait`（pi 引擎委托目标）内嵌套护栏 + identity 解析 + **record 创建** + pending emit + worktree + runSpawn 管线 + finalize——宿主编排（record/通知）与执行管线（runSpawn）混居一个方法；`execute()` 与 `executeAndAwait()` 的真实差异只在**完成通知模式**（chat=bg notify 注入 turn；workflow=结果直返），不在引擎面。这使「chat 入口直接改调 PiEngine.run」会产生 record 双重创建——协议闭合必须先拆职责（阶段 2 的核心手术）。

**读侧已就绪（P5 预埋）**：`subagent-engine-history.ts` 的 `extractRecordEngine()`（undefined/空串回 pi、非空透传）/ `extractRecordEngineHandle()` 已实现；①级硬要求 `sessionRef` 含 `dbPath + sessionId`。

### 2.3 断点结论的两轮翻转（诚实记录，防后人再翻）

1. **初判（模型审查）**：zcode 无 record、background start 绕过 engine——**结论正确**，未留行号。
2. **误修正（r1）**：笔者把「execute() 创建 record」误读为「所有引擎都经 execute」——实际 execute 的两个调用方（startHandler、PiEngine.run）都是 pi 路径。
3. **审查复证**：正向追入口 + 反向追 SAR 消费方双向验证，初判恢复成立。

教训（对齐全局规则 13）：调用链断言必须双向验证；单向追入口会把「入口存在」误读为「所有路径都过该入口」。

### 2.4 ACP 调研结论（2026-08 实测）

| 事项 | 结论 |
|---|---|
| ACP（Agent Client Protocol）现状 | Zed Industries 2025-08 创建，编辑器↔agent 会话协议（JSON-RPC over stdio）；v1 稳定 / v2 草案；TS/Rust SDK 1.0；JetBrains/Google/GitHub 等采纳；覆盖 initialize 能力握手、session 建立/resume/fork/compaction、prompt 流式 turn（content blocks、tool_call、plan）、elicitation、取消（来源：agentclientprotocol.com · zed.dev/blog；背景数字未离线复核、不承重——判定承重于下两行的双端零支持实证） |
| pi 支持度 | **零**——npm 实装包与上游 clone 源码/文档均无 ACP 痕迹（自有 `--mode rpc` JSONL）。检索可复核：`agentclientprotocol` / `agent client protocol` / `agent-client-protocol`（大小写不敏感）+ 方法名精确匹配 `session/prompt` / `session/request_permission` / `agent/authenticate` 全部 0 命中 |
| zcode 支持度 | **零**——仅 one-shot `--prompt` 单 JSON + 自有 "ZCode Protocol" app-server（非 ACP）。检索可复核（12.5MB `zcode.cjs`）：同上检索词与方法名精确匹配 0 命中；宽松前缀 `session/update` 会误中 ZCode 自有方法 `session/updateRuntimeModelConfig`（恰含子串，非 ACP），复核须用精确匹配 |
| 往 ACP 迁移判定 | **否**。三层错位：①语义——ACP 是 wire 协议（会话面 ≈ EnginePort 的 run/interact/read/capabilities），不覆盖宿主编排（路由/record/journal/池/降级/回退守卫）；②成本——两端都要写适配器 + xyz-agent runtime↔pi 集成层（EventAdapter/session-pool/relay）全部 pi-shaped 需重写；③收益——互操作性卖给「被多编辑器驱动的 agent」和「驱动多 agent 的编辑器」，我们的收益（驱动第三方 ACP agent）可经未来适配器按需获得，不需现在迁移 |

**借鉴三点**（D11/D12/D13 落实）：词汇校准、AcpEngine 插槽、trace/read 协议形状参考。

### 2.5 配置实时性与 probe 缓存语义（实测）

**配置读取**：`ModelConfigService` 构造时 + 每次 `session_start`（`initModel` 步骤 1）各读一次 `config.json`，session 内不重读——**改配置后新 session 生效**。

**probe 缓存**：`ZcodeEngine.probe` 成功/失败均缓存直返（无 TTL、不重探），进程存活期内不再重查——fallback 兜底留痕只在探针未缓存时发生；fallback 验收场景必须新建 session 重置缓存（A2）。

### 2.6 zcode 引擎能力边界（capabilities 声明，实测背书）

| 能力 | 等级 | 含义 |
|---|---|---|
| `eventGranularity` | `coarse`（stdout 终态单 JSON） | 运行中无逐字流，如实提示不伪造 |
| `sessionRead` | `full`（sqlite 三级 JOIN 完整重建 turns） | 终态后 drawer 渲染完整对话（含 toolCalls） |
| `conversation` / `steer` / `worktree` | `unsupported` / `unsupported` / `none` | 预检显式拒绝 + 恢复指引 |

## 3. 解决方案

### 3.1 终态（使用者视角先行）

**场景 1 — zcode 任务全程可见**：dev 环境 `defaultEngine=zcode`，新建 session 让主 agent 派 subagent。侧边栏 Agents tab 出现该项，**最左是 zcode 引擎 icon**；运行中 spinner + 「zcode 引擎：运行中（不支持实时流，结束后可查看完整对话）」；完成后 drawer 渲染完整对话（任务正文 user + assistant response 含 toolCalls），badge 标注 `zcode`；主 agent 收到 bg notify。重开 session 对话流仍可读（sqlite 持久）。

**场景 2 — 双引擎并存与三层指定**：frontmatter `engine: pi`、工具显式 `engine: "zcode"`、全局默认三者并存，路由各得其所，icon 一目了然。

**场景 3 — fallback 兜底留痕**：新 session 首次路由前 zcode CLI 已损坏（探针失败未缓存），全局默认任务无守卫命中兜底回 pi（显式指定 `engine: "zcode"` 属守卫命中**不**兜底、报 `engine_probe_failed`——两态对照 A2）；record 带 `engineFallback`，badge 警告态「请求 zcode → 已回退 pi」+ 恢复指引。

**场景 4 — agent 自助改配置**：「把 subagent 引擎换回 pi」→ 主 agent 经 skill 改 config.json，回复「已改，新 session 生效」。

**场景 5 — zcode 参数预检拒绝**：zcode 任务传 `conversation: true` → 工具同步返回结构化错误（含 capabilities 依据与恢复指引）——预检在 record 创建前（与 task 为空/slug 超长同类请求校验语义，无 record），agent 可立即换引擎重试。

**场景 6 — cancel 与级联无孤儿**：zcode 运行中 cancel → cancelled 终态 + kill-chain（SIGTERM→grace→SIGKILL）退出；zcode 运行中关闭 session / 退出 app → `dispose()` 编排（abortRunningControllers + killAllSpawnedChildren）或 process handler 收割——`ps` 无残留。

**场景 7 — trace 切换（阶段 3 预留，本设计只保证不堵死）**：未来 drawer 支持「对话 trace 切换」——同一任务的多个数据视角（pi 多轮 conversation 各轮、zcode schema 重试的原始轮与强化重试轮、journal 事件流视角 vs 原生 session 视角、fork 父链）。协议形态：`read(handle, {traceId?})` + `listTraces(handle)`；UI 加 trace 选择器，**一次实现全引擎通用**（前提 = 展示层面向 SessionView 协议 + engineHandle 数据模型预留 trace 列表——D13）。

**场景 8 — 第三引擎零 UI 改动（协议派生终态）**：未来接入 ACP-native agent（如 Gemini CLI，经 AcpEngine 适配器）或新引擎：注册引擎 + 提交 icon 资产，Agents tab/drawer/badge/对话流零 UI 代码改动——icon 映射从注册表派生、能力提示从 capabilities 派生、对话流从 SessionView 派生。

**其他失败路径**：`config.json` 坏值 → sanitizer 回缺省 pi（既有行为）；zcode run 失败 → `engine_run_failed: zcode CLI...`（文案自带恢复指引）。

### 3.2 架构终态与迁移策略

#### 3.2.1 终态架构（职责分层 + 协议闭合）

```
chat 工具域宿主（SubagentService，变薄）        workflow 域宿主（SAR）
  ├─ 请求校验 + 路由（三层 + probe + 守卫）        ├─ workflow 编排（既有）
  ├─ record 生命周期（创建/终态/entry）            ├─ record 生命周期（阶段 2 接入，D15）
  ├─ 完成通知（bg notify 注入 turn）              └─ 完成通知（结果直返 workflow）
  └─ EnginePort.run(task, ctx) ──────────────┐
                                             ├→ 引擎注册表（id → factory）
  workflow 宿主同样只调 EnginePort.run ──────┘      ├─ PiEngine：内部包 runSpawn 执行管线（不含 record）
                                                   ├─ ZcodeEngine：CLI spawn + 隔离池 + sqlite
                                                   └─ （未来）AcpEngine：ACP 客户端适配器（D11 插槽）
展示层（renderer）
  ├─ 列表/标识：record.engine + capabilities 派生（icon 三分支映射）
  ├─ 对话流：SessionView 协议（getSubagentHistory 按 engine 路由三级读链）
  └─ （未来）trace：listTraces + read(handle, {traceId})（D13 预留）
```

分层原则（协议闭合后唯一形态）：**宿主持有 record 与通知（域语义），引擎纯执行（EnginePort 同一套协议），展示层面向协议不面向引擎。**

#### 3.2.2 方案对比（迁移策略）

**方案一：分阶段协议闭合（推荐）**

- **阶段 1（快速可见性，本设计可实施部分）**：chat 入口加路由分叉——缺省 pi 走现有 runSpawn 链路（**字节级零变化**），非 pi 走引擎分支（宿主自持 record 全生命周期 + 委托 engine.run）；配套字段贯通、GUI 标识、终止链、skill。zcode 任务立即可见，用户价值先行。
- **阶段 2（职责拆分 + 协议闭合）**：执行内核抽离（record/runSpawn 管线解耦）→ PiEngine 换芯（委托无 record 内核）→ chat pi 路径也经 EnginePort 转发——协议闭合达成，守护从「字节级」升级为「行为等价」（A7）。
- 长期合理性：终态正确（用户拍板方向）；每阶段独立可验收、可停可回退；阶段 1 交付物全部是阶段 2 的存量资产（无一废弃）。
- 短期成本：阶段 1 约 8-10 文件（与 r3 版一致）；阶段 2 需独立详设（K1-K4）。
- 风险：中低——阶段 1 不触碰 pi 路径；阶段 2 风险集中在 executeAndAwait 拆分（双消费者），靠独立设计 + 行为等价守护收口。

**方案二：一步到位协议闭合（直接拆职责 + 全域经协议）**

- 架构上少一次过渡，但单次改动横跨 chat/workflow 两域 + record/执行/通知三层——回归面覆盖全部存量 pi 功能（fork/续聊/bg notify/workflow），可见性交付被大手术阻塞数周。
- 若用它，场景 1-6 的交付时点 = 手术完成时点；期间用户已配置的 `defaultEngine=zcode` 持续无效。
- 结论：否。

**方案三：ACP 对齐（协议外购）**

- 调研结论（§2.4）：pi/zcode 双零支持 + 三层错位（语义/成本/收益）。EnginePort 的宿主关注点（路由/record/journal/池/降级）ACP 设计上不覆盖；迁移 = 重写最深集成层，换我们不消费的互操作性。
- 结论：否。借鉴三点经 D11/D12/D13 吸收（词汇校准/适配器插槽/形状参考），把「往 ACP 靠」的合理部分留成一扇开着的门。

### 3.3 关键决策与权衡

**D1 终态架构 = 职责分层 + 协议闭合**（§3.2.1 图）。被否：保持两栈分叉为终态（r3 版方案 A 的隐含立场）——chat 域永远不经协议，「engine 接管」名不副实，trace/实时流/第三引擎全部失去协议基座；本设计将其降级为迁移阶段 1。

**D2 迁移两阶段 + 守护口径分级**。阶段 1 守护 = **字节级**（pi 分支 record entry 与实施前基线逐字节 diff 一致，A5）；阶段 2 闭合后守护升级 = **行为等价**（pi chat 派发经 EnginePort 转发的全链路行为断言——事件序列/终态/notify 时序/sessionFile 语义一致，A7），因为转发层天然改变调用栈但不得改变可观测行为。**允许增量边界**：阶段 2 统一编排产生的字段级与留痕级增量均豁免于 A7 等价比对——① record 新增可选字段（engineHandle 等；判据 = 既有字段的值与语义不变、新增可选字段不改变消费端缺省行为，读侧防御式解析天然满足）；② 新增留痕产物（pi 建 journal 文件）与降级兜底增强（pi sessionFile 被清理后获②级重放，原为空数组——增强性变化，非语义改写）。被否：阶段 2 也守字节级——转发层必然新增中间对象，字节级守护会永久阻塞协议闭合，等价守护才是对的强度。

**D3 pi = 语义锚点（协议词汇从 pi 抽象）**。EnginePort 是 pi 协议的中立化投影（AgentEvent 八事件联合 tool_start/tool_end/text_delta/thinking_delta/turn_end/message_end/compaction/error、session/stream 语义皆 pi-shaped）——能力最全的深度集成方做锚点，pi 能力不削足适履；zcode 适配进协议（coarse 事件终态合成）。被否：协议词汇从 ACP 抄（阶段 2 全量改名）——语义锚点漂移会波及全部已实现引擎与读链，收益仅是命名美学；校准走 D11 的对齐注记。

**D4 chat 入口路由分叉（阶段 1 核心）**：`ExecuteOptions.engine` + tool schema `engine` 参数；`execute()` 在 record 创建前 `resolveEngineRouting`（同步纯函数，pi 恒免探）。pi 缺省 → 原路径零变化；非 pi → 预检（场景 5）→ record 盖章 → 复用 runAndFinalize 组成件（`pool.acquire` 并发槽 / `finalizeRecord` / notifier——本体硬编码 runSpawn 不可直接调）→ 引擎分支编排（D6/D10）。**未注册 id 报 `engine_not_found`**（对齐 frontmatter 语义，运行期 record 永不含未注册值）。

**D5 缺省路径字节级零变化**：pi 分支 `record.engine` 保持 **undefined**（缺省归属由读侧/渲染侧缺省映射承担：`extractRecordEngine` 现状即 undefined→pi）；entry 序列化不增字段（undefined 经 JSON.stringify 自然省略）。被否：pi record 盖章 `engine: "pi"`——纯冗余信息破坏字节级守护。

**D6 引擎分支编排自含**：JournalWriter（**taskId = record.id**，journal↔record 天然关联，refs.json GC 联动在 chat 域成立）→ probe/守卫兜底（复用 `routeEngine`）→ `engine.run` → **run resolve 后、终态 entry 落盘前**回填 `record.engineHandle`（含 `sessionRef.dbPath + sessionId` 完整对 + journalPath）→ 终态迁移 appendEntry。pi 分支不建 journal/不写 engineHandle（sessionFile 即定位符——阶段 1 口径；阶段 2 统一编排后 pi 同样建 journal/handle，tier② 读链对 pi 生效、sessionFile 被清理场景获 journal 兜底，属 D2 允许增量）。zcode reader 以 `sessionRef.sessionId` 锚定、缺省取池内最新（time_created DESC）——schema 重试两 session 时读**末轮**（与 outcome.usage 口径一致，已核 reader 实现）。

**D7 zcode 对话流 = 终态渲染 + 运行中如实提示**：终态经 engine 路由走 ①级 sqlite reader（`sessionRead: "full"`）；运行中 coarse 提示不伪造流。验收以「assistant turn 含 toolCalls」+「runtime 日志无降级记录」区分①②③级。

**D8 icon 映射三分支**：`undefined/空串 → pi icon（缺省映射）`；`已注册 id → 对应 icon`（pi→`pi.svg`、zcode→`zhipu.svg`，映射表收敛单一常量文件，从注册表可派生）；`未知非空值 → 中性圆点（纯防御，运行期不可达）`。源 `~/Code/llm-simple-router-workspace/main/frontend/src/assets/icons/`，**复制**进 `packages/renderer/src/assets/icons/engine/`（禁外部引用/symlink），统一 `currentColor` 单色（`pi.svg` 单色像素几何块 fill="#09090b"；`zhipu.svg` 24x24 单 path fill="#3859FF" 替换——形状语言差异足以辨识）。

**D9 侧边栏 icon 位置 = item 最左**：`SubagentList.vue` item 现结构「状态指示 + agent 名 + task 摘要」，icon 插在状态指示之前，`size-[13px]` 同级。drawer badge 放对话流顶部工具栏（引擎名 + fallback 警告态）。

**D10 zcode 分支终止链**：①child 注册 `spawnedChildren`（`Map<recordId, ChildProcess>`，与 pi 同构；shutdown 收割兜底覆盖）；②record AbortController + `controller.signal` wire 到 `RunContext.signal` → kill-chain 两级（用户 cancel 生效）；③会话级联挂进 pi 侧现成编排——`dispose()`（[R0/C1 孤儿进程修复]）的 `abortRunningControllers() → killAllSpawnedChildren() → disposeAllRecords("parent-shutdown")` 对 zcode record 天然生效，挂载点已存在；app 退出由 process handler 收割。`/fork` `/new` 路径 `disposeAllRecords` 不 abort 属 pi 既有行为，对齐不引入差异。

**D11 ACP 词汇校准（不迁移，零行为变更）**：AgentEvent/SessionView 命名与结构对齐 ACP 分类学**注记级**校准——`text_delta/thinking_delta ↔ content blocks`、`tool_start/tool_end ↔ tool_call/tool_call_update`、`compaction ↔ session/compaction`、turn 终态词汇对齐；在 types.ts 注释与父设计落 ACP 对照表，未来映射/新引擎实现者按表对齐。**AcpEngine 插槽**：EnginePort 注册表本支持新引擎，声明「ACP 客户端适配器引擎」为合法未来实现（驱动 ACP-native agent 如 Gemini CLI），xyz-agent 不为它改任何现有面。

**D12 实时流统一方向（阶段 3 预留，阶段 1 不动）**：终态 = AgentEvent（journal 的中立事件协议）为唯一实时面，pi 的 relay 字节流投影成事件、zcode coarse 天然在协议内、UI 只消费一种事件流；阶段 1 保持 `subagent.stream_delta`（pi 专属）不动，zcode 运行中走 coarse 提示——不新建 WS 通道、不动 relay。被否：阶段 1 就统一实时面——zcode 无流可发，统一动作此时无第二消费者，纯增改造成本。

**D13 trace 预留（数据模型不堵死，协议不实施）**：`engineHandle` 设计为可扩展（`sessionRef` 值对象语义上已是「引擎自定义定位符」——未来 zcode 重试多 session/journal 视角经 handle 内 trace 列表表达，`shared SubagentRecord.engineHandle` 类型保持透传不枚举内部键）；`read(handle, {traceId?})` + `listTraces` 形态参考 ACP v2 session-resume-replay RFD，留待阶段 3 独立 RFD。阶段 1 的字段贯通**不引入** trace 字段（YAGNI，扩展点在 handle 值对象内天然存在）。

**D14 record 与通知的职责归属（阶段 2 拆分方向）**：record 生命周期归宿主（chat 宿主/workflow 宿主各自或统一入口）；完成通知是宿主域语义（chat=bg notify 注入 turn；workflow=结果直返）**不进引擎协议**（RunContext.onEvent 是事件出口，通知是宿主行为）；`executeAndAwait` 拆分方向 = 宿主统一入口做 [护栏 + identity→AgentTaskSpec + record 创建 + 路由]，执行管线（runSpawn + pool）下沉 PiEngine 内部——具体签名属阶段 2 独立设计（K1）。

**D15 workflow 域 record 语义（阶段 2 决策点，倾向声明）**：协议闭合后 workflow 任务同样经宿主持 record——倾向 record 加 `source` 域标记（`chat` | `workflow`），Agents tab 统一可见两域任务（GUI 一处看全部 subagent），WorkflowTab 保留 workflow 特有视图（步骤编排/依赖图）；最终形态待阶段 2 独立设计拍板（涉及 WorkflowTab 信息架构）。

**D16 skill = `subagent-ext-config`，对齐四先例**：先例 `scheduler-ext-config` / `permission-ext-config` / `smart-context-ext-config` / `rename-session-ext-config`（「使用/排查该 extension 时加载，讲清配置位置 + 字段 + 生效时机」模式）。内容必备：config.json 三环境路径（独立 pi = `~/.pi/agent/subagents/config.json`；xyz-agent dev = `~/.xyz-agent-dev/pi/agent/subagents/config.json`；prod = `~/.xyz-agent/pi/agent/subagents/config.json`——教 agent 读 `PI_CODING_AGENT_DIR`/`XYZ_AGENT_DATA_DIR` env 动态推导，不写死）、字段表（`defaultEngine` 合法值 / `engineRouting.strict` / `maxConcurrent`）、三层路由与生效时机（session_start 重读、新 session 生效）、probe 缓存语义（进程存活期不重探，fallback 只在未缓存时触发）、验证命令（派发后看 Agents tab 引擎 icon；journal 落点 `~/.xyz-agent-dev/engines/<engineId>/` 仅适用非 pi 引擎——pi 分支阶段 1 不建 journal（D6），pi 以 icon 为验证面）。配置实时性维持现状（不加 watcher——fs watcher 引入新失败面且无需求背书）。放 `extensions/universal/subagent-workflow/skills/subagent-ext-config/`（package.json 已声明 `pi.skills`，通路现成）。

### 3.4 数据流（阶段 1 落地形态；终态架构见 §3.2.1）

```
GUI「派个 subagent 做 X」
  subagents 工具（engine? 参数）→ startHandler（透传 engine）
  SubagentService.execute()
    resolveEngineRouting(参数 engine > frontmatter > defaultEngine)   ← D4，同步纯函数
    ├─ pi（缺省）→ runSpawn 现有链路（代码与 entry 字节级零变化；
    │              record.engine 保持 undefined，归属由读侧缺省映射表达）
    └─ zcode → 引擎分支（D6/D10）：
        预检 unsupported 参数（conversation/fork/worktree → 同步拒绝，无 record）
        createRecordForMode（engine 盖章）+ AbortController
        pool.acquire 并发槽（maxConcurrent 统一生效）
        JournalWriter（taskId = record.id）
        probe/守卫失败且无守卫命中 → 兜底回 pi（engineFallback 盖章）
        registry → ZcodeEngine.run（隔离池 + kill-chain ← controller.signal；
                  子进程注册 spawnedChildren）
        run resolve → 回填 record.engineHandle{sessionRef(dbPath+sessionId), journalPath, poolKey}
        终态迁移 → appendEntry 快照（engine + engineFallback + engineHandle）→ 主 session JSONL
        notifier bg notify → 主 agent 新 turn 收结果
runtime
  extractor 投影三项 → shared SubagentRecord[] → WS → renderer
  getSubagentHistory：engine 路由 → ①sqlite ②journal ③outcome
renderer
  SubagentList：record.engine → icon 三分支（D8/D9）
  drawer：badge + SessionView 终态对话渲染 + coarse 运行中提示
```

## 4. 验收（真实场景，真机执行；三要素齐全，均经 chat 工具域派发）

> 测试环境：`set -a && source .env.dev-extensions && set +a && pnpm dev`（本地 extension 源码）+ dev config `~/.xyz-agent-dev/pi/agent/subagents/config.json`。A1-A6 = 阶段 1 交付验收；A7 = 阶段 2 方向级验收（细化为阶段 2 独立设计职责）。

**A1 zcode 任务全程可见**（回溯 G2/G3/G4）

- 步骤：① `defaultEngine: "zcode"` 写入 dev config.json；② dev app **新建 session**，让主 agent 用 `subagents` 工具派 subagent：「列出当前目录的 .ts 文件并统计总行数」；③ 等待完成；④ 点开侧边栏 Agents tab 该项 drawer；⑤ 主 agent 对话流确认收到 bg notify 结果。
- 通过标准：侧边栏该项最左是 zcode icon（DOM 断言 `data-testid`）；drawer 渲染 ≥1 条 user 与 ≥1 条 assistant 消息且内容非空、assistant turn 含 toolCalls（区分①级 sqlite 真实 turns 与②级 journal 合成事件——①级独有 toolCalls），runtime 日志无 `subagent-engine-history` 降级记录；badge 显示 `zcode`；主 agent 后续 turn 含结果摘要。

**A2 三层路由与 fallback 两态对照**（回溯 G1[阶段 1]/G4）

- 步骤：① frontmatter `engine: pi` 的 agent、工具显式 `engine: "zcode"`、全局默认三者各派一个；② **重启 dev app（或新建 session）重置 probe 缓存**，先把 `zcode.cjs` 改名，再在同一新 session 派两个——默认路由（无守卫）与显式 `engine: "zcode"`（守卫命中）各一，完成后改回。
- 通过标准：步骤① 三项 icon 分别 pi / zcode / zcode；步骤② 默认任务兜底成功（badge 警告态「请求 zcode → 已回退 pi」、`engineFallback.from === "zcode"`、icon 为 pi）；显式任务不兜底（`engine_probe_failed`、failed 终态——守卫语义对照，对齐父设计 A9②）。

**A3 历史重开一致性**（回溯 G3，live ≡ reload）

- 步骤：A1 完成后关闭该 session 再重开，点开同一任务。
- 通过标准：对话流与 A1 完成时一致（同一读链重放）；runtime 日志仍无降级到 ③级记录。

**A4 agent 自助改配置**（回溯 G5）

- 步骤：① 新 session 对主 agent 说「把 subagent 引擎换回 pi」；② 主 agent 经 skill 改配置并回复；③ 再新建 session 用 `subagents` 工具派一个；④ 检查侧边栏该项。
- 通过标准：config.json 改为 `defaultEngine: "pi"`；回复含「新 session 生效」语义；该项 icon 为 pi 且 drawer 对话流正常。（pi 分支不建 journal——D6，不查 `engines/pi/` 落点。）

**A5 存量字节级零回归**（回溯 G1 阶段 1 守护）

- 步骤：**实施前先取基线快照**（缺省 pi 同场景派发一次，**全量留痕**：主 session JSONL 的 SUBAGENT_RECORD 行 + 事件流 journal/onEvent 序列 + bg notify 注入 turn 的内容与时序 + 终态 record 字段与 sessionFile——entry 部分供 A5 字节级守护，全量部分供 A7 行为等价守护）；实施后删 dev config.json（回缺省 pi），新建 session 派 subagent（不传 engine），检查侧边栏与 drawer；再跑 pi 专属能力冒烟（fork 一次、message 续聊一轮）。
- 通过标准：record entry 与基线**逐字节 diff 一致**（pi record.engine 保持 undefined，undefined 字段经 JSON.stringify 自然省略——D5）；GUI 差异仅限新增 pi 缺省 icon 元素；无报错、无多余 RPC/WS 请求、无 UI 闪动；fork 与续聊行为不变。

**A6 生命周期完整（cancel / 级联 / 预检拒绝）**（回溯 G6 + 场景 5/6）

- 步骤：① 新建 session（defaultEngine=zcode）派耗时 zcode 任务（「逐文件读并汇总本目录所有 md 的标题」），运行中点该项 cancel；② 形态一：再派一个，运行中**仅关闭该 session**（app 不退）；形态二：再派一个，运行中**退出 dev app**；③ 对 zcode 任务显式传 `conversation: true` 派发。
- 通过标准：① record 转 cancelled 终态，等待 kill-chain 窗口（数秒）后 `ps aux | grep zcode.cjs` 无残留（立即 ps 可能因时间窗假阴性）；② 形态一验证 abort 链（session_shutdown → dispose：abortRunningControllers + killAllSpawnedChildren）、形态二验证 process handler 收割——两条机制分别断言，`ps` 均无孤儿；③ 工具同步返回含「不支持 conversation」与恢复指引的错误，Agents tab **无**新 record。

**A7 阶段 2 协议闭合行为等价（方向级，细化归阶段 2 设计）**（回溯 G1 终态）

- 步骤（示意）：阶段 2 落地后，chat 域 pi 派发全链路断言——事件序列（text_delta/tool_start/tool_end/turn_end/message_end 顺序与内容）、终态 record 字段、bg notify 注入 turn 的时序与内容、sessionFile 语义、fork/续聊冒烟。
- 通过标准：与 A5 步骤采集的**全量行为基线**（同一断言面：事件序列/终态字段/notify 时序/sessionFile）比对等价——转发层零可观测语义增量（**D2 允许增量豁免**：新增可选字段 / pi 新增 journal 留痕 / sessionFile 清理后②级兜底增强）；`ps`/entry 留痕面一致，journal 面比对仅适用基线已含 journal 的引擎（pi 基线采集于阶段 1 前，chat pi 尚无 journal）。

## 5. 下一层拆分

### 阶段 1（本设计可实施；U0 与 U1 并行先行，U2 汇合，U3/U4/U5 三线并行，U6 收尾）

| 单元 | 内容 | justification | 依赖 |
|---|---|---|---|
| U0 工具域路由分叉 | `ExecuteOptions.engine` + tool schema `engine` 参数 + `execute()` 入口路由 + unsupported 预检 + AbortController/spawnedChildren 终止链接线（D10）+ 引擎分支骨架（record 盖章 + pool 并发槽 + detached 执行 + 终态迁移 + notifier 复用） | 断点 1+2 唯一解；G1 阶段 1 + G6 核心 | 无 |
| U1 字段贯通 | shared `SubagentRecord` 加三项；extractor 投影同步；record-entry 补 `engineHandle` 序列化 | 断点 3 闭合；纯加法 | 无 |
| U2 引擎分支编排完备 | JournalWriter（taskId=record.id）+ probe/守卫兜底（复用 `routeEngine`）+ `engineHandle` 完整回填 | 断点 4 写入点；①②级数据源成立 | U0+U1 |
| U3 引擎标识 UI | icon 入库（复制 + currentColor）+ 映射常量 + SubagentList 最左 icon + drawer badge（fallback 警告态） | G4 交付物；纯 renderer | U1 |
| U4 zcode drawer 终态渲染 + 运行中提示 | drawer 接 engine 路由历史链（读链已就绪）+ coarse 提示文案 | G3 UI 收口 | U1+U2 |
| U5 skill | `skills/subagent-ext-config/SKILL.md`（内容清单见 D16） | G5 交付物 | 无（可先行） |
| U6 文档与登记 | 父设计勾稽（§2.4 + D11 ACP 对照表落 types.ts 注记）+ constraints.json 登记（icon 入库纪律、字节级守护、终止链） | 完成即提交纪律 | U0-U5 |

### 阶段 2（协议闭合；各单元需独立设计文档后实施）

| 单元 | 内容 | justification |
|---|---|---|
| K1 执行内核抽离 | `executeAndAwait`/`execute` 的 record 生命周期与 runSpawn 管线解耦（断点 5 手术） | 协议闭合前置；风险最集中（双消费者），独立设计收口 |
| K2 PiEngine 换芯 | PiEngine.run 委托目标从 executeAndAwait 换为无 record 执行内核 | 消除 record 双重创建；**执行结果**等价守护——record 可见性由 K4 同批恢复并扩展（现状 workflow pi 经 executeAndAwait 产 record 且 Agents tab 可见，换芯后宿主接管前会归零）。**K2+K4 为阶段 2 内原子交付对，禁止单独落地** |
| K3 chat pi 路径协议闭合 | chat 入口 pi 分支也经 EnginePort 转发；守护升级为行为等价（A7 细化） | G1 终态达成；D14 职责归属落地 |
| K4 workflow record 统一（含 D15 拍板） | workflow 任务 record 化 + `source` 域标记 + Agents tab 统一可见性 | 断点 2 的彻底闭合（两域同形）；与 K2 原子配对（换芯丢失的 record 由本单元恢复并扩展） |

阶段 2 交付原子性：K1 可先行独立交付；**K2+K4 原子对**（中间态 = workflow pi record 归零的可见性回归窗口，不可接受）；**K3 依赖 K1 + K2+K4 原子对完成**——按完整职责分层形态（chat 宿主持 record 后调 EnginePort.run，D1 终态）；若降级为最小转发形态（record 仍由 executeAndAwait 建）虽不依赖 K2，但有 worktree WorktreeHandle 注入分支缺失与 bg notify 补发两处行为坑且未达成 D1 终态，K3 详设不得采用。「可停可回退」承诺作用于**阶段边界与原子对边界**——单元粒度上 K2/K4 不可拆分交付。

### 阶段 3（预留清单，不排期）

实时流 AgentEvent 统一面（D12）· trace 枚举 read 协议（D13，参考 ACP v2 resume-replay RFD 形状）· AcpEngine 适配器（D11 插槽）· zcode 流式（上游依赖）。

**实施期待验证检查点**：

1. `pi.svg`（viewBox 800）与 `zhipu.svg`（viewBox 24）统一渲染尺寸后的视觉平衡（单色化已核可行）；
2. A2 守卫拦截与 `engineRouting.strict: true` 的报错文案区分度（两者皆 probe 相关错误，文案需可区分「显式指定被守卫拦截」vs「strict 全局拒绝」）。
