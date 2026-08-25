# Subagent 引擎 GUI 可见性贯通设计（统一派发入口 + engine 字段贯通 + 引擎标识 + ext-config skill）

> 状态：终审通过（tech-design-review 三轮对抗审查：r1 3 must-fix → r2 3 must-fix → 终审无 must-fix、4 suggestions 已吸收；达到可实施门槛，拆分见 §5）
> 层声明：当前层 = 功能设计（统一派发 + GUI 可见性贯通）；下一层 = 可实现任务拆分（接口/数据模型/UI 组件）。
> 父设计：[subagent-engine-abstraction.md](subagent-engine-abstraction.md)（§2.4 record 通道 engine-neutral 的既定预期，本设计是它的收尾切口）。

**一句话结论**：现状是「两域两执行栈」——chat 工具域有 record 但无引擎路由（恒 pi），workflow 域有路由但无 record（zcode 任务 GUI 完全不可见）——统一方案是在 `SubagentService.execute` 入口接入三层路由（缺省 pi 走现有 runSpawn 链路、record entry 字节级零变化，非 pi 走引擎分支并复用 record 全生命周期 + 终止链），配套把 `engine` / `engineFallback` / `engineHandle` 三个字段贯通到 renderer、GUI 加引擎标识（icon + badge）、按 `*-ext-config` 先例补 skill；zcode 对话流复用已就绪的 sqlite ①级读链做终态渲染，不伪造流式。

## 1. 背景目标

### SCQA

- **S（情境）**：subagent engine 抽象（P1-P5）已统一 workflow 域的执行面——pi/zcode 双引擎按三层路由派发（调用参数 > agent .md frontmatter > 全局 `defaultEngine`），fallback 三守卫、event journal、隔离池就绪；dev 环境已把 `defaultEngine` 切到 `zcode` 待真实测试。
- **C（冲突）**：派发统一只发生在 workflow 域。chat 工具域（用户在 GUI 对话里让主 agent 派 subagent 的主通道）完全不经路由——恒走 pi 直 spawn；而 workflow 域的 zcode 任务不产生任何 record——**zcode 任务在 GUI 完全不可见**（侧边栏 Agents tab 不出现、drawer 无从点开）。同时 record 已写入的 `engine` 字段在 runtime 投影时被丢弃（shared 契约无此字段）、`engineHandle` 无任何写入点、GUI 无处区分引擎、配置无 agent 自助指南。用户已把 `defaultEngine` 改成 zcode，但该配置在 chat 工具域**根本不生效**。
- **Q（问题）**：如何让引擎统一接管两个派发域，并让 record → GUI 可见性通道对全引擎成立？
- **A（答案）**：见一句话结论。

### 系统是什么（受众补认知）

xyz-agent 桌面 GUI 的 subagent 体系，当前实为**两套并行执行栈服务三个用户可见面**：

| 执行栈 | 入口 | 引擎路由 | record（GUI 数据源） | 服务哪个面 |
|---|---|---|---|---|
| chat 工具域 | `subagents` 工具 action:'start' → `SubagentService.execute` → `runSpawn`（pi 直 spawn） | ❌ 无（恒 pi） | ✅ 有 | 侧边栏 Agents tab、drawer 对话流 |
| workflow 域 | workflow 脚本 step → SAR（SubprocessAgentRunner）→ routeEngine → PiEngine / ZcodeEngine | ✅ 三层路由 | ❌ 无（workflow 面走 WorkflowTab 独立提取器） | WorkflowTab（本设计 out of scope） |

「引擎」一句话：pi = 本项目深度集成的默认执行引擎（子进程 pi CLI，有实时流、会话文件、会话续聊）；zcode = 新接入的替代执行引擎（ZCode.app 内置 CLI，单轮执行、stdout 终态单 JSON、数据存 sqlite）。

### 设计目标

- **G1 引擎统一派发**：chat 工具域接入三层路由——`defaultEngine` / agent frontmatter / 调用参数都能选中 zcode；缺省（不配置）时 pi 分支**代码与 record entry 字节级零变化**（父设计 A1 硬约束）。
- **G2 字段贯通**：`record.engine` / `engineFallback` / `engineHandle` 从 extension entry 贯通到 renderer store（缺省 = pi，存量 session 零迁移）。
- **G3 zcode 对话流**：zcode 任务（chat 工具域派发）出现在 Agents tab，点开 drawer 能看到完整对话（终态渲染，引擎能力边界内做到最全）。
- **G4 引擎标识**：侧边栏 item 最左显示引擎 icon；drawer 有引擎 badge；fallback 兜底留痕可见（警告条）。
- **G5 配置自助**：`subagent-ext-config` skill 让主 agent 能查/改引擎配置并正确告知生效时机（session_start 重读、新 session 生效）。
- **G6 生命周期完整**：zcode 任务的 cancel、进程终止与会话级联不留孤儿进程（父设计 A10 无僵尸断言延伸到 chat 域 zcode 分支）。

### In / Out of scope

**In**：G1-G6 全部；`subagents` 工具 schema 增加 `engine` 参数（第一层路由输入）；icon 资源入库（从 llm-simple-router 复制进本仓）。

**Out**（明确不做，防 scope 蔓延）：

- zcode 运行中逐字实时流——引擎 stdout 只有终态单 JSON（capabilities `eventGranularity: "coarse"`），伪造流式动画是反模式；上游提供流式通道后再议。
- workflow 域（WorkflowTab）的 zcode step 对话流可见性——workflow 面走独立提取器（workflow-extractor），与本设计的 Agents tab/drawer 通道不同；字段贯通（G2）对它是无害前置，UI 接入待独立需求。
- GUI 设置面板（System settings Section）——用户本次明确走 skill 方向；GUI 面待独立需求确认后另行设计。
- pi 引擎任何行为变化——缺省路径零变化是硬约束（见 §3.3 D1）。
- zcode 的 conversation（续聊 message/close）、fork、worktree 支持——capabilities 声明 unsupported/none，本设计在 zcode 分支预检显式拒绝并给恢复指引，不做仿真。
- workflow 域 SAR 的 journal taskId（`sa-` uuid 与 record 无关联）缺陷修复——本设计在 chat 域用 record.id 规避（D4），workflow 域改造属父设计遗留。

## 2. 现状与问题分析

### 2.1 物理数据链（现状，两域两栈）

**chat 工具域（本设计主战场）**：

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
    → shared SubagentRecord[]（无 engine 字段的契约类型）
  WS → renderer（SubagentList.vue / SubagentTab.vue）
```

**workflow 域（已统一，供对照）**：

```
workflow step（engine: "zcode"）
  → SAR.run → routeEngine（三层 + probe + fallback 守卫）
      pi 快路径：本地 DI 绑定 PiEngine
      zcode：registry → ZcodeEngine.run（隔离池 + journal + kill-chain）
      journal 落盘 engines/<engineId>/<poolKey>/journal-<taskId>.jsonl
      run 返回 handle（SAR 再 backfill journalPath）
  ← 无 record：结果只回流 workflow 引擎自身，Agents tab 看不到
```

**drawer 历史链与实时链（两域共用面）**：历史 `SubagentTab → getAgentCallHistory RPC → session-service.getSubagentHistory`——按 `record.sessionFile` 直读（pi JSONL），非 pi 分支 `subagent-engine-history` 三级降级（①zcode sqlite reader ②journal 重放 ③outcome-only，读侧已就绪、防御式等待写侧字段）；实时 `relay tee → subagent.stream_delta WS`（仅 pi spawn 通道）。

### 2.2 四个断点（逐行实测，含审查复证）

- **断点 1（工具域无路由）**：`startHandler → service.execute` 参数无 engine，`execute → runSpawn` 全链路无 `routeEngine`/engine 字段消费——chat 工具恒 pi，`defaultEngine` 对它不生效。证据：`subagent-actions.ts` start 分支的 `service.execute({...})` 参数清单；`session-runner.ts` 全文无路由引用；SAR 的消费方仅有 orchestration launcher（`index.ts` LauncherDeps 注入）。
- **断点 2（workflow 域 zcode 无 record）**：`ZcodeEngine.run` 全链路（SAR → registry → engine）不触碰 SubagentService 的 record 创建/appendEntry——zcode 任务在 Agents tab 不出现，drawer 无从点开。
- **断点 3（投影丢三字段）**：shared `SubagentRecord`（`packages/shared/src/subagent.ts:38`）无 `engine`/`engineFallback`/`engineHandle`；extractor 投影（`subagent-extractor.ts:206-247`）字段清单同样无。而写侧 entry 已有 `engine` + `engineFallback`（`record-entry.ts:88` 一带，`toSubagentRecordEntry` 投影两字段）——engine 其实已躺在主 session JSONL 里（workflow/续聊路径写入），消费端整体丢弃。
- **断点 4（engineHandle 无写入）**：SAR run 返回的 handle（zcode 定位符 `sessionRef`/`poolKey`，SAR 再 backfill `journalPath`）只存在内存，无任何路径进 record entry——历史链 ①② 级拿不到定位符，防御式降级到 ③ outcome-only。

**读侧已全部就绪（P5 预埋）**：`subagent-engine-history.ts` 的 `extractRecordEngine()`（undefined/空串回 pi、非空值透传）/ `extractRecordEngineHandle()`（`{sessionRef, journalPath?, poolKey}` 防御解析）已实现，头注释明示等待写侧字段。①级硬要求 `sessionRef` 同时含 `dbPath + sessionId`，缺一即降级——写侧回填必须完整。

### 2.3 断点结论的两轮翻转（诚实记录，防后人再翻）

本断点链的认定经历三轮：

1. **初判（模型审查 subagent 报告）**：zcode 无 record、background start 绕过 engine——**结论正确**，但当时证据链未留行号。
2. **误修正（本设计 r1）**：笔者据「execute() 内 record 无条件创建、start 分支统一走 service.execute」误判前两条为审查误报——错在把「execute 创建 record」当成「所有引擎都经 execute」：execute 的两个调用方（startHandler、PiEngine.run）都是 pi 路径，zcode 根本不进 execute。
3. **审查复证（tech-design-review，双向验证）**：正向（tool → service → runSpawn 无路由）+ 反向（SAR 消费方 grep 确认仅 workflow 域）双向排除「service 内隐藏路由」的可能，初判恢复成立。

教训（对齐全局规则 13）：调用链断言必须**双向**验证（正向追入口、反向追消费方），单向追入口会把「入口存在」误读为「所有路径都过该入口」。

### 2.4 配置实时性与 probe 缓存语义（实测）

**配置读取**：`ModelConfigService` 在**构造时**与**每次 `session_start`**（`initModel` 步骤 1）各调一次 `loadGlobalConfig`（`fs.readFileSync`）；session 存续期内不重读。推论：同一 session 里改 `config.json` → 该 session 内后续派发仍用旧引擎；**新建 session 后生效**（xyz-agent 每个 chat session 一个 pi 子进程）。

**probe 缓存**：`ZcodeEngine.probe` 成功后缓存直返（无 TTL、无二进制重查），进程存活期内不再重探。推论：同一 session（同一 pi 子进程）内 zcode 探针成功后再破坏 zcode CLI，后续路由**命中缓存不触发兜底**——fallback 留痕只在探针未缓存时发生（典型：新 session 首次路由前 CLI 已损坏）。fallback 验收场景必须新建 session 重置缓存（§4 A2）。

### 2.5 zcode 引擎能力边界（capabilities 声明，实测背书）

| 能力 | 等级 | 对本设计的含义 |
|---|---|---|
| `eventGranularity` | `coarse`（stdout 终态单 JSON） | 运行中无逐字流，drawer 显示运行态 + 提示，不伪造动画 |
| `sessionRead` | `full`（sqlite 三级 JOIN 完整重建 turns） | 终态后 drawer 可渲染完整对话（prompt + response） |
| `conversation` / `steer` / `worktree` | `unsupported` / `unsupported` / `none` | zcode 分支预检显式拒绝 + 恢复指引，不仿真 |

## 3. 解决方案

### 3.1 终态（使用者视角先行）

**场景 1 — zcode 任务全程可见**：dev 环境 `defaultEngine=zcode`，用户在新建 session 里让主 agent 派个 subagent（「列出 src 目录文件并统计行数」）。主 agent 调 `subagents` 工具（不传 engine，走全局默认 zcode）。侧边栏 Agents tab 立即出现该项，**最左边是 zcode 引擎 icon**；运行中显示 spinner 与「zcode 引擎：运行中（该引擎不支持实时流，结束后可查看完整对话）」提示；完成后点开 drawer，看到完整对话——任务正文（user）与 assistant response（可含多轮 turns / toolCalls），顶部 badge 标注 `zcode`；主 agent 同步收到 bg notify 注入的结果。关闭重开 session，这个对话流仍可读（sqlite 持久）。

**场景 2 — 双引擎并存与显式指定**：同一环境里 agent .md frontmatter 声明 `engine: pi` 的任务、工具调用显式传 `engine: "zcode"` 的任务、走全局默认的任务并存，三层路由各得其所，侧边栏 icon 一目了然。

**场景 3 — fallback 兜底留痕可见**：新 session 首次路由前 zcode CLI 已损坏（探针失败且未缓存），全局默认 zcode 的任务在无守卫命中时兜底回退 pi（守卫语义：显式指定 `engine: "zcode"` 属守卫命中，**不**兜底、报 `engine_probe_failed`——两态对照见 A2），record 带 `engineFallback: { from: "zcode", reason: "engine_probe_failed" }`，drawer badge 显示「请求 zcode → 已回退 pi」警告样式，点击展开恢复指引（检查 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` 或重装 ZCode.app）。

**场景 4 — agent 自助改配置**：用户对主 agent 说「把 subagent 引擎换回 pi」。主 agent 加载 `subagent-ext-config` skill，按指引改 `~/.xyz-agent-dev/pi/agent/subagents/config.json` 的 `defaultEngine`，回复「已改，新 session 生效」。

**场景 5 — zcode 参数预检拒绝（失败路径）**：对 zcode 任务传 `conversation: true` → 工具调用**同步返回**结构化错误「zcode 引擎不支持 conversation（capabilities.conversation = 'unsupported'）。恢复指引：改用 engine: pi，或不传该参数」——预检发生在 record 创建之前（与 task 为空/slug 超长同类的请求校验语义，无 record 留痕），agent 收到错误可立即换引擎重试。

**场景 6 — cancel 与会话级联无孤儿**：zcode 任务运行中，用户点 Agents tab 该项的 cancel → record 转 cancelled 终态、zcode 子进程经 kill-chain（SIGTERM→grace→SIGKILL）退出；zcode 任务运行中直接关闭 session/退出 app → shutdown 收割兜底杀掉子进程——`ps` 无残留 zcode 进程。

**其他失败路径**：`config.json` 坏值（`defaultEngine: 123`）→ sanitizer 静默回缺省 pi（既有行为）→ skill 写明合法值域；zcode run 失败 → record.error = `engine_run_failed: zcode CLI...`（文案自带恢复指引）。

### 3.2 方案对比（统一派发入口怎么建）

**方案 A：service.execute 入口路由分叉，保留两条执行栈（推荐）**

- 做法：`ExecuteOptions` 加 `engine`；`execute()` 在 record 创建前用 `resolveEngineRouting`（routing.ts 同步纯函数）解析路由。结果为 pi（缺省）→ 原有 runSpawn 链路一行不动、record entry 不增字段；非 pi → 引擎分支：预检 unsupported 参数（场景 5）→ `createRecordForMode` 盖章 engine → 复用 runAndFinalize 的**组成件**（`pool.acquire` 并发槽 / `finalizeRecord` 终态路径 / notifier bg notify——runAndFinalize 本体硬编码 runSpawn 不可直接调用；`maxConcurrent` 并发槽对 zcode 分支同样生效，统一并发治理）→ detached 执行 `registry.getEngine(id).run(...)`（JournalWriter + kill-chain + AbortController 终止链见 D10）→ 终态回填 `engineHandle` → 状态迁移 appendEntry。
- 长期合理性：两条执行栈是现实（pi 栈承载 fork/续聊/worktree 等深度集成，SAR 栈承载 engine-neutral），路由统一在 service 入口 = 用户语义统一（「派 subagent」一个心智模型），栈内实现差异被 capabilities 声明收口；读侧契约（P5 预埋）原样兑现。
- 短期成本：中等——service 路由分叉 + 引擎分支编排 + 字段贯通 + UI，约 8-10 文件。
- 风险：中低——pi 路径零触碰（分叉点在 pi 分支之前纯加法）；引擎分支是新代码但有 workflow 域同款编排作参照与测试基线。

**方案 B：chat 工具域整体迁移到 SAR（service.execute 全量改走 SAR.run）**

- 架构上「单栈」最干净，但 pi runSpawn 承载 fork（--fork session 分支）、续聊（message/close）、bg notify、pending-notifications 集成等大量 pi 专属语义，SAR.PiEngine 是为 workflow 设计的简化路径——全量迁移等于重写 subagent 核心执行链，回归面覆盖全部存量功能。
- 若用它，§2.1 的 chat 域例子会变成：每一个现有 pi subagent 功能（fork、续聊、worktree）都需要在 SAR 栈重新实现一遍才能不回退——为统一而统一，代价与收益完全不成比例。
- 结论：否。长期若 SAR.PiEngine 能力对齐后可再评估收敛（记入父设计遗留项）。

**方案 C：不动工具域，zcode 仅 workflow 域可用 + workflow 域补 record**

- 成本最小，但直接违背 G1（用户已改 `defaultEngine=zcode` 期望 chat 生效——此方案下他的配置永远无效）。「engine 统一」的用户诉求落空。
- 结论：否。

### 3.3 关键决策与权衡

**D1 缺省路径零变化（A1 硬守护）**：路由分叉点在 `execute()` 早期（record 创建前）；解析结果为 pi 时走原有代码路径——**pi 分支的 record.engine 保持 undefined（现状）**，entry 序列化字节不多一个字段，`resolveEngineRouting` 是同步纯函数（pi 恒免探）不引入新 await。缺省 pi 的引擎归属由**读侧/渲染侧缺省映射**承担（extractRecordEngine 现状即 undefined→pi；icon 映射同理，见 D6）——「pi 是缺省」这一事实在投影/渲染层表达，不在写侧盖章。被否：给 pi record 也盖章 `engine: "pi"`——写侧必改 pi 路径代码 + entry 字节变化，A5 的字节级断言失败，为纯冗余信息破坏零变化守护。

**D2 tool schema 增加 `engine` 参数（第一层路由输入）**：`subagents` 工具 start 参数加可选 `engine`（enum：已注册引擎 id，description 写明缺省继承全局配置）。frontmatter（第二层）与全局默认（第三层）不变。**未注册 id**（如 `engine: "claude"`）与 frontmatter 同语义：报 `engine_not_found`（配置错误前置暴露，不留到运行时）——路由侧拦截后运行期 record 永不含未注册 engine 值（渲染层的中性圆点仅为历史/手编数据防御，见 D6）。被否：不加参数只靠 frontmatter/config——用户在对话中临时切换引擎（场景 2）无法表达，且 agent 无法显式声明意图（隐式依赖全局态，prompt 不可自包含）。

**D3 字段形状 = 读侧预埋契约原样，三项齐全**：`engine?: string`；`engineFallback?: { from, reason }`；`engineHandle?: { sessionRef: Record<string,string>, journalPath?: string, poolKey: string }`。shared `SubagentRecord` 与 extractor 投影**同步加三项**（engineFallback 若漏，场景 3 的警告条无数据源——r1 审查 must-fix 教训）。投影守卫对齐读侧现状语义：**undefined/空串 → pi（缺省映射），非空值透传**（extractRecordEngine 现状即此，D3 不改变它）。被否：只加 engine——G4 的 fallback 留痕与 G3 的 ①②级读链全部断供。

**D4 引擎分支编排自含、journal taskId = record.id、engineHandle 回填顺序确定**：zcode 分支内自建 JournalWriter（复用 `paths.ts` 同源路径），**taskId 取 `record.id`**（而非 workflow 域 SAR 的 `sa-${uuid}` 占位）——journal 文件名与 record 天然关联，refs.json 按 taskId 联动删 journal 在 chat 域成立（顺带修复 SAR 注释自认的「GC 无法联动」缺陷在 chat 域的形态）。编排顺序：JournalWriter → `engine.run` → **run resolve 后、终态迁移 entry 落盘前**回填 `record.engineHandle`（含 journalPath 与 `sessionRef.dbPath + sessionId` 完整对——①级硬要求）→ 终态迁移 appendEntry。分支内顺序自控，为确定性顺序。**pi 分支不建 journal、不写 engineHandle**（sessionFile 即定位符，journal 对 pi 是冗余写入）。zcode sqlite reader 以 `sessionRef.sessionId` 锚定目标 session、缺省取池内最新（time_created DESC）——schema 强化重试产生两个 session 时读**末轮**，与 outcome.usage 口径一致（已核实 reader 实现）。

**D5 zcode 对话流 = 终态渲染，运行中如实提示**：终态经 `getSubagentHistory` 的 engine 路由走 ①级 sqlite reader（`sessionRead: "full"`）；运行中 drawer 显示状态提示文案，不伪造逐字动画。验收以「assistant turn 含 toolCalls」+「runtime 日志无 `subagent-engine-history` 降级记录」区分①②③级（toolCalls 为①级 sqlite 真实 turns 独有，②级 journal 只有合成 coarse 事件）——见 §4 A1/A3。

**D6 icon 映射三分支**：`undefined/空串 → pi icon（缺省映射）`；`已注册 id → 对应 icon`（`pi → pi.svg`、`zcode → zhipu.svg`——llm-simple-router 资产库无 zcode 专属 icon，ZCode 是智谱产品品牌归属成立，后续出专属 logo 可替换，映射表收敛在单一常量文件）；`未知非空值 → 中性圆点（纯防御分支——D2 路由侧拦截后运行期不可达，仅覆盖历史/手编 entry）`。源：`~/Code/llm-simple-router-workspace/main/frontend/src/assets/icons/`，**复制进 `packages/renderer/src/assets/icons/engine/`**（禁止外部路径引用/symlink——pre-commit 目录规范红线）；入库统一转 `currentColor` 单色（太极纯灰设计系统禁止硬编码颜色；两源文件已核：`pi.svg` 为单色像素几何块（fill="#09090b"），`zhipu.svg` 为 24x24 单 path（fill="#3859FF"，入库时替换为 currentColor）——单色化可行，方块几何 vs 圆润曲线的形状语言差异足以辨识）。

**D7 侧边栏 icon 位置 = item 最左**：`SubagentList.vue` item 现结构「状态指示（spinner/statusDot）+ agent 名 + task 摘要」，引擎 icon 插在状态指示之前成为第一元素，`size-[13px]` 与状态指示同级（贴现有 scale）。drawer badge 放对话流顶部工具栏（引擎名 + fallback 警告态）。

**D8 skill = `subagent-ext-config`，对齐四先例**：先例 `scheduler-ext-config` / `permission-ext-config` / `smart-context-ext-config` / `rename-session-ext-config`（「使用/排查该 extension 时加载，讲清配置位置 + 字段 + 生效时机」模式）。内容必备：config.json 三环境路径（独立 pi = `~/.pi/agent/subagents/config.json`；xyz-agent dev = `~/.xyz-agent-dev/pi/agent/subagents/config.json`；prod = `~/.xyz-agent/pi/agent/subagents/config.json`——教 agent 读 `PI_CODING_AGENT_DIR`/`XYZ_AGENT_DATA_DIR` env 动态推导，不写死）、字段表（`defaultEngine` 合法值 / `engineRouting.strict` / `maxConcurrent`）、**三层路由与生效时机（session_start 重读、新 session 生效；probe 缓存语义——进程存活期内不重探）**、验证命令（派发后看 `~/.xyz-agent-dev/engines/<engineId>/` journal 落点与 Agents tab icon）。放 `extensions/universal/subagent-workflow/skills/subagent-ext-config/`（package.json 已声明 `pi.skills`，通路现成）。

**D9 配置实时性维持现状（不加 watcher）**：session_start 重读已满足「改完开新 session 即生效」；fs watcher 引入新失败面且无真实需求背书。skill 写明生效语义。

**D10 zcode 分支终止链（生也要死）**：三条终止路径全覆盖——① **spawnedChildren 同构注册**：zcode 分支 spawn 的子进程注册进 `session-runner.ts` 的 `spawnedChildren` 记账（`Map<recordId, ChildProcess>`，现仅 pi runSpawn 注册），shutdown 收割兜底（`killAllSpawnedChildren`）由此覆盖 zcode；② **AbortController + signal wire**：zcode 分支 record 持有 AbortController（与 pi record 同语义），`controller.signal` wire 到 `RunContext.signal` → 引擎 kill-chain（SIGTERM→grace→SIGKILL 两级完整）——用户 cancel（`cancelBackground → controller.abort`）天然生效；③ **会话级联挂进 pi 侧现成编排**：`dispose()`（`session_shutdown` handler 调用，[R0/C1 孤儿进程修复]）的编排 `abortRunningControllers() → killAllSpawnedChildren() → disposeAllRecords("parent-shutdown")` 对 zcode record 天然生效——前两级（abort 触发 kill-chain + 记账收割）即 zcode 在「仅关闭 session」形态下的双保险，挂载点已存在无需新建；app 退出形态由 process handler（index.ts shutdown 兜底）收割。`/fork` `/new` 路径的 `disposeAllRecords` 不 abort 属 pi 既有行为，zcode 对齐现状不引入差异。验收见 A6。

### 3.4 终态数据流（统一后，chat 工具域）

```
GUI「派个 subagent 做 X」
  subagents 工具（engine? 参数）→ startHandler（透传 engine）
  SubagentService.execute()
    resolveEngineRouting(参数 engine > frontmatter > defaultEngine)   ← D1/D2，同步纯函数
    ├─ pi（缺省）→ runSpawn 现有链路（代码与 entry 字节级零变化；
    │              record.engine 保持 undefined，归属由读侧缺省映射表达）
    └─ zcode → 引擎分支：                                             ← D4/D10
        预检 unsupported 参数（conversation/fork/worktree → 同步拒绝，无 record）
        createRecordForMode（engine 盖章）+ AbortController
        pool.acquire 并发槽（maxConcurrent 统一生效）
        JournalWriter（taskId = record.id，engines/zcode/<poolKey>/journal-<recordId>.jsonl）
        probe/守卫失败且无守卫命中 → 兜底回 pi（engineFallback 盖章）
        registry → ZcodeEngine.run（隔离池 + kill-chain ← controller.signal；
                  子进程注册 spawnedChildren）
        run resolve → 回填 record.engineHandle{sessionRef(dbPath+sessionId), journalPath, poolKey}
        终态迁移 → appendEntry 快照（engine + engineFallback + engineHandle）→ 主 session JSONL
        notifier bg notify → 主 agent 新 turn 收结果
runtime
  extractor 投影三项（D3）→ shared SubagentRecord[] → WS → renderer
  getSubagentHistory：engine=zcode → ①sqlite reader（sessionRef 定位）②journal ③outcome
renderer
  SubagentList：record.engine → icon 三分支映射（D6/D7）
  drawer：badge（含 engineFallback 警告态）+ 终态对话渲染 + coarse 运行中提示
```

## 4. 验收（真实场景，实施后在真机执行；三要素：场景/步骤/通过标准，均经 chat 工具域派发）

> 测试环境：`set -a && source .env.dev-extensions && set +a && pnpm dev`（本地 extension 源码）+ dev config `~/.xyz-agent-dev/pi/agent/subagents/config.json`。

**A1 zcode 任务全程可见**（回溯 G1/G2/G3/G4）

- 步骤：① `defaultEngine: "zcode"` 写入 dev config.json；② dev app **新建 session**，让主 agent 用 `subagents` 工具派 subagent：「列出当前目录的 .ts 文件并统计总行数」；③ 等待完成；④ 点开侧边栏 Agents tab 该项的 drawer；⑤ 主 agent 对话流确认收到 bg notify 结果。
- 通过标准：侧边栏该项最左是 zcode icon（DOM 断言 `data-testid` 定位）；drawer 渲染 ≥1 条 user 消息与 ≥1 条 assistant 消息且内容非空，且 assistant turn 含 toolCalls 断言（区分①级 sqlite 真实 turns 与②级 journal 合成 coarse 事件——①级独有 toolCalls），runtime 日志无 `subagent-engine-history` 降级记录；drawer badge 显示 `zcode`；主 agent 后续 turn 含 subagent 结果摘要。

**A2 三层路由与 fallback 两态对照**（回溯 G1/G4）

- 步骤：① 准备 frontmatter 带 `engine: pi` 的 agent .md，同 session 分别经它（第二层）、经工具显式 `engine: "zcode"`（第一层）、经全局默认（第三层）各派一个任务；② **重启 dev app（或新建 session）**使 probe 缓存重置，先把 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` 改名，再在同一新 session 里派两个任务——一个走全局默认 zcode（无守卫命中），一个显式传 `engine: "zcode"`（守卫命中：显式指定不兜底），完成后把 CLI 改回。
- 通过标准：步骤① 三项 icon 分别为 pi / zcode / zcode（三层各得其所）；步骤② 默认任务兜底成功——badge 警告态、文案含「请求 zcode → 已回退 pi」、record 数据 `engineFallback.from === "zcode"`、icon 显示 pi（实际执行引擎）；显式任务**不兜底**——报 `engine_probe_failed`、record failed 终态（守卫语义对照，对齐父设计 A9②）。

**A3 历史重开一致性**（回溯 G3，live ≡ reload）

- 步骤：A1 完成后关闭该 session 再重开，进 Agents tab 点开同一任务。
- 通过标准：对话流与 A1 完成时一致（同一读链重放，不依赖内存态）；重开路径下 runtime 日志仍无降级到 ③级的记录。

**A4 agent 自助改配置**（回溯 G5）

- 步骤：① 新 session 对主 agent 说「把 subagent 引擎换回 pi」；② 主 agent 经 skill 改配置并回复；③ 再新建 session 用 `subagents` 工具派一个 subagent；④ 检查侧边栏该项。
- 通过标准：config.json 改为 `defaultEngine: "pi"`；agent 回复含「新 session 生效」语义；该项 icon 为 pi 且 drawer 对话流正常。（备注：pi 分支不建 journal——D4 定稿，故不查 `engines/pi/` 落点。）

**A5 存量零回归**（回溯父设计 A1 硬约束）

- 步骤：**实施前先取基线快照**（缺省 pi 环境同场景派发一次，留存主 session JSONL 中的 SUBAGENT_RECORD 行）；实施后删除 dev config.json（回缺省 pi），新建 session 派 subagent（不传 engine），检查侧边栏与 drawer；再跑一遍既有 pi 专属能力冒烟（fork 一次、message 续聊一轮）。
- 通过标准：record entry 与实施前基线**逐字节 diff 一致**（pi record.engine 保持 undefined，undefined 字段经 JSON.stringify 自然省略——D1）；GUI 差异仅限新增的 pi 缺省 icon 元素（D6 缺省映射），无报错、无多余 RPC/WS 请求、无 UI 闪动；fork 与续聊行为不变。

**A6 生命周期完整（cancel / 级联 / 预检拒绝）**（回溯 G6 + 场景 5/6）

- 步骤：① 新建 session（defaultEngine=zcode）派一个耗时 zcode 任务（如「逐文件读并汇总本目录所有 md 的标题」），运行中点 Agents tab 该项 cancel；② 形态一：再派一个，运行中**仅关闭该 session**（app 不退）；形态二：再派一个，运行中**退出 dev app**；③ 对 zcode 任务显式传 `conversation: true` 派发。
- 通过标准：① record 转 cancelled 终态，等待 kill-chain 窗口（SIGTERM→grace→SIGKILL，数秒）后 `ps aux | grep zcode.cjs` 无该子进程残留（立即 ps 可能因时间窗假阴性）；② 形态一验证 abort 链（session_shutdown → dispose：abortRunningControllers + killAllSpawnedChildren），形态二验证 process handler 收割——两条不同机制分别断言，`ps` 均无 zcode 孤儿进程；③ 工具同步返回含「不支持 conversation」与恢复指引的错误，Agents tab **无**新 record（预检在 record 创建前拒绝）。

## 5. 下一层拆分

| 单元 | 内容 | justification | 依赖 |
|---|---|---|---|
| U0 工具域路由分叉 | `ExecuteOptions.engine` + tool schema `engine` 参数 + `execute()` 入口路由（pi 缺省原路、非 pi 抛给 U2）+ unsupported 参数预检（record 创建前同步拒绝）+ AbortController/spawnedChildren 终止链接线（D10）+ 引擎分支骨架（record 盖章 + pool 并发槽 + detached 执行 + 终态迁移 + notifier 复用） | 断点 1+2 的唯一解；G1+G6 的核心交付物；先做因为它决定后续字段写入点与终止面 | 无 |
| U1 字段贯通 | shared `SubagentRecord` 加 `engine`/`engineFallback`/`engineHandle` 三项；extractor 投影同步；record-entry 补 `engineHandle` 序列化 | 断点 3 一次闭合；纯加法（旧 entry 无字段 → undefined → pi 投影） | 无（可与 U0 并行） |
| U2 引擎分支编排完备 | JournalWriter 接入（taskId = record.id）+ probe/守卫兜底接入（复用 routing.ts `routeEngine`）+ `engineHandle` 完整回填（dbPath+sessionId+journalPath） | 断点 4 的写入点；D4 全部细节；①②级数据源由此成立 | U0+U1 |
| U3 引擎标识 UI | icon 资源入库（复制 + currentColor 单色化）+ 引擎→icon 三分支映射常量 + SubagentList item 最左 icon + drawer badge（含 fallback 警告态） | G4 交付物；纯 renderer 改动 | U1（字段到 store） |
| U4 zcode drawer 终态渲染 + 运行中提示 | drawer 消费 engine 路由历史链（读链已就绪，主要是接线验证）+ coarse 提示文案 | G3 的 UI 收口 | U1+U2 |
| U5 skill | `skills/subagent-ext-config/SKILL.md`（D8 清单，含 probe 缓存语义） | G5 交付物；独立于代码改动 | 无（可先行） |
| U6 文档与登记 | 父设计 §2.4 勾稽 + constraints.json 登记（icon 入库纪律、缺省零变化守护、终止链）+ 父设计 A10 无僵尸断言延伸说明 | 完成即提交纪律 + 约束登记流程 | U0-U5 |

拆分依据：U0 与 U1 是两条互不阻塞的数据/控制通路，先行；U2 依赖两者汇合（编排需要字段写入点存在）；U3/U4/U5 在 U1/U2 后并行（renderer / 验证 / 文档三个文件域互不冲突）；每单元独立可验收（U0→A2 三层路由与 A6 预检/终止、U1→A1/A5 字段断言、U2→A1 ①级断言与 A2 兜底、U3→A1/A2 UI 断言、U4→A1/A3、U5→A4、U6→A5 字节级）。

**实施期待验证检查点**（设计阶段无法确定，诚实标注）：

1. `pi.svg`（像素几何块，viewBox 800）与 `zhipu.svg`（曲线，viewBox 24）入库统一尺寸后的视觉平衡（单色化可行性已核，两源形状语言差异足以辨识；渲染尺寸归一时需实测协调）；
2. A2 步骤② 的「守卫命中不兜底」报错文案与 `engineRouting.strict: true` 模式的报错区分度（两者都报 probe 相关错误，文案需可区分「显式指定被守卫拦截」vs「strict 全局拒绝」）。
