# 设计：subagent 引擎感知注入（current engine + 引擎适配模型清单 + 切换通知）

> **一句话结论**：system prompt 每 turn 渲染「当前默认引擎 + 该引擎适配的模型清单」（状态面），引擎变更在检测到的 turn 向对话流发一条**不含清单**的短通知（事件面）——去重由构造保证（清单永远只活在 system prompt 一份），不需要注入账本。

> **层声明**：当前层 = 技术方案设计；下一层 = 代码实现（`extensions/universal/subagent-workflow/` 内，含测试）。不跨层到具体测试用例逐条设计。

---

## 1. 背景目标

### SCQA

- **S（情境）**：subagent-workflow 扩展支持多执行引擎（pi / zcode），生效引擎由三层路由决定（调用参数 `engine` > agent .md frontmatter `engine` > 全局 `subagents/config.json` 的 `defaultEngine`）。不同引擎的模型 registry 完全不同：pi 引擎用主 agent registry（zai-coding-cn 等），zcode 引擎用 `~/.zcode/v2/config.json` 的 provider 表（builtin:bigmodel-coding-plan 等）。
- **C（冲突）**：主 agent AI 对「当前生效引擎」没有权威信息源。system prompt 里的 `<available_provider_models>` 段只覆盖 pi registry；zcode 引擎段只在 defaultEngine 非 pi 时注入，且没有「当前引擎是什么」的显式声明。全局 AGENTS.md 的模型路由表又对引擎无感知。AI 按 pi registry 的模型 id 派发，被路由到 zcode 引擎后在 prepare 期才报 `model_not_available`——派发已返回成功，失败延迟多轮才可见（2026-08-28 事故，已归因）。
- **Q（问题）**：如何让 AI 在**任意时刻**都知道当前默认引擎是什么、该引擎下哪些模型 id 可派发，且引擎中途切换时能感知到变更？
- **A（答案）**：双面注入——状态面（system prompt 每 turn 现值）+ 事件面（对话流边沿通知），见 §3。

### 系统是什么（受众补足）

读者假设：会用 pi / xyz-agent 派发 subagent，但不了解 subagent-workflow 内部的开发者。

- **注入器机制**：扩展通过 pi 的 `before_agent_start` hook（每次用户提交 prompt 后、agent loop 前）向 system prompt **尾部追加** XML 段。多个 handler 链式叠加，注册顺序决定段序。现有四段：`<available_subagents>`、`<available_workflows>`、`<available_provider_models>`（每 turn 从 `ctx.modelRegistry.getAvailable()` 现值渲染）、defaultEngine 非 pi 时追加 `<available_zcode_models>`。
- **对话流注入机制**：扩展可经 `pi.sendMessage({customType, content, display, details}, {triggerTurn?, deliverAs?})` 向会话投递 custom message——content 进 LLM 上下文，subagent 完成通知（notifier）已用此通道（`src/execution/notifier.ts:86`）。
- **引擎配置**：全局默认引擎写在 `<agentDir>/subagents/config.json`（agentDir 由 pi 决定：xyz-agent 桌面下是 `~/.xyz-agent/pi/agent`，独立 pi CLI 下是 `~/.pi/agent`）。

### 目标（从使用者体验倒推）

使用者 = **主 agent AI**（消费注入信息的直接用户）+ 派发结果的间接受益者（终端用户）。

- **G1（初始感知）**：session 首个 turn 起，AI 能从 system prompt 直接读出：当前默认引擎是什么、该引擎下可派发的模型 id 清单、清单适配哪个引擎。
- **G2（变更感知）**：对话中途 defaultEngine 被修改（用户手编 config / 未来 GUI 切换），在**下一个 turn**：AI 收到「引擎已从 A 切到 B」的对话流通知；该 turn 的 system prompt 已是新引擎状态；实际路由（subagent 派发）也按新引擎执行。对齐范围见 D2 的精确声明：**检测到变更的 session 三处同 turn 对齐**；同进程其他 session 在各自下一 turn 对齐（窗口期语义见 D2）。
- **G3（不重复）**：反复切换（A→B→A）不产生重复的模型清单注入；上下文中任意时刻模型清单只存在一份（system prompt 现值）。
- **G4（诚实降级）**：config 读失败、引擎未注册、引擎无凭据模型等异常形态，注入段如实声明，不静默、不伪造。

### In / Out scope

**In**：全局 `defaultEngine` 的检测、system prompt 状态段渲染、切换对话流通知、检测到变更时同步 reload 路由配置（G2 的三处对齐）、pi 与 zcode 两引擎、多 session 并行。

**Out**（明确不做，防 scope 蔓延）：
- per-agent frontmatter `engine` 的清单标注（`<available_subagents>` 段增强，独立小改动另做）
- 派发时点的模型预检（dispatch-time validation，上一轮分析的 A1，独立设计）
- GUI 引擎切换写路径（engines.json 读侧已有 `syncEnginesFile`；本设计只承诺 GUI 未来写 config.json 后自动被检测）
- 模型清单**内容**变更的通知（引擎没变、v2 config 加了 provider——由 prompt 现值天然反映，不发事件）
- 全局 AGENTS.md 路由表修订（文档层，另行处理）

---

## 2. 现状与问题分析

### 2.1 现有注入链路（取自代码，非编造）

```
pi before_agent_start（每 turn，用户提交 prompt 后）
  ├─ handler 1: <available_subagents>        (setupSubagentListInjector)
  ├─ handler 2: <available_workflows>        (setupWorkflowListInjector)
  ├─ handler 3: <available_provider_models>  (setupModelListInjector)
  │    每 turn 现值渲染：ctx.modelRegistry.getAvailable()
  │    码点序排序保证字节稳定（cache 前缀友好），src/injectors/model-list-injector.ts:86
  └─ handler 4: <available_zcode_models>     (src/index.ts:649-658)
       条件：defaultEngine ≠ 'pi'（src/execution/engine/model-prompt.ts:43）
       数据：ZcodeEngine.listModels() → 读 ~/.zcode/v2/config.json 现值
       defaultEngine 来源：ModelConfigService.getGlobalConfig() ← 缓存
```

关键事实（全部已核实）：

| # | 事实 | 代码锚点 |
|---|------|---------|
| F1 | **defaultEngine 是缓存值**：仅在 ModelConfigService 构造时和 `session_start`（initModel）时 `loadGlobalConfig()`，此后每 turn 的注入和每次派发路由都读缓存。**中途修改 config.json 全链路不可见** | `src/execution/model-config-service.ts:78,92` |
| F2 | 无「当前引擎」显式标签。defaultEngine=pi 时无任何引擎段（AI 只能从「没有 zcode 段」反推）；=zcode 时可从段名反推 | `model-prompt.ts:43-46` |
| F3 | 派发路由同样读缓存：`execute()` 内 `this.modelService.getGlobalConfig().defaultEngine` | `src/execution/subagent-service.ts:708` |
| F4 | `sendMessage` 通道可用且已有先例（subagent 完成通知，customType + content + details，`triggerTurn` 单通道） | `src/execution/notifier.ts:86-92`；pi SDK `types.d.ts:1176-1180`（`deliverAs: "steer"\|"followUp"\|"nextTurn"`） |
| F5 | 引擎段在链尾（handler 4），段内容变化只断 system prompt 尾部 cache 前缀 | `src/index.ts:649` 注册序 |

### 2.2 真实失败模式

2026-08-28 事故（Stock 项目调研会话，上一轮已逐行归因）：AI 按全局 AGENTS.md 路由表用 `model: "zai-coding-cn/glm-5.3"` 派发 4 个 subagent。该 id 在 pi registry 合法（`resolveModel` 校验通过），但 `~/.xyz-agent/pi/agent/subagents/config.json` 的 `defaultEngine:"zcode"` 把任务路由到 zcode 引擎，zcode 的 v2 registry 无此 provider → prepare 期 `model_not_available` → 派发调用已返回、失败延迟通知。

根因三层：
1. **AI 无引擎知情权**（本设计解决）：AI 不知道当前默认引擎是 zcode、不知道 zcode 派发要用 v2 registry 的 id。`<available_zcode_models>` 段虽存在，但 AGENTS.md 路由表（更强指令源）给了引擎盲的绝对 id，且没有任何「当前引擎」声明把两者对齐。
2. 双 registry 各校验一半（dispatch-time validation 的领地，Out of scope）。
3. config 中途修改不生效（F1）——连「用户中途想切引擎」这条出路当前都是断的：改了 config.json，路由和注入都停在旧值直到 session 重启。

### 2.3 物理数据流（现状 → 目标增量）

```
用户改 <agentDir>/subagents/config.json（defaultEngine: zcode → pi）
        │
        ▼ （现状：无任何检测，下一 turn 照旧用缓存值）
        │
【本设计新增】下一 turn 的 before_agent_start：
        │
        ├─ ① config 三态读取（明确值 / ENOENT→缺省 pi / 读失败）
        ├─ ② 目标引擎 ≠ sessionState[sid].lastEngine？（lastEngine 于 session_start
        │      初始化为当时读取结果——首 turn 无伪通知，D1b）
        │      ├─ 是 → 读取结果提交 ModelConfigService 全局配置（applyGlobalConfig，路由同一 turn 生效，F3 对齐）
        │      │        sendMessage(customType:"subagent-engine-changed", 短文案, 不含清单)
        │      │        sessionState[sid].lastEngine ← 新值
        │      └─ 否 → 无事
        ├─ ③ 渲染 <current_subagent_engine> 段（新引擎现值）append 到 system prompt 尾部
        ▼
   LLM 调用：system prompt（现值状态）+ 对话流（含变更事件）
```

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**Turn 1（session 启动，defaultEngine=zcode）——system prompt 尾部**：

```xml
<current_subagent_engine>
Default engine for subagent dispatches when neither the call's `engine` param
nor an agent .md `engine` frontmatter overrides: zcode
- Model ids for zcode dispatches are listed in <available_zcode_models> below.
  Ids in <available_provider_models> do NOT apply to zcode dispatches.
- Omit `model` to use the engine default.
- If AGENTS.md or other standing guidance names model ids from the pi registry
  (e.g. zai-coding-cn/*), those ids apply to pi-engine dispatches ONLY — when
  the current engine is not pi, use only ids from the engine section below.
</current_subagent_engine>
```

```xml
<available_zcode_models>
The following models are available for subagents dispatched with engine 'zcode' ONLY ...
<model><id>builtin:bigmodel-coding-plan/GLM-5.3</id>...</model>
<model><id>builtin:bigmodel-coding-plan/GLM-5.3-Flash</id>...</model>
...
</available_zcode_models>
```

（defaultEngine=pi 时，状态段仍存在：`... overrides: pi` + `Model ids for pi dispatches are the ids in <available_provider_models> above.`，无 zcode 清单段。**pi 也声明**——修复现状 F2 的门控缺口。）

**对话中用户改 config：zcode → pi，下一 turn——对话流出现一条 custom message**：

```
Subagent default engine changed: zcode → pi (effective this turn).
Use pi-registry ids from <available_provider_models> for explicit models;
omit `model` to inherit. The <current_subagent_engine> section reflects the current state.
```

（短文案，**不含任何模型清单**——清单只在 system prompt。）

**反复切换 A→B→A**：对话流累计两条短通知（zcode→pi、pi→zcode），无清单重复；任意 turn 的 system prompt 恰有一份当前引擎的清单。G3 构造性成立。

**失败路径（G4，均带恢复指引）**：

| 异常形态 | 注入段表现 | 恢复指引（段内文案） |
|---|---|---|
| config.json **读失败**（坏 JSON / 权限） | **不算变更**（保持 lastEngine，无伪通知）；段显示 lastEngine | 段内不提示；U1 交付 read-failure warn 日志（现状 config.ts catch 静默无日志） |
| config.json **不存在**（ENOENT，如用户删配置切回缺省） | **合法变更**：目标值 = 缺省 pi，正常触发检测/通知/生效 | ——（这是用户意图，不是故障） |
| defaultEngine 配了未注册引擎名 | 段显示配置值 + 警告行 | `engine '<id>' is not registered — dispatches will fail at routing; fix subagents/config.json` |
| zcode 引擎无凭据模型（v2 config 空清单 / listModels 抛异常） | 状态段正常，清单段显示提示行 | `engine 'zcode' has no credentialed models right now — configure the provider in ZCode desktop first` |

### 3.2 方案对比

| 维度 | **方案 A（推荐）：状态面 + 事件面** | 方案 B（字面直译）：静态 prompt + 流注入清单 + 去重账本 | 方案 C：仅 prompt 状态面 |
|---|---|---|---|
| 形态 | system prompt 每 turn 渲染现值（引擎 + 清单）；切换时对话流只发**不含清单**的短通知 | session start 时 prompt 冻结静态段；切换时把新引擎清单注入对话流；per-session 账本记录已注入过的引擎，重复切换只发短通知 | 同 A 的 prompt 部分，不做对话流通知 |
| 长期架构合理性 | 状态-事件分离是标准形态：prompt=现值（自愈，reload/compaction 后自动对齐），flow=边沿（留痕）。零新增持久状态 | 账本是与 compaction 耦合的易腐状态：清单被 compaction 吃掉后账本仍说「已注入」→ AI 拿不到任何清单（prompt 冻结在 session start 的旧引擎）。历史中清单随切换次数累积（N 引擎最多 N 份 token） | 变更静默：AI 可能基于旧引擎的模型规划了后续派发而无察觉（无 diff 信号） |
| 短期实现成本 | 中：改 1 个 handler + 新增检测模块 + reload 钩子；无新持久状态 | 中高：账本 + compaction 联动 + 「prompt 冻结」与现状（provider models 段本就每 turn 现值）行为分裂 | 低 |
| 风险 | sendMessage 在 before_agent_start 内调用、同 turn 可见性待探针（P1，有回退） | compaction 联动是硬风险；两段注入行为不一致（一个冻结一个动态）需额外解释成本 | 不满足 G2 的「AI 收到通知」要求 |

**推荐 A**。B 的反例推演：会话中 zcode→pi→zcode→pi 切三次，B 的历史里有 2 份 zcode 清单 + 1 份 pi 清单 + 账本 `[zcode, pi]`；随后 smart-context 压缩吃掉历史清单，账本未联动 → 再切回时账本说「都注入过」只发短通知，而上下文里已无任何 zcode 清单，AI 两眼一抹黑——比不注入更糟。A 下同一场景：清单恒在 prompt 现值，compaction 无关。

用户需求第 2 条的字面是「切换时注入 B 的 available-models」。方案 A 的偏离点在此明确声明：**B 的清单不进对话流，而是在同一 turn 的 system prompt 里以现值出现**——AI 在该 turn 同时看到事件（流）+ 清单（prompt），信息等价、token 不翻倍、去重构造成立。

### 3.3 关键决策与权衡

**D1 检测时机：per-turn poll（before_agent_start 内重读 config）**，否决 fs.watch。
选 poll：与需求「下一次 turn 时 hook」一致；config.json <1KB，每 turn 一次 `readFileSync` 可忽略（provider models 段每 turn 做 registry 全量渲染已是同量级先例）；fs.watch 有平台 quirk 与生命周期绑定问题。多 session 并行时各自 turn 各自 poll，读侧无竞害。

**D1b lastEngine 初始化规则（防首 turn 伪通知）**：`sessionState[sid].lastEngine` 初值语义必须显式定义，否则首 turn diff（`undefined ≠ "zcode"`）会发「changed: undefined → zcode」伪通知，直接违反 G2。规则：**session_start 时 lastEngine ← `reloadGlobalConfig()` 三态读取结果**——单次读取同时刷新 Service 路由缓存与 lastEngine 基准（**构造性同源**，审查轮 2 根治；/resume、/fork 同样走 session_start（index.ts SR-3），天然覆盖。原表述「与 initModel 同源取值零额外成本」不可达成：initModel 与 lastEngine 初始化曾是两次独立读取，两读值不一致时首 turn diff 走 unchanged 不刷新，状态段/路由永停旧值且永不通知）；若读取失败（三态之「读失败」），lastEngine 置 undefined 且**首 turn 检测遇 undefined 时静默基线化**（记为当前值、不算变更、不发通知）——双保险防伪通知。基线化不只是记账：**基线分支在读取成功时必须把本 turn 读取结果提交到单例缓存**（applyGlobalConfig，把 service 缓存对齐到刚读到的现值）——否则「session_start 读失败（lastEngine 未设置、缓存保持旧值）→ 用户修好 config 为 zcode → 首 turn 基线化只记 lastEngine=zcode 不提交」会让缓存永停旧值而 diff 永远 unchanged，改配置不生效以更隐蔽形态复活（一致性审查发现的规则盲区）。

**D2 变更生效一致性（本设计最关键的正确性约束）**：检测到变更时，**缓存提交必须先于一切后续动作**（通知、渲染、路由读缓存）。若只改注入不改路由缓存，prompt 说引擎 B、实际派发跑引擎 A——比不注入更糟（权威信息源说谎）。缓存提交复用 `readGlobalConfig()` 三态读取：`ModelConfigService` 暴露 `reloadGlobalConfig()`（三态读 + 提交，返回读取结果）与 `applyGlobalConfig(read)`（纯赋值提交；failed 保持缓存不动）——审查轮 2 修订：原「复用 loadGlobalConfig() sanitize」形态读失败会把好缓存静默打回缺省且调用方无感知。编排层把本 turn 已有的读取结果经 applyGlobalConfig 直接提交（构造性单次读取：检测值 = 缓存值，消灭检测读与缓存读两次独立读取间的窗口）。通知与渲染的相对顺序不构成约束（§2.3 数据流的形态为缓存提交 → 通知 → 渲染；两者均须在 LLM 请求构建前完成，P1 已证同 turn 可见）。

**对齐范围的精确声明（不过度承诺）**：「三处同 turn 对齐」仅对**检测到变更的 session** 成立。ModelConfigService 是进程级单例（`model-config-service.ts:196-219` globalThis Symbol slot），路由读单例缓存——因此：
- **同进程多 session**（pi fork / session_tree 场景）：session 1 检测并 reload 单例后，session 2 的**路由立即变新值**，但其 prompt 状态段与通知要等它自己的下一 turn。窗口期内 session 2 若派发，会落入「AI 上下文旧引擎、实际路由新引擎」——错误最终落在既有 `model_not_available` / engine 报错路径（有恢复指引，非静默），这是接受的兜底而非消除的竞态。
- **跨进程多 session**（xyz-agent 桌面 split：每 session 一个 pi 子进程）：无单例共享，各自 poll 各自 reload，各自下一 turn 自愈对齐。
若要彻底消除同进程窗口，需把路由决策从「读单例缓存」改为「读时重载」——那是路由层改造，超出本设计 scope（记为未来演进项）。

**D3 通知通道与可见性**：`sendMessage({customType:"subagent-engine-changed", content, display}, {})`——不设 `triggerTurn`（切换是用户主动行为，无需唤醒 AI 立即行动；下一条用户消息自然消费）。
**P1 探针（实施期门，⛔ 未测不写死）**：在 before_agent_start 内调 sendMessage，消息是否进入**本 turn** LLM 上下文。探针法：临时扩展在 before_agent_start 发消息 + `before_provider_request` hook dump 请求 messages 断言。若否——回退：状态段内追加一次性 `NOTE: engine changed from A to B this turn` 行（下一 turn 消失），sendMessage 照发（持久留痕，次 turn 可见）。设计对两种结果均成立，仅通知时序差一 turn。

**D4 去重语义：构造性去重，不建账本**。通知永远不含清单 → 清单在上下文中恒为一份（prompt 现值）。清单**内容**变更（引擎没变、v2 config 加了 provider）不发通知——prompt 现值已反映，事件流保持「引擎边沿」单一语义。

**D5 config 读取三态语义**。检测器不得消费「静默回落值」，须区分：
1. **读到明确值**——JSON 可解析且 defaultEngine 字段合法 → 目标值；
2. **明确缺省**——文件不存在（ENOENT，含 subagents/ 目录不存在）→ 目标值 = 缺省 pi（**是合法变更**：用户删配置切回默认，须正常检测生效；若按「读失败」处理，这条合法路径会比现状更顽固——现状重启 session 后尚能生效）；
3. **读失败**——坏 JSON / 权限等 → 保持 lastEngine 不动、不发通知（防 torn write 瞬间发伪通知），落 warn 日志。
现状 `loadGlobalConfig`（config.ts:55-73）catch 不分错误类型，ENOENT 与坏 JSON 同归 DEFAULT_CONFIG——U1 需把读取结果改造为三态返回（或检测器独立 try-catch 区分 errno）。补充语义（实现固化后回填）：**JSON 可解析但 defaultEngine 字段非法（空白等）= 第 1 态 ok + config.defaultEngine undefined**，沿用既有 sanitize 惯例（缺省引擎由路由层落 pi），消费方经 `registry.ts normalizeEngineId` 归一（单一权威源，审查轮 2 下沉：检测 diff 与状态段渲染共用同一函数，禁止各处内联同款表达式）——与删字段的 ENOENT 缺省殊途同归，不构成第三种失败。

**D6 pi 引擎也声明（恒在段）**。现状 defaultEngine=pi 时无引擎段（F2）。终态恒在 `<current_subagent_engine>`——AI 不需要「从段缺失反推」；顺带修复「agent .md 配 engine 时无对应清单」的门控缺口的一半（全局侧）。

**D7 字节稳定契约**。新段延续现有注入纪律：码点序、确定性渲染、链尾位置（engine handler 保持最后注册）——引擎变更只断 prompt 尾部 cache 前缀，与 provider models 段变更同判，不新增 cache 破坏面。cache-probe 前缀指纹归因兼容。

**D8 通知 display 形态对齐 notifier 既有约定**（customType 前缀、details 结构、renderer 注册与否在实现层对齐 `src/execution/notifier.ts` 同款处理，本文不锁死）。

---

## 4. 验收（真实场景，非单测非 mock）

实施后在**真机 pi CLI**（`pi --mode rpc --extension <本地 subagent-workflow 路径>`，dev-link live edit 形态）上验证。探针基础：临时 debug 扩展挂 `before_provider_request` dump system prompt 尾部与请求 messages（XYZ_AGENT_DEBUG=1 落日志）。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|------|------|---------|---------|
| A1 | 初始注入（zcode） | defaultEngine=zcode 启动 session，发一条 prompt | system prompt 含 `<current_subagent_engine>`（声明 zcode + 指引）+ `<available_zcode_models>` 清单，清单与 `~/.zcode/v2/config.json` 带 apiKey 的 provider×models 逐一一致；**首 turn 对话流无 subagent-engine-changed 通知**（防伪通知反向断言） | G1、D1b |
| A2 | 初始注入（pi / 删配置） | defaultEngine=pi 或删除 config.json 启动 | `<current_subagent_engine>` 声明 pi，指向 `<available_provider_models>`，无 zcode 清单段；删配置场景同判（ENOENT=合法缺省） | G1、D6、D5 |
| A3 | 中途切换 zcode→pi | 对话中手编 config.json 后发新 prompt | 三处同 turn 对齐：(a) 对话流出现 subagent-engine-changed 短通知（不含模型 id 清单）(b) 本 turn system prompt 状态段已是 pi (c) 路由真用了新值——验证手段（**不得**断言 record 含 engine 键：纯 pi 路径的 record entry 明确不带 engine 键，subagent-service.ts:727-735 字节级守护）：派发一个**pi-only 模型 id**（zcode registry 不存在的 id，如 zai-coding-cn/glm-5.3）的 subagent 成功执行，且 record 无 `engine`/`engineFallback` 键（纯 pi 缺省语义的留痕形态） | G2、D2 |
| A3' | 反向切换派发留痕 | 切回 zcode 后派发（不传 engine） | record 的 engine 字段='zcode'（非 pi 路径盖章，executeViaEngine 既有行为） | G2 |
| A4 | 反复切换去重 | 延续 A3 的同一 session：pi→zcode→pi 再两轮切换 | 全 session 累计 3 条短通知（A3 的 1 条 + 本轮 2 条）、**零**清单注入；任一 turn 请求的 system prompt 中清单恰一份且为当时引擎的 | G3 |
| A5 | 读失败防御 | 把 config.json 写成坏 JSON，发 prompt；随后修复文件再发 | 坏 JSON turn：无伪通知、无状态段翻转（保持 lastEngine）、日志有 read-failure warn；修复后下一 turn 正常检测到目标值 | G4、D5 |
| A6 | 未注册引擎 | defaultEngine 写成 `"ghost"` | 状态段显示 ghost + 警告行；派发报 engine_not_found 且错误文案与段内声明一致 | G4 |
| A7 | 多 session（跨进程形态） | 两个并行 pi rpc 进程（共享同一 agentDir，对应桌面 split 的每 session 一进程形态），进程 1 活跃时切换引擎，随后进程 2 发 prompt | 进程 1 在检测 turn 收到通知；进程 2 在自己的下一 turn 也收到一次（各自 lastEngine 独立边沿） | G2 |
| A8 | cache 前缀影响 | 切换前后各跑一次 cache-probe 前缀指纹 | 断点只出现在 engine 段位置（prompt 尾部），前段指纹不变 | D7 |

小注 1：A3(c) 是本设计与「只改注入」方案的分水岭验收——路由必须同 turn 生效，否则信息源说谎。
小注 2：同进程多 session（pi fork）的窗口期语义见 D2 精确声明——窗口内错误落入既有报错路径，不做验收断言（接受的兜底）。
小注 3：A1/A4 的「无伪通知」反向断言是 D1b 的行为验收面。

---

## 5. 下一层拆分

### 单元拆分（每项独立可验收）

| 单元 | 内容 | 文件 | justification / 验收挂钩 |
|---|------|------|------------------------|
| U1 | config 读取**三态化**（明确值 / ENOENT 明确缺省 / 读失败，D5）+ read-failure warn 日志（现状 catch 静默）+ `reloadGlobalConfig()` 公开方法（从 initModel 提取） | `config.ts`、`model-config-service.ts` | D2/D5 的地基；A2/A5 |
| U2 | 引擎状态段渲染器：`buildSubagentEngineSection(defaultEngine)`（恒在段 D6，含 AGENTS.md 冲突裁决文案）+ 既有清单段函数改造为「空清单→提示行」+ 引擎已注册但 `listModels` 未实现/返回 null 时清单段提示行声明「与主 agent 模型体系一致，ids 见 `<available_provider_models>`」（port 契约语义）；仅空清单/listModels 抛异常才用「无凭据模型 + ZCode desktop 指引」文案（一致性审查修订：两种降级形态文案必须区分，未实现 ≠ 无模型）；两种降级提示行均保留 `<available_<engine>_models>` 段包裹，恒在段的 ids 声明在降级形态下保持为真 | `execution/engine/model-prompt.ts` | 纯函数易测；A1/A2/A6 |
| U3 | 检测模块：per-turn poll + 三态 diff + 读取结果提交编排 + 通知构造（D1/D1b/D2/D3/D5）；lastEngine 于 session_start 初始化（reloadGlobalConfig 单次读取同时定缓存与 lastEngine，构造性同源——审查轮 2 修订），per-session 状态挂 sessionState | 新 `injectors/engine-awareness.ts`；`index.ts:649` handler 替换为调用它 | A1/A3/A4/A7 |
| U4 | 通知投递 + P1 探针结论落地（同 turn 可见或 NOTE 行回退） | `engine-awareness.ts` | A3(a) |
| U5 | 字节稳定守护测试：段渲染确定性 + 段序（engine 恒链尾） | `__tests__/`（照抄 injector 现有测试模式） | A8 |

### 文件改动地图

```
extensions/universal/subagent-workflow/src/
├─ execution/config.ts                    # 读取成败区分（U1）
├─ execution/model-config-service.ts      # reloadGlobalConfig()/applyGlobalConfig() 公开（U1；审查轮 2 三态化）
├─ execution/engine/model-prompt.ts       # 恒在状态段 + 空清单提示行（U2）
├─ injectors/engine-awareness.ts          # 新增：检测/编排/通知（U3/U4）
├─ index.ts                               # handler 替换（~649 行处）（U3）
└─ __tests__/engine-awareness.test.ts 等  # U5
```

### 待验证检查点（实施期门，⛔ 未验证不得宣称完成）

- **P1**：before_agent_start 内 sendMessage 的两个断言面：(a) **同 turn** LLM 可见性（决定 U4 走主路径还是 NOTE 行回退）；(b) **次 turn 持久可见**（回退路径的前提——custom message 无论何种情形都会 append 到 session，pi 实装 agent-session.d.ts:396-411 已确认机制，探针实测竞态：sendMessage 返回 Promise 被 fire-and-forget 时 append 时序与请求构建的先后）
- **P2**：跨进程双 rpc（A7 形态）各自 reload 的时序确认（幂等读同文件，预期无害）；同进程 fork 场景的窗口期行为按 D2 声明接受，不做消除性验证
- **P3**：A8 cache 指纹断点位置实测

### 依赖与风险

- 依赖 pi SDK 既有能力（before_agent_start 链式、sendMessage、sessionState 模式），无 pi 版本升级依赖。
- 最大不确定性 = P1（已有回退路径，不阻塞设计成立）。
- **生效前置条件（MF4 声明）**：本设计对根因 1 的治理是**信息对齐**而非**硬拦截**——段文案已显式裁决「AGENTS.md 的 pi-registry id 在非 pi 引擎下不适用」，但 LLM 对冲突指令的服从非确定性。彻底杜绝需 dispatch-time validation（派发时点跨 registry 预检，上轮分析 A1，独立设计）。**全局 AGENTS.md 路由表补充引擎感知提示是本设计完全生效的强伴随条件**，二者建议同批落地。
- **残留不生效面（S4 声明）**：defaultEngine 变更触发的全量 reload 会顺带让 `engineRouting.strict`、`maxConcurrent` 同 turn 生效（读同一文件，全量覆盖，属正向副作用）；但**无引擎变更时的其他字段中途修改仍不生效**（仍需 session_start）——本设计只承诺 defaultEngine 的动态性。
- **compaction 与事件面（S5 声明）**：smart-context 压缩会清 custom entry（notify-ledger compactionCheck 的存在即为实证）。引擎切换通知**不需要账本补写**：通知的价值在边沿时刻提醒，被压缩时状态面（system prompt 现值）仍持有全部当前事实——事件丢历史无损，状态永不丢。这正是状态/事件分离的收益。
- 与上轮分析的 A1（dispatch-time validation）正交且互补：本设计治「AI 知情」，A1 治「派发时点校验」；两者落地后坑 1 的两条腿都断。
