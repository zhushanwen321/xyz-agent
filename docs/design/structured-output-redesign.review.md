# structured-output 终态重设计 · 对抗式审查报告

> 审查对象：`docs/design/structured-output-redesign.md`（v1，2026-08-28）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`
> 审查方式：文档全部 pi 行为断言与事故数据逐条 read 源码 / 复跑探针核实；事故结论经 session_read 抽查（事故核实 session T002）。
> 只报告不修复。

## Summary

**2 must-fix, 4 suggestions（另 1 条 INFO）。总体判定：M1（单参数工具）方向成立、事实基线扎实；M2（turn 内硬闸门）的核心机制在 pi 实装管线中结构性不可达——按现设计实施，§8 S2 验收必然失败，G2（失败必有界）不成立。**

事实核实命中率：抽查 23 项关键断言，**18 项命中、5 项偏离**（2 项决策级 → must-fix；3 项细节级 → suggestion/INFO）。文档引用的源码引文、事故数据、探针 P1/P2/P4 的机制分支全部属实（本人复跑探针证实）；两条决策级偏离集中在「闸门触发时序」与「输出契约的额外属性语义」，均属文档未验证的运行时断言。

## 事实核实清单（23 项）

| # | 文档断言 | 核实结果 | 证据 |
|---|---------|---------|------|
| 1 | §3.1① 工具 description 引文 | 命中 | `structured-output/src/tool-definition.ts:30-33` 逐字一致 |
| 2 | §3.1② prompt 注入段引文 | 命中 | `subagent-workflow/src/orchestration/agent-opts-resolver.ts:70-82` |
| 3 | §3.1③ hook reminder 引文 | 命中 | `structured-output/src/workflow-hook.ts`（calledButFailed / 未调用两分支文案逐字一致） |
| 4 | §3.1④ Type.Object 双属性必填 | 命中 | `tool-definition.ts:52-59`（无 Optional；事故 session 实测报 "must have required properties schema"） |
| 5 | §3.2 错误产生于参数层（execute 之前） | 命中 | `pi-ai/dist/utils/validation.js:280-308`（throw 于 validateToolArguments） |
| 6 | execute 权威分支忽略模型 schema | 命中 | `structured-output/src/execute.ts`（validateWithAuthoritative 只用 authSchema） |
| 7 | P1 TYPEBOX_KIND 分支存在 | 命中 | `validation.js:285-297`（非 typebox → coerceWithJsonSchema 回拷） |
| 8 | P2 validate → prepared.args → execute | 命中 | `pi-agent-core/dist/agent-loop.js:404→426-433→457` |
| 9 | P4 参数层类型矫正（含嵌套） | 命中 | 复跑探针：`{age:'42'}`→`42`；`assessments[].score:'7'`→`7`（coerceWithJsonSchema 路径；Value.Convert 对普通 schema 不生效但被该分支兜住） |
| 10 | P3 ToolCallEventResult / shouldTerminateToolBatch 字面存在 | 命中，**但时序约束缺失** | `pi-coding-agent/dist/core/extensions/types.d.ts:779-788`；`agent-loop.js:377-379`（批内全 terminate 才停）→ 见 MUST_FIX-1 |
| 11 | 事故数据（345 调用 / 撕裂 / deepseek 4+1 / glm 错 1-2 轮） | 命中 | 事故核实 session T002 entry 8/37：同批 5 个 deepseek 4 个第二轮修复、1 个死循环；grep 实测 `工具调用: {None: 345}`；根因结论「接口设计有确凿 bug，是根因和触发器」与文档 R1 一致 |
| 12 | watchdog 缺省按 10 turns 估 50 分钟 | 命中 | `session-runner.ts:152-166`（"maxTurns 缺省按 10 turns 估 → 50 分钟"） |
| 13 | schema-emulation.ts 存在且硬分流 | 命中 | `subagent-workflow/src/execution/engine/common/schema-emulation.ts` |
| 14 | prompt-quality.test.ts 文本锁存在 | 命中 | `structured-output/tests/prompt-quality.test.ts`（10 用例） |
| 15 | S3 可行：chain 步骤带 agent({schema}) | 命中 | `workflows/chain.js:55-58, 78-81`（analyze/transform 步均声明 schema） |
| 16 | 消费者零改动（extractParsedOutput 取 details） | 命中 | `output-collector.ts:47-55`（末次带 details 的 structured-output 调用胜出） |
| 17 | 探针基线 pi 0.84.2 | 命中 | 全局 `@earendil-works/pi-coding-agent@0.84.2`（但见 SUGGESTION-4 版本矩阵） |
| 18 | mandatory-extensions.json 无需改 | 命中 | `packages/shared/src/mandatory-extensions.json:8`（包数不变） |
| 19 | §6.3 闸门经 tool_call 事件可拦停参数层失败循环 | **偏离（决策级）** | 见 MUST_FIX-1 |
| 20 | §5.1「模型想传 schema 也无处可传」 | **偏离（决策级）** | 见 MUST_FIX-2（探针：未声明 additionalProperties 时多塞字段通过并流入返回值） |
| 21 | §5.2 形态 a 错误文案（含"👉"修正行 + 引文措辞） | 偏离（细节） | 见 SUGGESTION-1 |
| 22 | §7.1「boolean true 拦截 = validateWithAuthoritative 前半段」 | 偏离（细节） | boolean true 拦截在 `executeStructuredOutput`（execute.ts ERR-7 段），keyword-less 才在 validateWithAuthoritative |
| 23 | 版本锚定完备性 | 部分偏离（细节） | 全局 0.84.2 / 项目 node_modules 0.84.1 / 碳上生产版本未登记，见 SUGGESTION-4 |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §6.3 D3 / §5.2 形态 b / §11 P3、P7 / §2 G2 | P0-10 + P0-11 + P0-16 | **闸门 block+terminate 对其全部目标失败形态结构性不可达。** extension 的 `tool_call` 事件接线是 `beforeToolCall`（`pi-coding-agent/dist/core/agent-session.js:224-246`），而 agent-loop 的 prepareToolCall 顺序是 `validateToolArguments`（`agent-loop.js:404`）→ `beforeToolCall`（:405）→ execute；参数校验抛错走 catch → immediate error 路径，**beforeToolCall 根本不被调用**。即：参数层失败的调用（事故撕裂形态 B、§5.2 形态 a 的全部）永远到不了闸门 handler；而能通过校验的调用在 D2 透传 execute 下几乎不会产生错误。同时 `tool_execution_end` handler 无返回值类型（`types.d.ts:894`，不能 block/terminate），`tool_result` 事件对 immediate 结果不触发（`agent-loop.js:316/357` 仅 executed 路径走 finalizeExecutedToolCall→afterToolCall）。实测探针：撕裂形态 `{schema:{...}, required:[...]}` 缺全部必填字段 → 校验失败 → immediate 路径。**后果链**：G2 不成立；§5.2 形态 b 文案不可达；S2 按现通过标准（调用 ≤4 次）必然失败（计数照涨、批照跑、无终止）；M1 上线后修复路径中重生成大 JSON 的撕裂同样无界。讽刺的是文档 §6.3 被否方案①（"execute 内计数不可行：参数层失败在 execute 之前被拦"）的同一推理恰好也否掉了 tool_call 方案——三处出口（execute / tool_call / tool_result）全部位于参数层之后或对 immediate 不触发，文档只排查了第一处。P3 标 ✅ 但探针只验证了"机制存在"，未验证"对目标失败类触发"，属不完整探针 | terminal 态改在 `tool_execution_end` handler 内调 `pi.abort()`（ExtensionContext.abort 存在：`types.d.ts:235-238`；agent-loop 批循环内多处检查 `signal?.aborted`）或 `pi.shutdown()`；新增 P7' 探针验证 abort 后 workflow 侧 AgentResult.error / exit code 呈现形态（session-runner 对 abort 的解释未经核实）。同时重写 P3：补充"beforeToolCall 位于 validateToolArguments 之后"的时序约束，✅ 降级；P7 的降级路径"维持每层 block+terminate"随之作废需重写 |
| MUST_FIX | §5.1「无处可传」/ §6.2 D2 / §8 S5 | P0-12（+P0-13/14 关联） | **额外属性污染面迁移进输出契约，设计未决策且 S5 断言方向反了。** 实测：权威 schema 未声明 additionalProperties 时，`validateToolArguments` 放行多余字段并原样返回（`{name:'a', age:1, schema:{type:'object',...}}` 校验通过、整包成为 args）→ D2 透传 → `details` → `parsedOutput`。旧设计把模型习惯性携带的 schema 隔离在 envelope 专用参数里（被忽略、data 干净）；新设计把它直接放进 workflow 输出。事故已证明 deepseek 类模型有强烈的携带 schema 倾向（342 次撕裂产物全是重建 schema 的尝试）。S5 通过标准写"多塞字段不影响 data 校验与 details 提取"——把污染固化为准行行为；§5.1"参数列表里没有 schema 字段（无处可传）"仅在 schema 声明 `additionalProperties:false` 时为真（实测声明后会被正确拒绝：`root: must not have additional properties`） | 设计层显式决策并写进 §6/§7：推荐 execute 按权威 schema 顶层 `properties`/`patternProperties` 白名单剥离未声明属性（这是输出规范化而非第二校验权威，与 D2 论证不冲突）；或包装层对未声明 additionalProperties 的 schema 补 `false`（语义收紧需文档化）；至少将 S5 断言改为"parsedOutput 不含 schema 声明之外的顶层字段"并删除"无处可传"的绝对化表述 |
| SUGGESTION | §5.2 形态 a | P1-8 / P0-11 细节 | 错误文案中的"👉 修正 data…"行无实现通道：pi-ai 在 validateToolArguments 内部格式化参数层错误（实测形态：`Validation failed for tool "structured-output":\n  - overall_direction: must have required properties overall_direction\n\nReceived arguments: {...}`），参数层失败不经过任何可改写错误文本的 hook（beforeToolCall/afterToolCall 均不触发）。文档引文 `must have required property 'schema'` 与实装措辞也有字差（实为复数、无引号） | 接受 pi-ai 原生文案（错误已含具体路径 + args 回显，自解释性够），或把恢复指引移到闸门/steer 通道交付；引文按实装修正 |
| SUGGESTION | §7 测试 | P0-12 轻量 | 测试改动清单遗漏两个既有文件：`tests/retry-state.test.ts`（7 用例，§7.4 给 RetryState 加 terminal 态必触）与 `tests/characterization-hook.test.ts`（18 用例，锁定 hook 时序基线，terminal 不 steer 会改变其锁定的"超上限保留 lastSchemaError"等行为） | U3 清单补两文件；characterization 用例需按"行为基线随设计变更重锁"处理而非零改动全绿 |
| SUGGESTION | §6.2 D2 | P0-16 / P1-6 | 校验引擎从 ajv(strict:false) 换成 TypeBox Compile 的语义差未讨论。D2 以"同一份 schema ⇒ 第二校验权威"论证删除 execute 内 ajv，但"同一份 schema"不等于"同一套校验语义"：实测 TypeBox 强制 const/pattern/minLength/oneOf/multipleOf/if-then-else/$ref，format 双侧都忽略（`ajv-validator.ts` 未注册 ajv-formats）；TypeBox 对不识别关键字的静默忽略面与 ajv strict:false 的全 draft-07 支持存在理论差 | §6.2 补一段引擎差异说明；把"L4-L6 schema 的全部关键字经 TypeBox 强制"列入 S1 检查项（顺带覆盖此风险） |
| SUGGESTION | §11 / 证据基线 | INFO / P0-11 边缘 | 探针锚定全局 pi 0.84.2；项目 node_modules 为 0.84.1（`package.json` 精确锁 0.84.1），碳上生产 workflow 所用 pi 版本未登记。按项目 AGENTS.md 版本漂移教训（0.80.3 clone 断言 0.84.1 行为连产 4 条漂移 bug），关键时序事实（MUST_FIX-1 的管线顺序）应在验收/生产环境版本上复验 | 验收章节补 pi 版本矩阵（本地 CLI / xyz-agent 打包 / 碳上生产三者），MUST_FIX-1 的时序结论在碳上版本复跑一次探针 |
| INFO | §7.1 | P1-8 | "boolean true 拦截——现 validateWithAuthoritative 的前半段"表述与代码位置有字差：boolean true（ERR-7）在 `executeStructuredOutput`，keyword-less 拒绝才在 `validateWithAuthoritative` | 上移描述改为"现 execute.ts 权威分支的两项加载期防御" |

## 判定四态（P0 清单）

| 检查项 | 判定 | 依据 |
|--------|------|------|
| P0-1 五段骨架 | 通过 | 五段俱全（§1/§3/§5-7/§8/§10） |
| P0-2 delta 链 | 通过 | v1 初版无悬空引用；证据基线自包含（session 路径 + dist 版本可追溯） |
| P0-3 结论先行 | 通过 | 每章首行"本章结论"；SCQA 开篇 |
| P0-4 问题定义 | 通过 | 定义打到根因层（R1 接口形态/R2 闸门缺位/R3 放大器），有真实负载例子 |
| P0-5 重实现轻体验 | 通过 | §3/§5 模型视角四方信息 + 交互样例 |
| P0-6 抽象术语 | 通过 | 权威 schema/参数撕裂均在 §1 定义并绑定事故实例 |
| P0-7/8/9 方案对比 | 通过 | 四方案 × 长期/短期/风险三维 + 明确裁决 |
| P0-10 解决目标问题 | **不通过** | G1/G3 因果链成立（结构消除矛盾，探针证实机制可行）；G2 因果链断裂（MUST_FIX-1：闸门对目标失败形态不可达） |
| P0-11 关键事实 | **不通过** | MUST_FIX-1（tool_call 触发时序）、MUST_FIX-2（additionalProperties 语义）均为影响决策的事实偏离 |
| P0-12 副作用遗漏 | **不通过** | MUST_FIX-2（输出契约污染面）；SUGGESTION-2（测试清单）、版本矩阵 |
| P0-13 验收存在且 testable | 通过（有条件） | 5 场景均有可执行判据并回溯 G1-G4；S5 判据方向需随 MUST_FIX-2 重写 |
| P0-14 真实场景非 mock | 通过 | 全部真实 pi CLI + 真实模型 + 生产 schema；S5 含负面反向验证 |
| P0-15 验收投入匹配 | 通过 | 大改动配 5 场景 6+ 实跑，匹配 |
| P0-16 运行时断言探针 | **不通过** | P3 标 ✅ 但探针不完整（未验证对目标失败类的触发时序）；P7 的降级路径依赖被证伪的 block+terminate 机制。P1/P2/P4 复跑证实为真 |
| P0-17 物理数据流图 | 通过 | §4 三列物理数据流（磁盘/子进程/校验层），env 桥接标注完整 |
| P0-18 错误恢复指引 | 通过 | §5.2 四形态均配指引（形态 a 文案可实现性见 SUGGESTION-1） |

## 结论

文档的问题定义、根因分层、业界对照与 M1 方案（单参数工具）经对抗检验后站得住——引文、事故数据、机制分支全部属实，P1/P2/P4 探针可复现。**但 M2 的硬闸门是在未验证触发时序的情况下设计的**：`tool_call`（beforeToolCall）位于参数校验之后，对参数层失败循环（事故的全部形态）无拦截能力，`tool_execution_end` 无返回值、`tool_result` 对 immediate 不触发——扩展在目标场景下没有任何硬终止出口。G2 的成立依赖重新选择终止通道（`pi.abort()` / `pi.shutdown()` + P7' 探针）。另须把输出契约的额外属性语义从隐式接受改为显式设计。两项修复后，本设计方可进入实施拆分。
