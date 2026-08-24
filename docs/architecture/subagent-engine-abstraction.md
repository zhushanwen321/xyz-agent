# subagent 执行层引擎中立抽象设计（pi / zcode / 未来多引擎）

> 层声明：本文档是「引擎抽象架构层」的设计，下一层产物是**可实现的接口/数据模型/技术方案**（EnginePort 接口 + 引擎适配器 + 公共降级层），不跨层到具体测试用例与逐文件实现。
>
> 调研输入：六引擎能力调研（zcode/pi 见 `~/Code/zcode-plugin-workspace/main/docs/research/zcode-vs-pi-extension-capabilities.md` 与本仓现状；claude-code / codex / opencode / kimi-code 见 `docs/research/agent-engine-*.md` 四份，2026-08-24）。
>
> 状态：已过对抗式审查（2026-08-24，tech-design-review：修后合格——3 must-fix 已修复：①EnginePort 补 interact 交互控制面（chatMode 语义映射）②schema native/emulated 硬分流（护 structured-output 方案 A 唯一权威）③隔离目录池化保留与 record 生命周期挂钩）。分支 `feat-support-zcode`。

## 1. 背景目标

**一句话结论**：在 pi-subagent-workflow 的执行层之下插入一个「引擎中立抽象」（EnginePort + 中立类型 + 公共降级层），使任意 coding-agent CLI 可作为 subagent 执行引擎插拔；首期落地 pi（回填，行为零变化）+ zcode（新增，spawn 单轮模式），抽象按六引擎能力全集设计，预留 claude-code / codex / opencode / kimi-code 接入位。

### SCQA

- **S（情境）**：xyz-agent 的 subagent 编排（并行派发、workflow、schema 输出、worktree 隔离）全部构建在「spawn pi 子进程 + pi session JSONL 直读」之上。
- **C（冲突）**：zcode 桌面端已具备可用的无头驱动能力（zsub 项目真机验证），用户希望 subagent 可跑在 zcode 上；且长期看 coding-agent 生态多极（claude-code / codex / opencode / kimi-code 各有优势模型与账号体系），绑死单引擎 = 把引擎选型变成了产品级单点。
- **Q（问题）**：如何让 subagent 执行基建支持多引擎插拔，且各引擎巨大的能力差异（schema 强制、运行中插话、sandbox、session 存储、人设注入、环境隔离手段）不污染上层（工具面、workflow 引擎、GUI），也不因某个引擎的契约漂移而连锁崩溃？
- **A（答案）**：本文的 EnginePort 抽象 + capabilities 声明式降级 + 公共降级层设计。

### 系统是什么（给不熟悉内部的读者）

pi-subagent-workflow 是 xyz-agent 的一个 pi extension，跑在 pi 主会话进程内。当模型调用 `subagent`/`workflow` 工具时，它替模型做三件事：①spawn 一个无头 pi 子进程执行任务（带 agent 人设、schema 输出约束、worktree 隔离）②把子进程的实时事件流（工具调用、文本增量、usage）翻译成统一的 `AgentEvent` 流 ③任务结束后把执行记录（`SubagentRecord`）持久化进主会话 entry，供 GUI 与 workflow 引擎消费。「执行引擎」特指①中被 spawn 的 coding-agent——本设计要把「pi」这个硬编码选择变成可插拔项。

### 设计目标（从使用者体验倒推）

1. **模型/用户不感知引擎**：`subagent`/`workflow` 工具的入参、返回、GUI 展示在引擎切换后完全不变（同一份 agent 清单、同一种 record、同一个 schema 校验结果）。
2. **配置自由切换**：全局默认引擎、per-agent 指定引擎（agent .md frontmatter `engine:` 字段）、单次调用覆盖，三层优先级。
3. **能力差异显式化**：某引擎不支持的能力（如 zcode 无 schema 强制）以 capabilities 声明 + 预定降级策略消化，而不是运行时神秘失败。
4. **抗版本漂移**：引擎 CLI 升级破坏契约时，探针在入口拦截并给出可操作错误，而不是运行中静默挂死。
5. **新引擎接入成本递减**：接入第 N 个引擎不改上层与既有引擎，只新增一个适配器模块。

### in / out of scope

**in**：subagent 执行层（extensions/universal/subagent-workflow 的 execution 链 + 其 spawn/读取基建）的引擎抽象；pi 回填；zcode 新引擎（spawn 单轮模式）；公共降级层；配置路由；探针体系；xyz-agent runtime 侧 subagent-extractor 的分协议读取（小改动）。

**out**：xyz-agent 主会话引擎切换（主链路仍 pi，见 `feat-support-zcode` 分支早前全量评估，另行决策）；conversation 模式（chatMode/idle 续聊）在 zcode 引擎下的支持（降级声明不支持，`--resume` 冷路径留作后续演进）；zcode app-server 常驻模式（引擎内部优化项，不进首期接口实现）；除 pi/zcode 外引擎的实际实现（只做抽象适配性验证）。

## 2. 现状与问题分析

### 2.1 现有执行链与「碰巧中立」的类型面

执行层（`extensions/universal/subagent-workflow/src/execution/`，约 1.4 万行）分层清晰：

```
AgentRunner port（orchestration/models/ports.ts）
  └─ SubprocessAgentRunner（委托）
       └─ SubagentService.executeAndAwait（编排：record/worktree/生命周期）
            └─ session-runner.runSpawn（spawn pi --mode rpc 子进程）
                 ├─ pi-invocation.ts      ← 定位 pi 二进制 + 组装命令行
                 ├─ stdin-writer.ts       ← pi RPC stdin JSONL 协议
                 ├─ spawn-event-adapter   ← pi 事件 → AgentEvent 翻译
                 └─ get-state-handshake   ← pi get_state 握手
```

好消息：四个核心类型**事实上已经中立**——`ExecuteOptions`（task/slug/agent/model/schema/maxTurns/worktree/cwd，语义全是「agent 调用」）、`AgentEvent`（tool_start/tool_end/text_delta/thinking_delta/turn_end/message_end/compaction/error 8 种）、`AgentResult`（content/parsedOutput/usage/error/toolCalls，指 orchestration 层 workflow 消费的那份；execution 层另有同名类型主字段为 text/turns/sessionId，泛化时须锚定前者并消歧命名）、`AgentRunner` port。zcode 引擎只要产出同样的 AgentEvent 流与 AgentResult，workflow 引擎、工具层、GUI 全部零改动。

坏消息：中立是**碰巧的，不是设计的**——`(1)` `ExecuteOptions.thinkingLevel` 是 pi 的 7 档枚举语义；`(2)` `skillPath` 假设引擎有 `--skill` flag；`(3)` `ExecuteOptions.conversation/idleTimeoutMs` 是 pi chatMode 专属形态（conversation 模式下子代理轮终进 idle 保留进程与 worktree，等待 tool 面 `message`/`close`/`cancel` action 续聊或收尾，subagent-service.ts:1552-1556、types.ts:556-565）——这是一组 **fire-to-completion 之外的交互控制面**，接口若不覆盖它，pi 回填时要么绕过抽象要么改行为；`(4)` spawn 细节（rpc 握手、stdin 协议、事件适配）全部内联在 session-runner 里，没有「引擎」这个概念；`(5)` record 重建（session-reconstructor）锚定 pi JSONL schema；`(6)` 模型解析（model-resolver）走 pi 的 provider 体系。这些点在「只支持 pi」时无妨，在多引擎下就是污染源。

### 2.2 六引擎能力差异的真实分布

四份新调研 + 两份既有调研横向对比（证据见各调研文档）：

| 能力 | pi | zcode | claude-code | codex | opencode | kimi-code |
|------|----|----|----|----|----|----|
| 一次性 headless spawn | ✅ rpc | ✅ `--prompt --json` | ✅ `-p` | ✅ `exec` | ✅ `run` | ✅ `-p` |
| prompt 投递通道 | stdin RPC | argv only | argv / stdin 双向流 | argv / stdin | argv / HTTP POST | argv only |
| agent 人设注入 | prompt 拼接 + flag | prompt 拼接（无 flag） | `--system-prompt` / `--append-system-prompt` / agent .md | config 叠加层 / prompt | agent .md（兼容 CC 风格）/ server `system` 字段 | `--agent-file`（临时文件） |
| schema 结构化输出 | env 注入 + 工具强制 | ❌ | ✅ `--json-schema` | ✅ `--output-schema` | ❌ | ❌ |
| 运行中插话（steer） | ✅ steer | ❌（未验证） | ✅ stream-json 双向 | ✅ `turn/steer` | ✅ 再 POST | ✅ `:btw`（server） |
| resume 续聊 | switch_session | `--resume`（冷启动） | `--resume` + fork | `exec resume` / fork | `-s` + fork | `--session` / `-c` |
| 事件流粒度 | 30+ 事件（最细） | delta / turn 终态（粗） | stream-json 全量（schema 化） | turn/item 两级 | part 级 + SSE | role 序列（粗） |
| usage 回传 | ✅ | ✅（stdout JSON） | ✅（result 消息） | ✅（turn.completed） | ✅ | 部分（meta） |
| OS sandbox | ❌ | ❌ | ❌（权限规则语法） | ✅（seatbelt/landlock） | ❌（权限 ruleset） | ❌ |
| 环境隔离手段 | `PI_CODING_AGENT_DIR` | **HOME 整体覆盖** | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `OPENCODE_CONFIG_DIR` | `KIMI_CODE_HOME` |
| 凭据注入 | models.json（隔离目录） | 隔离 HOME 写 config.json | env（`ANTHROPIC_API_KEY`/`BASE_URL`） | env（config env_key） | auth.json / config | **config.toml（不走 env！）** |
| 契约稳定性 | rpc.md 官方 | 逆向，无契约 | 官方文档 + Zod schema | `generate-json-schema` 机器契约 | openapi 3.1 入库 | 文档化 |

三个结构性观察（设计的直接依据）：

**观察一：六引擎都有「一次性 headless spawn」这个最小公约数**——argv 传 prompt、stdout 解析结果、exit code、resume session id。首期抽象锚定这个形态即可全覆盖；常驻 server（zcode app-server / codex app-server / opencode serve / kimi web）是引擎内部的性能/能力优化，不是接口语义。

**观察二：能力呈四档分布，必须显式建模降级**——全引擎可用（prompt/cwd/resume/终态+usage）；多数可用（model 指定、人设、工具 denylist、权限模式宽容差）；少数可用（schema 强制仅 pi/CC/codex、steer 四家、sandbox 仅 codex）；全缺（CLI 级超时——没有任何引擎有，天然是宿主公共层职责）。

**观察三：环境隔离与凭据注入是每引擎一份的「准备逻辑」**——六家六种手段（CONFIG_DIR 重定向 ×4、HOME 覆盖 ×1、配置文件生成 ×1），且互不兼容。这不是参数差异，是需要 per-engine `prepare` 钩子的结构性差异。

### 2.3 根因

当前执行层缺失的不是「if engine === 'zcode'」的分支，而是三个概念：**引擎身份**（spawn 细节没有归属边界）、**能力声明**（上层无从得知「这个引擎给不了什么」）、**降级归属**（schema 仿真、超时、隔离这些「引擎没有但我们要」的能力，没有明确的实现归属地）。本设计补这三个概念。

### 2.4 物理数据流（现状）

```
[pi 主会话进程]
  subagent-workflow extension
    ├─ SubagentService.executeAndAwait
    │    ├─ worktree-manager（引擎无关 ✅）
    │    ├─ spawn: node <pi> --mode rpc ...（env: PI_SUBAGENT_* 身份标记）
    │    │    子进程 pi ←stdin JSONL─ prompt/steer/abort
    │    │    子进程 pi ─stdout 事件流→ spawn-event-adapter → AgentEvent
    │    │    └─ session 落盘: <piAgentDir>/subagents/<enc>/sessions/*.jsonl
    │    └─ record: appendEntry(SUBAGENT_RECORD) 写主会话 ✅（引擎无关）
    └─ session-reconstructor: 直读子代理 pi JSONL → 重建 turns[]
[xyz-agent runtime]
  subagent-extractor.ts: 扫 pi subagents 目录 → 派生列表（GUI）
```

引擎中立化后不变的是：worktree-manager、record 写入通道（主会话仍是 pi，appendEntry 可用）、AgentEvent/AgentResult 消费方。要变的是 spawn 行、事件翻译行、session 落盘与读取行（三行恰好按引擎分叉）。

## 3. 解决方案

### 3.1 终态（使用者视角）

**终态一：模型按 agent 清单选人，不选引擎。** 模型调用 `subagent` 工具时看到的 agent 清单与现在完全一致（reviewer/worker/...）；`engine` 是 agent .md 的 frontmatter 字段（或全局默认），模型不感知。清单注入文案里不出现引擎字样。

**终态二：配置三层切换。**

```
优先级：调用参数 engine > agent .md frontmatter engine > 全局 settings 默认（缺省 'pi'）
```

例：`extensions 配置或 xyz-agent 设置`里默认 `pi`；`~/.agents/agents/reviewer.md` 写 `engine: zcode` 后，所有 reviewer subagent 跑 zcode；某次 workflow step 显式传 `engine: claude-code` 则单次覆盖。

**终态三：能力差异在调用前可见。** 用户在 GUI/设置里给某 agent 指定 `engine: zcode` 时，系统提示「zcode 引擎：schema 输出为仿真降级（prompt 约定 + 解析校验）、不支持运行中插话、事件流为粗粒度」——来源于该引擎的 capabilities 声明，不是散落的 if。

**终态四：引擎坏了给出可操作错误。** zcode CLI 升级导致 stdout 格式变化时，探针在引擎初始化时失败，错误信息形如「zcode 引擎探针失败：stdout 无 sessionId 字段（zcode 0.17.x 格式漂移嫌疑）。恢复：`zcode --version` 确认版本后跑 `pnpm test:engine-probe zcode`，参照 docs/research/agent-engine-zcode.md 更新解析器」。任务被路由到降级引擎（缺省 pi）或在明确报错中终止，不静默挂死。

**终态五：新增引擎是一个模块。** 接入 claude-code = 新增 `engines/claude-code/` 目录（launcher + parser + prepare + reader 四件，预计 ≤500 行）+ 注册表登记一行，不改 workflow 引擎、不改工具面、不改其他引擎。

### 3.2 方案对比

| | 方案 A：Service 内 if-else 分派 | 方案 B：EnginePort 抽象 + 引擎注册表 + 公共降级层（推荐） | 方案 C：zsub 外挂引擎 |
|---|---|---|---|
| 形态 | SubagentService 内按 engine 字段 if-else 调 pi/zcode 两套 spawn | 执行层下插入 EnginePort 接口；每引擎一个 adapter 模块；降级能力收口公共层 | 把 zsub CLI（zcode-plugin-workspace 仓）当 zcode 引擎执行器，本仓调 zsub 命令行 |
| 长期架构合理性 | 差：三引擎后 if 嵌套不可维护；pi spawn 细节仍内联，每引擎改 Service | 好：接口契约单点、能力声明显式、降级写一次全引擎复用、符合「新引擎只加模块」目标 | 差：跨仓产品级耦合（zsub 是独立发布产品，接口面为 MCP/CLI 非进程内调用）；zsub record 与 SubagentRecord 双模型 |
| 短期实现成本 | 最低（~3-5 天） | 中（~2-3 周，含 pi 回填与测试守护） | 低-中（zsub 现成，但接缝打磨贵） |
| 风险 | 每加引擎改核心服务，回归面大；能力差异散落 | 接口设计错了要返工（用六引擎调研约束降低此风险）；pi 回填期行为回归 | zsub 演进节奏不受本仓控制；双仓版本矩阵 |
| 若用它，§2 的例子会怎样 | 第三个引擎接入时 reviewer 例子的「人设注入」要在 Service 里写第三种拼法，四份调研里的差异表全部变成散落分支 | 差异表收敛为每引擎一份 adapter + capabilities 表格 | claude-code 接入时 zsub 帮不上忙，回到方案 A 形态 |

**推荐方案 B**。方案 C 中 zsub 的价值以另一种方式吸收：ZcodeEngine 的实现直接参考/移植 zsub 已验证的 driver/bootstrap/model-router 代码（zcode-plugin-workspace 仓），架构上不依赖它。

### 3.3 架构与关键决策

#### 3.3.1 分层总图

```
[上层消费方：subagent 工具面 / workflow 引擎 / GUI]        ← 不感知引擎
        ↓ 消费中立类型
[中立类型层] AgentTaskSpec / AgentEvent / AgentOutcome / SessionView / EngineCapabilities
        ↓ 唯一契约点
[EnginePort]  run(task, ctx) → AgentOutcome
              interact(handle, action) → 交互控制面（message/close/cancel，可选）
              read(handle) → SessionView
              probe() → ProbeReport
              capabilities() → EngineCapabilities
        ↓ 实现
[引擎注册表 engine registry]（id → factory）
   ├─ PiEngine        （现有 spawn 链回填，行为零变化）
   ├─ ZcodeEngine     （新增，spawn 单轮模式）
   └─ （未来：ClaudeEngine / CodexEngine / OpencodeEngine / KimiEngine）
        ↓ 每引擎内部
[Adapter 四件套] launcher（spawn 命令组装）/ parser（stdout→事件流+终态）
                 preparer（env/隔离目录/凭据生成）/ reader（session 历史读取）
        ↑ 复用
[公共降级层]（引擎无关，写一次全引擎用）
   schema 仿真（prompt 注入 + 三级容错 JSON 提取 + ajv 校验）
   超时与杀链（SIGTERM → grace → SIGKILL；终态合成）
   persona 路由（文件落盘 / flag 直传 / prompt 拼接，按 capabilities 选择）
   嵌套防护（统一 NESTED 标记 + 清理各引擎原生标记）
   worktree 隔离（复用现有 worktree-manager）
```

#### 3.3.2 关键决策（每条：选择 + 被否 + 证据）

**D1 接口主语义锚定「一次性任务」，交互控制面单列可选方法。**
`run(task) → outcome` 是 fire-to-completion 语义。pi 现有的 conversation 交互面（chatMode 的 message/close/cancel + idle timer + 进程保留，见 §2.1 坏消息(3)）不折叠进 run——折叠成「run + resume 序列」会改 pi 行为（每轮冷启动 vs 现有同进程 idle 复用），违反 A1。EnginePort 补第四个面 `interact(handle, action: {kind:'message'|'close'|'cancel', payload?})`：pi 首期原生实现（现有 chatMode 行为直通）；zcode 首期 `unsupported`（capabilities 声明，调用前拒绝并提示）；未来低交互引擎可由公共层用「run + resume + 宿主 idle timer」仿真（`resume:'cold'` 路径），但 pi 不走仿真。被否：按「session 型 + run 型」双语义重构整个接口（codex 调研建议方向）——那是主链路 GUI 集成的需求形态，subagent 场景一次性任务占绝对多数，双语义让首期复杂度翻倍；常驻 server 形态（zcode app-server 等）留作引擎内部优化：接口的 `onEvent` 回调 + `AbortSignal` 已按常驻友好设计，引擎内部换常驻实现时接口不动。

**D2 中立类型从现有类型泛化，不另起炉灶。**
`AgentTaskSpec` = 现有 `ExecuteOptions` 泛化：剥离 pi 专有语义（`thinkingLevel` 7 档改为引擎无关的 `effort?: string` 由引擎映射或忽略；`skillPath` 改为 `persona` 的一部分；`conversation/idleTimeoutMs` 归 `interact` 控制面的 task 标志，保留原名透传）。`AgentEvent` 8 种、`AgentResult` 字段原样保留（锚定 orchestration 层 workflow 消费的那份，与 execution 层同名类型消歧，见 §2.1）。被否：全新设计一套更「完美」的类型——现有类型被 workflow 引擎/GUI/测试广泛消费，推倒重来是纯迁移成本。

**D3 capabilities 三级声明：`native` / `emulated` / `unsupported`。**

```ts
interface EngineCapabilities {
  schemaEnforcement: 'native' | 'emulated';        // native: --json-schema/--output-schema/env注入
  steer: 'native' | 'emulated' | 'unsupported';     // 注意区分「引擎 RPC 层有此能力」与「subagent 链路已接通」
  conversation: 'native' | 'unsupported';           // interact 控制面（message/close/cancel + idle）
  personaInjection: 'file' | 'flag' | 'prompt';     // 决定 persona 路由策略
  eventGranularity: 'stream' | 'coarse';            // 粗粒度引擎：GUI 显示降级为阶段态
  sandbox: 'native' | 'emulated' | 'none';          // emulated = worktree 隔离
  sessionRead: 'full' | 'partial' | 'outcome-only'; // 重建历史的能力
  resume: 'native' | 'cold' | 'unsupported';
}
```

两个易错点：① capabilities 声明的是**本仓 subagent 链路实际接通的能力**，不是引擎 RPC 层的理论能力——pi 的 RPC 有 steer 但现有 spawn 链路未接通（session-runner steer no-op，schema 强制走 MANDATORY 指令路径），首期 pi 的 steer 应声明 `unsupported`（接通后再升级声明）；② schema 的 native/emulated 分流是硬边界，见 D4。上层据声明选择策略（如 schema 为 emulated 时自动走公共降级层；steer/conversation unsupported 时 UI 隐藏对应入口并提示），而非 try-catch 运行时试错。被否：能力检测做成运行时探测定——探测成本高且不可靠（有的能力要跑到一半才知道）。

**D4 降级能力归属公共层，一次性实现全引擎复用；native 路径与仿真路径硬分流。**
schema 仿真、超时杀链、persona 路由、嵌套防护、worktree 隔离五件放公共降级层，不放各引擎 adapter（避免六个引擎各写一份有差异的仿真）。证据：四份调研的「缺失能力」清单高度重合（schema 4/6 缺、超时 6/6 缺、sandbox 5/6 缺）——公共层是消除重复的正确位置。

**schema 的边界必须显式**：capabilities 为 `emulated` 的引擎（zcode/opencode/kimi-code）走公共仿真层（prompt 注入 + 三级容错提取 + 宿主侧 ajv）；capabilities 为 `native` 的引擎（pi 的 `PI_WORKFLOW_SCHEMA` env 注入链路、claude-code 的 `--json-schema`、codex 的 `--output-schema`）保持各自原生链路，公共层**不做二次校验、不改写其结果**。理由：pi 的 structured-output 方案 A [HISTORICAL]（workflow 模式 env 注入的权威 schema 是唯一校验权威）——宿主侧再叠一层 ajv 会制造第二校验权威，恰是历史上「校验自报 schema 致修复静默丢失」事故的形态。仿真层的 ajv 只在 emulated 路径出现。

**D5 环境隔离与凭据注入走 per-engine preparer 钩子；隔离目录池化保留，随 record 生命周期回收。**
`prepare(task)` 在 spawn 前调用，返回 `{ env, cwd, spawnedFiles[] }`。证据：六家六种隔离手段（观察三），且 kimi 凭据必须写 config.toml、zcode 必须 HOME 覆盖——参数化无法覆盖，只能代码化。隔离目录（`<dataDir>/engines/<engineId>/<pool-key>/`，zcode 按引擎+agent/model 池化，与 zsub HOME 池同构）**跨任务保留复用**，不随单次任务清理——理由：①目录内 db.sqlite 是 D6 降级链第①级（原生读取）的数据源，任务结束即清理会让该级永不可达；②config.json/凭据引导是确定性成本，池化复用摊薄（zsub 经验：源 config mtime 比对 + 按需重建）。清理时序与 record 生命周期挂钩：record 被 GC/删除时同步清理池内对应 session 数据，池整体在引擎配置移除时删除。`spawnedFiles[]`（临时 prompt 文件等单次性产物）任务结束即清理，resume 场景保留。

**D6 session 读取独立 SessionView 接口 + 三级降级链。**
`read(handle)` 返回 `SessionView`（turns[] 派生数据），降级链：①引擎原生读取（pi/CC/codex 的 jsonl、zcode/opencode 的 sqlite、kimi 的 wire.jsonl）②spawn 期缓存（adapter 在运行中已收到的 AgentEvent 流重放）③outcome-only（只有 prompt/result/usage——GUI 显示降级为摘要卡）。被否：只支持原生读取——zcode sqlite schema 随版本迁移、kimi wire.jsonl 官方警告勿手改，原生读取必然周期性失效，必须有一级保底。

**D7 探针体系按契约稳定性分级。**
每引擎 `probe()`：二进制存在 + 版本解析 + 一次「干跑校验」（不调 LLM：zcode 探 `--version` + 解析器对已知样本的回归；codex/CC 用官方 schema 机器校验，探针最轻）。探针在引擎 factory 初始化与「版本变化检测」时触发，失败走终态四的错误形态。证据：zcode 无契约（help flag 漂移实锤：`--max-turns` 列出但拒收）与 codex（generate-json-schema 锁版本）是稳定性光谱两端，统一强探针浪费、统一弱探针危险。

**D8 嵌套防护双层。**
统一 `XYZ_AGENT_SUBAGENT=1` 标记（所有引擎 spawn 都注入，引擎 adapter 检测到即拒绝递归派发）+ 各引擎清理/利用其原生标记（CC 的 `CLAUDECODE`、zsub 的 `ZSW_NESTED`、pi 现有 `PI_SUBAGENT_*`）。被否：只靠「隔离目录里不装扩展」（zsub 第二重门禁）——那依赖配置洁癖，且 opencode/CC 会吃项目级 `.opencode/`/`CLAUDE.md` 配置，env 标记是唯一跨引擎可靠手段。

**D9 配置路由三层，agent .md frontmatter `engine` 字段为 per-agent 主通道。**
与 zsub 的 `frontmatter.model` 先例、六家 agent .md 体系（CC/opencode/kimi frontmatter 字段互有兼容）一致；缺省引擎 = `pi`（回填期零风险默认）。校验：注册表里不存在的 engine id 在 agent 解析期报错（配置错误前置暴露，不留到运行时）。

**D10 MVP 引擎集 = { pi, zcode }；zcode 首期只做 spawn 单轮。**
zcode app-server、conversation 模式、其他四引擎都不进首期。理由见 in/out scope；抽象按六引擎全集设计（防返工），实现按最小可验收集推进（防过度工程）。第二验证引擎建议选 claude-code（契约最清晰、`--json-schema` 原生、能验证 native schema 直传路径）——但明确标注为「后续 Phase，非首期承诺」。

#### 3.3.3 错误规格（每类配恢复指引）

| 错误 | 触发 | 恢复指引 |
|------|------|---------|
| `engine_not_found` | agent frontmatter 写了未注册 engine id | 指向注册表清单 + 配置文件路径 |
| `engine_probe_failed` | 探针失败（版本漂移/二进制缺失） | 版本确认命令 + 探针重跑命令 + 调研文档路径（终态四样例） |
| `engine_credential_missing` | preparer 找不到凭据源（如 zcode v2 config 无 apiKey） | 指向引擎凭据配置文档节 |
| `nested_spawn_rejected` | 嵌套 spawn 尝试 | 说明防护规则，指向 task 内自行完成 |
| `schema_emulation_failed` | 仿真降级下输出经三级容错仍解析不出 JSON / ajv 不通过 | 重试一次（强化 prompt）后报错，错误含原始输出尾部——与现有 structured-output 重试语义对齐 |
| `engine_timeout` | 宿主超时杀链走完 | 含 stdout 尾部 2000 字 + 「可用 engine: pi 重跑」建议 |

#### 3.3.4 物理数据流（终态，以 reviewer@zcode 为例）

```
模型调用 subagent(agent=reviewer, task=...)
  → 引擎路由: reviewer.md frontmatter engine:zcode → ZcodeEngine
  → 公共层: schema 仿真段拼装 + NESTED env + worktree 创建
  → preparer: <dataDir>/engines/zcode/home-reviewer/ 隔离 HOME
      （config.json: model.main + 凭据，tmp+rename 原子写；无 plugins 块）
  → launcher: spawn node <zcode.cjs> --json --cwd <worktree> --mode yolo
      --disallowed-tools <denylist> --prompt <persona+task+schema 仿真段>
      (env: HOME=隔离目录, XYZ_AGENT_SUBAGENT=1; stdin=/dev/null)
  → parser: stdout 有界收集（头4K+尾64K）→ 单 JSON {sessionId,response,usage}
      → 合成 AgentEvent 流（coarse: message_end + turn_end）→ AgentOutcome
  → record: SUBAGENT_RECORD appendEntry（主会话 pi 通道，不变）
  → read(handle): sqlite 读 session/message/part 三级 JOIN → SessionView
      （失败降级 → spawn 期缓存 → outcome-only）
```

## 4. 验收

大改动，多场景。每个场景标注回溯 §1 目标条目。执行环境：真实 xyz-agent dev（`pnpm dev`）+ 本机已装的 zcode（ZCode.app）与 pi。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|------|------|---------|---------|
| A1 | pi 引擎零回归 | 合入后跑 subagent-workflow 全量测试 + 手动派一个 `engine` 缺省（=pi）的 subagent 与一个多步 workflow | 测试全绿；手动路径与合入前比对锚点一致：①record entry JSON 快照 diff（字段级）②GUI 关键视图截图基线（对话流/工具面板/record 详情）③schema 任务走 native env 注入链路不受仿真层影响（D4 硬分流的回归确认） | 目标 1 |
| A2 | zcode 引擎真实任务 | reviewer agent frontmatter 加 `engine: zcode`，模型派「审查 packages/shared/src/paths.ts 最近改动，按 schema 输出 {issues[],verdict}」 | 子代理真跑在 zcode（隔离 HOME 的 db.sqlite 出现新 session）；schema 结果 ajv 校验通过；GUI 对话流/工具面板正常显示（允许粗粒度） | 目标 1/2/3 |
| A3 | schema 仿真降级可见 | 同 A2 但查 GUI 引擎提示 | 调用前可见「schema 为仿真降级」提示，不是运行时报错 | 目标 3 |
| A4 | 嵌套防护 | 让 zcode 子代理尝试调用 subagent 工具 | 被拒并给出防护说明，无二级 zcode 进程产生 | 目标 4（防护属错误规格） |
| A5 | 探针拦截 | 临时改 zcode 解析器的版本断言（模拟漂移）后派 zcode subagent | 入口即 `engine_probe_failed`，错误含恢复指引（版本命令/探针命令/文档路径），任务不静默挂死 | 目标 4 |
| A6 | 混编 workflow | 一个 workflow 前两步用默认 pi、第三步 step 级指定 zcode | 两引擎 record 结构一致，workflow 汇总正常，GUI 无引擎字段泄漏 | 目标 1/2 |
| A7 | 单次调用覆盖 | 调用参数显式 `engine: pi` 覆盖 reviewer 的 zcode 设置 | 该次跑 pi（隔离目录无新增 zcode session） | 目标 2 |
| A8 | 读取降级链 | 前置确认：该 zcode 任务的隔离池目录与 db.sqlite 正常保留且 `read(handle)` 走第①级（sqlite 原生读取）成功。然后 rename 掉 db.sqlite 再打开该 subagent 详情 | 详情页降级显示 spawn 期缓存重建（第②级）；再清空缓存后降级为 outcome-only 摘要卡（第③级），不白屏不报错弹窗 | 目标 3（sessionRead 降级） |

验收前置门（实施期完成）：A2 前先用真实 zcode CLI 手工跑一次驱动脚本核对 stdout JSON 字段（sessionId/response/usage）与本机 0.16.3 一致——探针的已知样本即来自这次实录。

## 5. 下一层拆分

实施路径五阶段，每阶段可独立验收（A1-A8 分配到阶段门）：

| 阶段 | 单元 | 内容 | justification / 验收挂钩 |
|------|------|------|--------------------------|
| P1 | 中立类型 + EnginePort + PiEngine 回填 | `execution/engine/` 新目录：types.ts（AgentTaskSpec 等泛化）、port.ts、registry.ts；现有 runSpawn 链移入 `engines/pi/`，ExecuteOptions→AgentTaskSpec 映射层 | 行为零变化靠现有测试守护（session-runner.test 等）；验收 A1。先回填后新增，隔离回归风险 |
| P2 | 公共降级层 | schema 仿真（prompt 拼装 + 三级容错提取 + ajv，**仅服务 emulated 引擎**，见 D4 硬分流）、超时杀链、persona 路由、嵌套防护、preparer 目录池管理 | 纯新增无回归面；pi 的 native schema 链路（env 注入）不动 |
| P3 | ZcodeEngine | adapter 四件套（launcher/parser/preparer/reader），吸收 zsub driver.js/bootstrapIsolatedHome/model-router 的 TS 重写；sqlite reader | zsub 已真机验证，风险集中在移植保真；验收 A2/A3/A4/A8 |
| P4 | 配置路由 + capabilities + 探针 | frontmatter engine 字段解析（agent-ref/meta-parser 扩展）、三层优先级、probe 体系、错误规格落地 | 验收 A5/A6/A7 |
| P5 | runtime 侧 subagent-extractor 分协议 | xyz-agent runtime（subagent-extractor.ts 约 660 行，锚定 pi subagents 目录扫描）改造：按 record 内 engine 字段路由到对应引擎的 SessionView 投影、per-engine session 定位、隔离池清理时序协调 | **中改动**（非小改动）：extractor 需要新依赖 EnginePort 的 read 能力或其投影子集，改动面集中在 session 定位与投影两段；单独 commit。验收 A2 的 GUI 派生列表部分 |

文件改动地图（P1-P4 主要落点）：`extensions/universal/subagent-workflow/src/execution/`（engine/ 新增 + session-runner/subagent-service 改造点收口）、`src/shared/`（meta-parser 的 engine 字段）；P5：`packages/runtime/src/services/session/subagent-extractor.ts`。精确逐文件清单属下一层（实现计划）产物，此处不越层。

待验证检查点（实施期必须实证，不预设结论）：①zcode 0.16.3 spawn 模式 stdout JSON 字段名实录；②隔离 HOME 下 db.sqlite 的并发读行为（WAL）与 message/part schema 细节；③`--disallowed-tools` 对 zcode 内置工具名的实际匹配语义；④argv 超长 prompt 的实际限额（zsub 经验约可用，但需在目标模型场景复核）。

## 附：与早前「全量 zcode 适配」评估的关系

本设计是 `feat-support-zcode` 分支早前全量评估（主链路换 zcode，月级工程）的最小切口先行方案：不动主会话引擎、不动其余 19 个 extension、不动 shared 协议与 renderer。若未来走主链路多引擎化，本设计的 EnginePort/中立类型/降级层直接是复用资产（ZcodeEngine 的驱动代码可整体搬去 runtime 层）；若不走，本设计独立成立（subagent 多引擎本身有产品价值：不同引擎绑不同账号体系与优势模型）。
