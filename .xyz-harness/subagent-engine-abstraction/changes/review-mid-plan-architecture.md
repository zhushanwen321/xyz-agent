# Review: system-architecture.md（架构合理性 + 边界审查，第 2 路）

> Reviewer 范式：对齐/补齐（认知帧 = 架构忠实度核查，非重新设计）。
> 上游权威源：`docs/architecture/subagent-engine-abstraction.md`（666 行，三轮对抗式审查通过）。
> 被审对象：`.xyz-harness/subagent-engine-abstraction/system-architecture.md`（542 行）+ requirements.md 交叉参照。
> 审查日期：2026-08-24。

## Verdict: APPROVED

无 must-fix（无架构失真、无边界破坏、无决策级漂移、无现状锚定错误）。3 条 should-fix（文档内部一致性/决策呈现弱化）+ 3 条 nit，均可在一处文档修订内闭合，不阻塞进入 issues 拆分。

## 审查结论（按任务六项检查）

### ① 边界划分 — 通过

- 四层职责边界清晰且三处（§2 设计立场 / §6 层级图 / §11 AC-2）口径一致：L1 中立类型层（语义）→ L2 EnginePort 五面（契约）→ L3 注册表 + adapter 四件套（实现）+ 公共降级层横切。
- **依赖方向单向成立**：上层 → 中立类型/port；adapter → 公共降级层；runtime 永不 import adapter 运行时件（launcher/preparer/parser）与 EnginePort 实例，例外收敛为两条（无状态共享 reader + 中立制品 record/journal），且特化决策表（§10 末）对例外给出了「违反什么/为什么合理/触发变化怎么办」的完整论证——不是悄悄开洞。
- adapter 四件套内部边界（launcher 唯一持 spawn 权 / preparer spawn 前唯一副作用 / parser「事件先发、终态后返」/ reader 无状态不 import 同包运行时件）与设计文档 §3.3.7 逐条一致。

### ② 复杂度归位 — 通过

- 引擎差异归 adapter：spawn 协议（pi rpc stdin vs zcode argv）、事件格式（流式 vs 单 JSON）、隔离手段（CONFIG_DIR vs HOME 覆盖）、读取格式（JSONL vs sqlite）全部收敛在 `engines/<id>/`，§7 变化轴表验证了隔离性（「新引擎接入 = 只加 engines/<id>/ + registry 一行 + golden 样本；CLI 漂移 = 只改 parser；降级策略 = 只在公共层」三轴互不传染）。
- 降级归公共层：五件（schema 仿真 / 杀链 / journal / persona 路由 / 嵌套防护 + 隔离池）横切复用，且有 D4 硬分流防越界（native 路径禁止二次校验）。
- 上层不感知引擎：AC-1 用 grep 清单机器化「引擎 id 分支反模式消除」。

### ③ Port 清单合理性 — 通过（EnginePort 是真 seam）

- 实现数 2（PiEngine 回填 / ZcodeEngine 新增）+ 4 预留位，接口受六引擎调研（四份 agent-engine-*.md）全集约束而非按两引擎局部设计——seam 的抽象依据充分。
- interact 为可选面（低交互引擎 unsupported 声明 + 调用前拒绝），避免了为 pi chatMode 强加双语义。
- AgentRunner（既有）明确「不动、仅 execution 内部委托链改造」——与现状（orchestration/models/ports.ts:34 已验证）一致，改造面收敛正确。

### ④ 分层与模块划分 vs 设计文档 §3.3.1 — 一致

L1/L2/L3 编号 + 横切公共降级层 + driver host 未来预留 + reader 双端复用例外，与设计文档分层总图逐项对应；§7 模块表与设计文档 §5 P1-P5 阶段表及文件改动地图一致；接口契约细节正确地「引用不复制」设计文档 §3.3.5-§3.3.9（避免双权威漂移，§文首声明明确）。

### ⑤ D1-D12 决策忠实性 — 11 条忠实、1 条轻微弱化（详见下方核对表）

### ⑥ BC-1~BC-8 覆盖 A1 零回归锚点 — 覆盖完整

A1 三锚点分别落 BC-1（record 快照字段级 diff）/ BC-2（GUI 截图基线）/ BC-3（schema env 注入 byte 级等值）；BC-4 现有测试守护、BC-5↔A8、BC-6 存量零迁移、BC-7↔A13、BC-8 类型面消费方零改动。每条 BC 均带源码位置锚点且经代码验证（见下）。

---

## D1-D12 逐条对照核对表（vs 设计文档 §3.3.2）

| # | 主题 | 判定 | 说明 |
|---|------|------|------|
| D1 | run 主语义 + interact 可选面 + handle 三条 + abort 分级 | 忠实 | 五要素全保留；理由段（A1 违反/复杂度翻倍/常驻留内部）完整 |
| D2 | 中立类型从现有泛化 | 忠实 | thinkingLevel→effort、skillPath 收 persona、同名消歧（AgentOutcome 锚 orchestration 版）均与设计文档一致 |
| D3 | capabilities 三级声明 | 忠实 | 十维与设计文档接口字段数一致（10）；链路接通口径、steer 首期 unsupported 均保留 |
| D4 | 降级归公共层 + native/emulated 硬分流 | 忠实 | 五件清单、硬边界「不做二次校验不改写」、方案 A [HISTORICAL] 论据完整 |
| D5 | per-engine preparer + 池化 + refs.json | 忠实 | argv 前置估算、池粒度回收、journal 不随池删、spawnedFiles/resume 语义、.cleanup-failed 全保留 |
| D6 | SessionView + 三级降级链 + journal 第②级宿主 | 忠实 | reader 双端共享只读、pi 直读下沉、白名单校验、journal 不随池删一致 |
| D7 | 探针按契约稳定性分级 | 忠实 | 二进制/版本/干跑三查、golden 一处采集两处消费、触发时机一致 |
| D8 | 嵌套防护双层 + 宿主编排 | 忠实 | 统一标记 + 原生标记清理清单、六引擎原生多 agent 禁用一致 |
| D9 | 三层路由 + fallback 三守卫 + model/engine 正交 | **弱化（轻微）** | 三守卫 a/b/c 与 strict 完整，但缺「守卫 b 首期声明载体 = step/调用级显式 engine，与守卫 a 合流；AgentTaskSpec 下钻时补 `requires?: Partial<EngineCapabilities>` 后独立生效」——见 should-fix #2 |
| D10 | MVP = { pi, zcode } | 忠实 | 首期范围、第二验证引擎 CC 非首期承诺标注一致 |
| D11 | 四级处置 + 三规则 | 忠实 | 四级表、三规则（类别分发/错误先于进程/双错误通道）完整 |
| D12 | conformance + golden 验收门 | 忠实 | C1-C8、负例元测试、两层结构（回放进 CI/run 手动门）、第三验证引擎 opencode 一致 |

另核查 §10 特化决策表三条（reader 双端复用 / journal 写进引擎目录树 / pi poolKey 恒 shared）：均可在设计文档 §3.3.7 / §3.3.6+D5 / §3.3.9 找到依据，无发明新决策。

## 现状锚点代码抽查（4+ 处，全部核实）

| 锚点 | 架构文档声称 | 代码实证 | 判定 |
|------|------------|---------|------|
| execution 目录结构 | 现有 spawn 链内联（session-runner/pi-invocation/stdin-writer/spawn-event-adapter/get-state-handshake/session-reconstructor），`engine/` 为本次新增 | `ls` 确认：上述文件全部存在；`execution/engine/` 不存在（待新建，符合 P1 计划）；`shared/meta-parser.ts` 无 engine 字段（P4 新增项，符合预期） | 准确 |
| AgentRunner port | 既有 port，本次不动，SubprocessAgentRunner 委托链改造 | `orchestration/models/ports.ts:34` `interface AgentRunner { run(opts, signal, onEvent?, stream?): Promise<AgentResult> }`；`subprocess-agent-runner.ts` 存在 | 准确 |
| AgentEvent 唯一权威 | 唯一权威定义在 execution/types.ts，引擎层 re-export 不复制 | `execution/types.ts:92` 为 union 定义；`shared/agent-event.ts:13` 为 re-export 收口且注释明说「唯一定义在 execution/types.ts」；AC-4 的 grep pattern 不会误伤该 re-export 语句 | 准确 |
| ExecuteOptions pi 专有字段（D2 依据） | thinkingLevel/skillPath/conversation/idleTimeoutMs 为 pi 专有形态 | `execution/types.ts:526` ExecuteOptions；:535 thinkingLevel / :536 skillPath / :560 conversation / :565 idleTimeoutMs | 准确 |
| AgentResult 同名不同义（D2 消歧依据） | orchestration 版（workflow 消费）vs execution 版（record 投影）双份同名 | `orchestration/models/types.ts:182` 与 `execution/types.ts:244` 双份并存，语义正如所述 | 准确 |
| record 对外四态投影 | active/waiting/ended/error（mapExternalState） | `execution/types.ts:77` `ExternalState = "active" \| "waiting" \| "ended" \| "error"`；`interface/subagent-actions.ts:142` mapExternalState | 准确 |
| BC-3 schemaEnv 锚点 | session-runner/pi-invocation schemaEnv 派生 | `session-runner.ts:436-480`（D-A6 bridge，schemaEnv 经 ExecuteOptions 透传注入 childEnv） | 准确 |
| BC-5/BC-7 锚点 | subagent-extractor / chatMode action | `packages/runtime/src/services/session/subagent-extractor.ts` 存在；`subagent-service.ts:1548+` closeAfterRound/finalizeRoundToIdle chatMode 逻辑 | 准确 |

数量统计（status transparency）：计划抽查 3 处，实际验证 8 处锚点，全部准确，0 失真。

## must_fix

无。

## should_fix

1. **§5 状态机内部矛盾：engine_not_found 的时序两说**（位置：§5 Reason 表首行 vs §5 合法转换图）
   - Reason 表标 engine_not_found「前置拒绝（**created 前**，同步）」；状态图却是 `created --> rejected : 前置拒绝（engine_not_found / ...）`，且状态表 created 行关键动作就是「三层优先级解析引擎」（即解析发生在 record 受理**之后**）。record 是否已创建/落盘两说直接相反。
   - 影响实施：AC-1.3 / A11 测试场景需要断言「解析期报错时 record 是否存在、状态是什么」，两处口径会导致相反的测试断言。
   - 修复建议：统一为状态图口径——record 受理（created）后路由失败转 rejected 终态收尾；Reason 表该行改为「前置拒绝（created 后、引擎进程创建前，同步）」。同时把 rejected 补进状态表 terminal 行（当前 terminal 集合只列 completed/failed/aborted/timed-out，图有表无，属同源不一致，可一并修）。

2. **§10 D9 守卫 b 缺首期合流说明**（位置：§10 D9 决策条目）
   - 设计文档 §3.3.2 D9 守卫 b 明确：「**首期声明载体 = step/调用级显式 engine，与守卫 a 合流**，AgentTaskSpec 下钻时补 `requires?: Partial<EngineCapabilities>` 后独立生效」。架构文档只写「b) task 声明依赖该引擎独有能力（capabilities 对照…）」，未注明首期与守卫 a 合流。
   - 影响实施：issues 拆分阶段可能按字面为 P4 排「独立的 capabilities 对照机制」工作量，而设计意图首期无需它。
   - 修复建议：D9 决策补一句「首期守卫 b 声明载体 = 显式 engine 指定，与守卫 a 合流；`requires` 字段待 AgentTaskSpec 下钻时补」。

3. **capabilities 维度数跨文档漂移**（位置：§3 术语表 EngineCapabilities 行「十维」 vs requirements.md F3「11 维度」）
   - 设计文档 §3.3.2 D3 接口为 10 个字段，架构文档「十维」正确；requirements.md F3 写「native/emulated/unsupported 等 11 维度」多数了一维。
   - 影响实施：下游按 requirements 数维度做 capabilities 测试清单会多写一维。
   - 修复建议：改 requirements.md F3 为「10 维度」（本仓文档，一句话修订）；或架构文档加注「requirements F3 的 11 为笔误」。前者更干净。

## nit

1. **AC-2 grep pattern 的 BRE 可移植性**（§11 AC-2）：`engines/\(pi\|zcode\)/\(launcher\|preparer\|parser\)` 依赖 GNU grep 的 BRE `\|` 扩展，macOS BSD grep 不支持；建议改 `grep -rEn "engines/(pi|zcode)/(launcher|preparer|parser)"`。文档已声明「实施落地时允许微调 pattern」，故仅 nit。
2. **术语表 poolKey 缺省值细节**（§3）：设计文档 §3.3.9 还有「agent 未指定时 `default`」一条，架构文档「净化后 agent 名」未含；「引用不复制」策略下可接受，补半句更完整。
3. **§5 状态表「timed-out」连字符**：terminal 集合写 `timed-out`，状态图节点写 `timed_out`（下划线）——同一状态两种拼写，建议统一（不影响语义，纯一致性）。

## 亮点（对齐帧下值得留档的忠实呈现）

- 接口契约「引用不复制」策略（§文首声明）正确避免了双权威漂移——mid 架构文档与 666 行设计文档之间只有一个权威源。
- §11 反模式检查把设计文档的「贯穿纪律」转成 5 组可机器执行的 grep 验收，是纪律→DoD 的正确提炼姿势。
- §5 明确「record 状态机不动、引擎任务生命周期是 record 内引擎侧阶段」，两套状态机的正交关系讲清楚了——这是重构模式最容易混的地方。
