# 禁读重建审查（mid-plan review-fix-loop 第 3 路）

- 审查对象：`.xyz-harness/subagent-engine-abstraction/requirements.md`（初稿 A）+ `system-architecture.md`（初稿 B）
- 认知帧：反向他证——审查者在**未读初稿**状态下，仅从权威源独立重建预期内容集，再 diff 初稿，检验遗漏（MISSING）/ 幻觉（PHANTOM）/ 语义偏移（MISMATCH）
- 权威源：`docs/architecture/subagent-engine-abstraction.md`（666 行设计文档，三轮对抗式审查通过，2026-08-24）+ 源码现状核实（`extensions/universal/subagent-workflow/src/` 目录结构与关键类型锚定）
- 重建完成时点：先于初稿阅读（本文件「独立重建」节先写，写完才读初稿——由本文件写作顺序可证）

---

## 一、独立重建

> 以下内容全部由设计文档独立推导，未参考两份初稿。源码核实仅用于确认设计文档对现状描述的准确性（已确认：execution/ 目录 44 文件、orchestration/models/ports.ts 的 AgentRunner port、execution/types.ts 的 AgentEvent 8 种 / ExecuteOptions 全字段 / orchestration AgentResult 主字段，均与设计文档 §2.1 描述一致；`src/shared/agent-event.ts` 是 execution/types.ts 的 re-export 出口，唯一定义未漂移）。

### 1. Actor 清单

| # | Actor | 依据（设计文档） | 核心诉求/行为 |
|---|-------|----------------|--------------|
| 1 | 模型（主会话 agent） | 终态一「模型按 agent 清单选人，不选引擎」；D11 规则③「模型与用户的错误通道分开」 | 调用 subagent/workflow 工具；agent 清单与引擎切换前完全一致；不感知 engine 字样；收到「能改变下一次调用」的可操作错误文案 |
| 2 | 用户（xyz-agent 桌面端用户） | 终态三、终态四；D11 规则③ | 配置全局默认引擎 / agent frontmatter engine；GUI 看能力提示（调用前可见）、警告条（fallback 留痕）、降级标记（仿真降级常驻提示）；错误尽量没有机会发生（入口隐藏） |
| 3 | workflow 引擎（worker 脚本） | 终态一/A6/D9 配套③ | step 级显式 engine 仅限「必须独有能力」并注释原因；消费 record/AgentOutcome，两引擎 record 结构一致；不写死 engine |
| 4 | GUI（renderer） | D3「上层据声明选择策略」/D11/A8 | 对话流/工具面板/record 详情/派生列表展示；SessionView 三级降级展示（native 全量 → journal 重放 → outcome-only 摘要卡）；粗粒度引擎阶段态卡片；unsupported 能力入口隐藏 |
| 5 | xyz-agent runtime（subagent-extractor） | §2.4/P5/二轮修订① | 扫各引擎 session 目录派生列表（GUI）；分协议读取：reader（①级共享只读）→ journal（②级）→ record outcome（③级）；pi 直读现状下沉为 pi reader 行为不变 |
| 6 | 新引擎接入者（adapter 开发者） | 终态五/D12/目标 5 | 新增 `engines/<id>/` 四件套（≤500 行预期）+ 注册表一行 + golden 样本 + conformance 转绿；不改 workflow 引擎/工具面/其他引擎 |
| 7 | 宿主（SubagentService / execution host） | §3.3.6「host 消费 onEvent 统一落盘」/D6 | 编排权/并行/record/worktree 全在宿主（宿主编排纪律）；onEvent 落 journal；合成终态（abort/超时/运行中失败）；池引用计数维护 |

判定要点：**「引擎」本身不是 Actor**——六家原生多 agent 机制一律禁用（贯穿纪律①），引擎只当单 agent 执行器。初稿若把 zcode/pi CLI 提升为有编排行为的 Actor，属于对宿主编排纪律的违背。

### 2. 关键用例（应有 UC 清单）

从终态一~五 + 验收 A1-A14 + D9-D12 倒推，共 6 组：

**UC-G1 引擎无关调度（目标 1）**
- UC1.1 默认引擎派发：模型调 subagent，agent 清单/入参/返回/GUI 全不变（A1 pi 零回归）
- UC1.2 混编 workflow：同 workflow 多引擎 step，record 结构一致、汇总正常、GUI 无引擎字段泄漏（A6）
- UC1.3 单次调用覆盖：调用参数 engine 优先于 frontmatter（A7）

**UC-G2 配置路由（目标 2，D9）**
- UC2.1 三层优先级：调用参数 > agent .md frontmatter > 全局默认（缺省 pi）
- UC2.2 未注册 engine id：agent 解析期报 engine_not_found（前置暴露）
- UC2.3 model 与 engine 正交：不隐式按模型推引擎；不可解析报 model_not_available（D9②）

**UC-G3 能力差异显式化（目标 3，D3/D11 四级）**
- UC3.1 capabilities 调用前可见（终态三/A3：配置时提示仿真降级/不支持插话/粗粒度）
- UC3.2 自动仿真：schema emulated 引擎走公共仿真层，产出与 native 同形，常驻降级标记（A2）
- UC3.3 显示降级：粗粒度事件流阶段态 / usage 缺失 / cost 缺失，永不弹错（D11）
- UC3.4 调用前拒绝：steer/interact/conversation unsupported、嵌套 spawn、argv 超长——同步结构化错误、不创建进程（A4/A11）
- UC3.5 入口拦截：探针失败（strict）/凭据缺失/未注册 id，错误含恢复指引（A5）

**UC-G4 故障与生命周期（目标 4）**
- UC4.1 探针拦截与可操作错误（A5：错误含版本命令/探针重跑命令/调研文档路径）
- UC4.2 有守卫的 fallback（A9：frontmatter 来源 + probe 失败 → 回退默认引擎 + engineFallback 留痕 + GUI 警告条；三守卫（显式指定/独有能力依赖/model 不可解析）或 strict → 不兜底直接报错）
- UC4.3 abort 两级中断（A10：原生 interrupt → 公共杀链；zcode CLI-only 直接杀链 + 宿主合成终态 + record 收尾无僵尸）
- UC4.4 运行中引擎失败（A14：engine_run_failed 含 stdout 尾部 + exit code + 恢复指引 + 新样本补录 golden）
- UC4.5 超时杀链（SIGTERM → grace → SIGKILL → 合成终态；engine_timeout）
- UC4.6 死 handle 续聊拒绝（A13：engine_session_not_resumable 指向 cold resume）

**UC-G5 session 读取（目标 3，D6）**
- UC5.1 read 三级降级链：①原生（pi jsonl/zcode sqlite）→ ②宿主 journal 重放 → ③outcome-only 摘要卡，三级不 throw 不白屏（A8）
- UC5.2 GUI 历史双端复用：runtime extractor 与 extension read() 共享同一 reader 模块（P5）
- UC5.3 conversation 交互：pi 原生 interact（message/close/cancel + idle）；zcode 首期 unsupported 调用前拒绝（A11/A13）

**UC-G6 接入与验证（目标 5，D5/D7/D12）**
- UC6.1 新引擎接入 = 四件套 + 注册表一行 + golden 样本 + conformance 契约套件全绿（A12 双层：golden 回放进 CI / run 层手动门）
- UC6.2 隔离池生命周期：poolKey 池化跨任务复用、refs.json 引用计数、record GC 联动删 journal、计数归零整池删（journal 除外）、清理失败置标记
- UC6.3 探针分级：按契约稳定性分级（zcode 强干跑回归 / codex/CC 官方 schema 机器校验最轻），factory 初始化 + 版本变化触发

### 3. 数据流关键节点

**现状流（§2.4）**：SubagentService.executeAndAwait → {worktree-manager（引擎无关）→ spawn pi --mode rpc（stdin JSONL / stdout 事件流 → spawn-event-adapter → AgentEvent）→ session 落盘 piAgentDir/subagents} + record appendEntry（引擎无关）‖ session-reconstructor 直读 pi JSONL ‖ runtime subagent-extractor 扫目录 → GUI。不变项：worktree-manager、record 写入通道、AgentEvent/AgentResult 消费方；变项：spawn 行、事件翻译行、session 落盘与读取行（按引擎分叉）。

**终态流（§3.3.4 reviewer@zcode 例）9 节点**：
1. 模型调用 subagent(agent=reviewer)
2. 引擎路由（frontmatter engine:zcode → ZcodeEngine，经注册表）
3. 公共层前置（schema 仿真段拼装 + NESTED env + worktree 创建）
4. preparer（`<dataDir>/engines/zcode/home-reviewer/` 隔离 HOME、config.json 原子写、argv 长度估算）
5. launcher（spawn `zcode --json --cwd <worktree> --mode yolo --disallowed-tools --prompt <persona+task+schema 段>`，stdin=/dev/null）
6. parser（stdout 有界收集 头4K+尾64K → 单 JSON {sessionId,response,usage} → 合成 coarse AgentEvent 流 → AgentOutcome）
7. journal 落盘（host 消费 onEvent → `journal-<taskId>.jsonl` 中立格式，seq 单调、有界缓冲批量 flush、终态 fsync）
8. record（SUBAGENT_RECORD appendEntry 进主会话 pi 通道，内嵌可持久化 handle）
9. read(handle)：sqlite 三级 JOIN → SessionView；失败降级 journal 重放 → outcome-only

**journal 等价性数据流**：onEvent → host 落盘 → 重放与 live 共用同一 reducer（updateFromEvent 范式，与主会话「live ≡ reload」纪律同构）——SessionView ②级 turns 重建逻辑 = live record turns 累积逻辑，不引入第二套解析器（conformance C5 断言）。

**错误时机流（D11 规则②）**：agent 解析期（engine_not_found）→ 探针期（engine_probe_failed）→ prepare 期（credential_missing / model_not_available / prompt_too_large，一律先于进程创建）→ 运行中（engine_run_failed / engine_timeout，合成终态不 reject）。

### 4. 核心模型（应建模的类型）

**中立类型层（§3.3.5-3.3.6）**：
1. `AgentTaskSpec`——ExecuteOptions 泛化：task/slug/agent/model 原样；`effort`（原 thinkingLevel 7 档语义剥离）；`persona: PersonaSpec`（原 skillPath + appendSystemPrompt 收拢）；schema/maxTurns/graceTurns/fork/worktree/cwd 原样；conversation/idleTimeoutMs 归 interact 控制面标志保留原名；新增 denyTools/permissionMode。删字段去向：signal/ctxModel/onComplete → RunContext；schemaEnv 内化 PiEngine
2. `PersonaSpec`——agentRef / skillPath / appendSystemPrompt（persona 路由三策略分流依据）
3. `AgentEvent`——8 种原样（tool_start/tool_end/text_delta/thinking_delta/turn_end/message_end/compaction/error），唯一权威定义 execution/types.ts（引擎层 re-export 不复制）；coarse 引擎最少合成 message_end + turn_end
4. `AgentOutcome`——锚定 orchestration AgentResult（content/parsedOutput/usage/durationMs/error/sessionId/sessionFile/worktreePath/toolCalls 原样）+ 新增 engineId / engineFallback{from,reason} / exitCode（null=被信号杀死）；与 execution 层同名 AgentResult（text/turns/...）消歧
5. `EngineCapabilities`——10 字段三态枚举：schemaEnforcement(native/emulated)、steer(native/emulated/unsupported)、conversation(native/unsupported)、personaInjection(file/flag/prompt)、eventGranularity(stream/coarse)、sandbox(native/emulated/none)、sessionRead(full/partial/outcome-only)、resume(native/cold/unsupported)、interrupt(native/kill-only)、permissionMode(native/fixed/ignored)。声明口径 = 链路接通能力非理论能力（pi steer 首期 unsupported）
6. `EnginePort`——5 方法：id / capabilities()（同步无副作用）/ probe() / run(task, ctx) / interact(handle, action) / read(handle)
7. `RunContext`——taskId(=record.id，journal 文件名与池引用 key) / poolKey / signal / onEvent / ctxModel
8. `EngineRunResult`——{handle, outcome}；handle 失败终态也返回（journal 定位）
9. `InteractAction`（message/close{force}/cancel）+ `InteractResult`（ok:true delivered / ok:false code+message）
10. `ProbeReport`——ok / engineVersion / checks[] / error{code,recovery}
11. `EngineHandleData`（持久化 JSON v1）——v / engineId / sessionRef（pi={sessionFile}，zcode={sessionId,dbPath}）/ poolKey / journalPath / engineVersion / adapterVersion。不透明性：除 record 持久化层与 read 降级链外不得解构
12. `SessionView`（v1）——engineId / sessionId / turns:ReplayedTurn[]（无 _status、closed 恒 true）/ usage:AgentUsageTotal / source:('native'|'journal'|'outcome-only')
13. event journal 行 schema——{v,ts,taskId,engineId,seq,event}；event 原样 JSON.stringify 无二次变换；seq host 单调递增（重放顺序权威）

**adapter 四件套接口（§3.3.7）**：
14. `EngineLauncher.launch(prepared, task) → EngineProcess`——唯一持有 spawn 权；EngineProcess{pid, stdin(可 null), stdout, stderr, abort(graceMs), exited}
15. `EngineParser.consume(proc, emit, signal) → ParserTerminal`——「事件先发、终态后返」；引擎输出异常不 reject、resolve 为含错误 terminal → engine_run_failed；ParserTerminal{exitCode, signal, sessionRef, stdoutTail(头4K+尾64K)}
16. `EnginePreparer.prepare(task, pool) → PreparedExecution`——spawn 前唯一副作用模块；PreparedExecution{env, cwd, poolDir, spawnedFiles, argvEstimateBytes}
17. `EngineReader.readNative(handle) → SessionView | undefined`——无状态只读、失败返回 undefined 不 throw；唯一允许 runtime import 的引擎模块（独立入口不 import 同包 launcher/preparer/parser）

**AgentEvent 产出不变量 5 条（C3 断言清单）**：终态序唯一（最后非 error 事件必 turn_end）；message_end.usage 出现即完整形状；流式 text_delta 拼接 === outcome.content（byte 级）/ coarse 至少一个 message_end；tool_start/tool_end 配对（未配对补齐或后续 error）；emit 完成先于 run() resolve（journal 完整性）。

**基础设施模型**：
18. `SubagentRecordEntryData` v2——新增 `engine?: {id, handle:EngineHandleData}`；v1 存量缺省按 pi 投影 + sessionFile（零迁移）
19. 隔离池 `refs.json`——{v, refs:{taskId:{taskId,ts}}}；acquire/release 语义；poolKey = sanitized-agent-name（agent 缺省 default，非 [a-zA-Z0-9-] 替换 -；model 不进 key；pi 恒 shared）
20. `PoolContext`（prepare 第二入参）+ engine registry（id → factory）

### 5. 模块边界（分层）

§3.3.1 总图 7 层 + 贯穿纪律：

```
L0 上层消费方（subagent 工具面 / workflow 引擎 / GUI）——不感知引擎
L1 中立类型层（AgentTaskSpec/AgentEvent/AgentOutcome/SessionView/EngineCapabilities）
L2 EnginePort（唯一契约点：run/interact/read/probe/capabilities）
L3 引擎注册表（id→factory）：PiEngine（回填行为零变化）/ ZcodeEngine（新增 spawn 单轮）/ 未来 4 家
L4 adapter 四件套（engines/<id>/）：launcher（唯一 spawn 权）/ parser（stdout→事件+终态）/ preparer（spawn 前唯一副作用）/ reader（共享只读双端复用）
L5 公共降级层（引擎无关写一次全引擎用）：schema 仿真 / abort 两级+超时杀链 / event journal / persona 路由 / 嵌套防护 / worktree 隔离
L6 （未来）driver host——server-mode 常驻进程管理，registry 持 per-engine 单例，接口不变
旁路：xyz-agent runtime subagent-extractor（P5 分协议读取）
```

**贯穿纪律 4 条**：①宿主编排（引擎只当单 agent 执行器，六家原生多 agent 机制禁用）；②capabilities 声明链路接通能力非理论能力；③降级写一次 + native/emulated 硬分流（schema 是样板：native 路径公共层不做二次校验——护 structured-output 方案 A 唯一权威）；④依赖方向单向（上层→中立类型/port；adapter→公共层；runtime 永不 import adapter 运行时件，例外仅 reader + 中立制品 record/journal）。

**关键归属裁定**（二轮审查成果，初稿易错点）：
- reader = 双端复用共享只读模块（非 adapter 私件、非 runtime 私件）；pi 直读下沉为 pi reader 保 A1
- journal ②级 = 宿主 host 职责（非 adapter 各自缓存——否则六种格式）；journal 不随池删（生命周期跟 record）
- 超时 = 宿主公共层职责（6/6 引擎全缺，天然公共层）
- GUI 历史链路 = reader ①级（非「runtime 只走 journal 投影」——被否方案）
- worktree = 公共层复用现有 worktree-manager（非引擎职责）
- stdin 写协议（pi RPC）= EngineProcess.stdin 引擎内部（不进公共层——仅 pi 有）

### 6. 状态机（record 状态 + 错误码）

**record 终态形态**（从设计文档合成终态语义推导）：
- 一次性任务：running →（正常）completed /（引擎失败）failed(engine_run_failed 合成) /（超时）engine_timeout /（cancel）aborted（杀链走完，exitCode=null + 杀链标记）——四种终态 record 均正常收尾不留僵尸
- conversation（pi 原生）：running →（轮终）idle（保留进程 + worktree，idle timer 默认 5min 可覆盖）→（message）running … →（close/cancel 或 idle 超时）终态
- idle 态死亡迁移：主会话 reload 后子进程死 → handle 仍在 record 内可 read（journal/record 投影），interact 返回 engine_session_not_resumable（不笼统失败）

**错误码全集（11 个，§3.3.3）**：engine_not_found / engine_probe_failed / engine_credential_missing / nested_spawn_rejected / schema_emulation_failed / engine_timeout / engine_capability_unsupported / engine_session_not_resumable / model_not_available / prompt_too_large / engine_run_failed。每类配恢复指引（终态四形态：版本命令 + 探针重跑命令 + 调研文档路径）。

**run() 错误语义三条**：①prepare 期错误（credential_missing/model_not_available/prompt_too_large）进程创建前 reject、不产生 handle；②运行中失败**不 reject**——合成 error outcome + 正常 handle 返回（record 必须收尾）；③abort 走完杀链同②（exitCode=null）。parser 边界同理：仅 parser 自身实现错误 reject，引擎输出异常 resolve 为含错误 terminal。

**fallback 状态迁移**（D9①）：probe 失败 →（无守卫）路由回全局默认引擎 + record 记 engineFallback{from,reason} + GUI 警告条（非错误）；（守卫 a 显式指定 / b 独有能力依赖 / c model 不可解析，或 strict）→ 不兜底，engine_probe_failed / model_not_available 终止。

**池生命周期**：池跨任务保留（不随单任务清理——db.sqlite 是 ①级数据源 + config 引导成本摊薄）；acquire(run 登记) → release(record GC 联动删 journal + 减计数) → 计数归零 → 整池删（仅引擎原生状态，journal 除外）；引擎配置移除 → 无视计数清池（journal 例外同上）；清理失败 → `.cleanup-failed` 标记可观测。spawnedFiles 单次性任务结束即清理（resume 保留）。

### 7. 范围边界（in/out of scope）

in：subagent 执行层引擎抽象 + pi 回填 + zcode 新引擎（spawn 单轮）+ 公共降级层 + 配置路由 + 探针 + runtime subagent-extractor 分协议读取（**中改动**）。
out：主会话引擎切换 / zcode conversation 模式（`--resume` 冷路径留后续）/ zcode app-server 常驻 / 其余四引擎实际实现（仅抽象适配性验证）。
MVP = {pi, zcode}（D10）；第二验证引擎建议 claude-code（后续 Phase 非首期承诺）；第三验证建议 opencode。

---

## 二、diff 结果

> 以下在重建落盘后，读两份初稿（requirements.md / system-architecture.md）逐项比对产生。判定级别：must_fix（PHANTOM / 语义级 MISMATCH / 关键 MISSING）/ suggestion（笔误、粒度差异、引用瑕疵）/ info。

### MISSING（重建有而初稿无）

**无 must_fix 级 MISSING。** 逐组核对记录：

| 重建项 | 初稿覆盖位置 | 判定 |
|--------|-------------|------|
| Actor 7 个（模型/用户/workflow 引擎/GUI/runtime/接入者/宿主） | 初稿 A 用例图 4 Actor + UC-7 子代理；「GUI」并入「用户（xyz-agent GUI）」，「workflow 引擎」在 UC-1/UC-5 语义在场，「宿主」在初稿 B §9 泳道图独立 participant | 粒度差异，语义全覆盖 |
| UC 6 组 19 项细分 | 初稿 A 合并为 9 个 UC；A1-A14 验收场景在 AC 层 14/14 全映射（AC-1.1~AC-9.3） | 合并式覆盖，无语义丢失 |
| 隔离池生命周期（UC6.2） | 初稿 A 数据清单「隔离目录池」行（池化保留/refs.json/计数归零整池删/journal 例外/清理失败标记）+ F12；初稿 B D5 + 特化决策表 | 非 UC 形态但语义完整 |
| 探针分级两端差异（zcode 强干跑 vs CC/codex 官方 schema 最轻） | 初稿 B D7 展开；初稿 A UC-4 前置条件仅提「分级」概念 | 需求层粒度可接受，架构层已覆盖 |
| 核心模型 20 项（含 PoolContext/refs.json/journal 行 schema） | 初稿 B §3 统一语言 + §4 模型表 + 关联图全列类型名与关键不变式；字段级规格采「引用不复制」策略指向设计文档 §3.3.5-3.3.9（符合其权威源声明） | 覆盖 |
| 关键归属裁定 6 条（reader 双端复用/journal 宿主归属/GUI 走①级/超时公共层/stdin 协议引擎内部/worktree 公共层） | 初稿 B §6 + D6 理由 + engines/pi/ 模块行 + §9 pi 差异说明 | 全覆盖（含「runtime 只走 journal 投影」被否方案的记录） |
| 池生命周期状态机（acquire→release→归零整池删/journal 例外/.cleanup-failed） | 初稿 B D5 + 初稿 A 数据清单 | 覆盖 |
| 范围边界（in/out + 硬差异四条） | 初稿 A §8 不做清单（含硬差异四条显示降级声明） | 覆盖 |
| 待验证检查点 5 条 | 初稿 A「待确认」5 条逐一对应 | 覆盖 |

### PHANTOM（初稿有而设计文档无 = 幻觉嫌疑）

**无 must_fix 级 PHANTOM。** 4 项「设计文档未显式出现」的内容经溯源均判定为合理推导/验证手段，非幻觉：

| 初稿内容 | 位置 | 溯源判定 |
|---------|------|---------|
| 引擎任务生命周期状态机（created/preparing/spawning/running/aborting/terminal/rejected） | 初稿 B §5 | 设计文档无显式枚举，但每个状态与转换均可从 D11 错误时机分级、§3.3.5 run 错误语义三条、D1 abort 分级直接推导；架构文档状态流转节为模板必需件。判定：合理建模非发明 |
| 反模式检查 AC-1~AC-5（grep 验收命令） | 初稿 B §11 | 设计文档无 grep 命令，但五条均系设计约束的机器化（AC-1↔方案 A 被否 / AC-2↔依赖纪律④ / AC-3↔D4 / AC-4↔D2 / AC-5↔getDataDir 锚定+项目 ENV_WHITELIST 规范）。判定：验证手段自加，非行为幻觉 |
| 行为契约保持 BC-1~BC-8（含源码位置） | 初稿 B §12 | A1/A13/A8 锚点的细化；源码位置（subagent-service.ts / pi-invocation / session-runner.test / types.ts 556-565）已核实真实存在且与设计文档 §2.1 引用一致。判定：合理细化 |
| 数据清单「敏感级别」列（凭据 config=高等） | 初稿 A §3 | 模板字段归纳，内容与设计文档一致（D5 凭据注入/隔离）。判定：可接受 |

### MISMATCH（两边有但语义偏移）

**MISMATCH-1 [suggestion]：capabilities 字段计数「11 维度」错误，应为 10 维度，且两份初稿内部矛盾。**

- 初稿位置：requirements.md §4 功能清单 F3「三级声明（native/emulated/unsupported 等 **11 维度**）」+ §决策记录 D3「含 personaInjection/eventGranularity/sessionRead/interrupt/permissionMode 等 **11 维度**」
- 权威源：设计文档 §3.3.5 D3 `interface EngineCapabilities` 实数 **10 个字段**（schemaEnforcement / steer / conversation / personaInjection / eventGranularity / sandbox / sessionRead / resume / interrupt / permissionMode）
- 交叉证据：system-architecture.md §3 统一语言正确写「**十维**：schemaEnforcement/steer/conversation/personaInjection/eventGranularity/sandbox/sessionRead/resume/interrupt/permissionMode」——同仓两稿一个 10 一个 11，内部矛盾
- 影响评估：字段名列举无错（「等」字列举的全是真实字段），纯计数笔误；但两处出现且与架构稿矛盾，会误导实施者寻找不存在的第 11 个字段。不属语义级偏移（未编造能力维度、未遗漏维度、未改变枚举值域），判 suggestion 修复（统一改为「十维」）

**MISMATCH-2 [info]：AC-2.3 的「（错误规格前三行）」引用定位不准。**

- 初稿位置：requirements.md UC-2 AC-2.3「prepare 期错误（engine_credential_missing / model_not_available / prompt_too_large）在进程创建前报出（错误规格前三行）」
- 权威源：设计文档 §3.3.3 错误规格表中这三个错误码分别位于第 3 / 9 / 10 行，并非「前三行」
- 影响评估：语义（prepare 期错误先于进程创建）正确，仅括号内引用定位不准。判 info，随 MISMATCH-1 一并顺手修正或删除括号

### 其他核对确认（无偏差项，抽记）

- 错误码全集 11 个逐一比对一致（初稿 B §5 Reason 映射表 vs 设计文档 §3.3.3），engineFallback 非错误留痕的身份两稿均正确区分
- run 错误语义三条（prepare 期 reject 不产 handle / 运行中不 reject 合成终态 / abort 同②）两稿转写一致
- 事件产出不变量五条逐字级一致（初稿 B §4 AgentEvent 不变式 vs 设计文档 §3.3.7）
- handle 不透明三条 + engine_session_not_resumable 推论一致
- journal 格式关键约束（AgentEvent 原样无二次变换 / seq 单调 / 不随池删 / 有界缓冲+终态 fsync / 重放共用同一 reducer）一致
- fallback 三守卫（显式指定/独有能力依赖/model 不可解析）+ strict 语义一致
- D1-D12 决策全转写，三轮审查状态标注与设计文档头部修订记录一致
- P1-P5 阶段 × A1-A14 验收分配逐一对齐（初稿 B 下游衔接表 vs 设计文档 §5）
- 现状断言「record 状态保持现有不动（ExecutionStatus 两态 + ClosedReason 六值 + mapExternalState 四态投影）」经源码核实准确（types.ts:49/62/65-74），且初稿 B 正确处理了「idle 已折入 running（v4 B-1）」的现状语义
- 六引擎能力表/附录 A 硬差异四条、zsub 参考不依赖、方案 B 否决理由，转写一致

## Verdict: APPROVED

无 must_fix 级 MISSING / PHANTOM / MISMATCH。两份初稿对设计文档的忠实度高：19 项细分用例被 9 UC 无损合并、A1-A14 全覆盖、接口契约层正确采「引用不复制」策略锚定设计文档 §3.3.5-3.3.9 为唯一权威、自建内容（状态机/AC grep/BC 清单）均可溯源至设计文档约束。

detail 阶段前建议顺手处理（非阻塞）：
1. MISMATCH-1：requirements.md F3 与决策记录 D3 的「11 维度」改「十维」，与 system-architecture.md 统一
2. MISMATCH-2：AC-2.3 括号「错误规格前三行」改为「错误规格 prepare 期三错误」或删除
