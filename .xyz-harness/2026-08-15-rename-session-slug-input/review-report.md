# rename-session 设计文档对抗式审查报告

> 审查对象：`.xyz-harness/2026-08-15-rename-session-slug-input/design.md`（v1）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md` + 项目 `AGENTS.md`
> 所有「事实」类判定均已 read 源码核实，证据文件与行号在每条 finding 内注明。

## Summary

2 must-fix, 7 suggestions.

核心结论：方案的**机制**（两段信号注入 + slug prompt + stop 计数 + fast path + timeout + 防覆盖）经源码逐行推演**可以工作并达成 G1-G4**，但文档对 pi `turn_end` 事件的语义模型是错的（以为一个用户轮次发一次 turn_end，实际**每个 LLM iteration 发一次**）。该错误导致 §4 数据流图、D2 的「✅探针已测」声明、§3.2 失败模式 A 的注入范围描述、C3 的现状行为描述全部失真；另有一处防覆盖检查位置的内部矛盾留下竞态窗口。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4 定义与数据流图 / §6 D2 / §3.2 失败模式A / §3.2 C3 / §3.3 | P0-11 事实 + P0-16 运行时断言无有效探针 | **turn 语义模型错误**：文档把「turn」当作用户轮次（prompt→…→最终回复→turn_end 发一次）。实际 pi 的 turn = **一次 LLM response + 其工具调用**，turn_end 每个 iteration 发一次。证据①（pi 官方文档）：`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:574-584`——"turn_start / turn_end: **Fired for each turn (one LLM response + tool calls)**"。证据②（agent 循环源码）：`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:85-131`——内层 while 每个 LLM response 后 `emit({type:"turn_end", message, toolResults})`。证据③（真实 session JSONL）：`~/.pi/agent/sessions/--Users-...-feat-rename-session-model--/2026-08-14T15-37-16-724Z_*.jsonl` 第 8 行 `session_info` 出现在第 1 条 assistant(stop=toolUse)+2 条 toolResult 之后、第 9 行 turn 仍在继续——**现状 rename 在轮次中途（首个 iteration 结束时）就触发了**。由此产生四个连锁失真：(a) D2 声称「turn_end 的 message 字段就是该 turn 最后一条 assistant message，✅探针已测」——探针只验证了事件**形状**（`agent-session.js:443-451` 确有 message 字段），没验证**时机语义**；在任意 turn_end 时刻 message 是**该 iteration** 的 assistant 消息，首个 turn_end 携带的是 stopReason=toolUse 的首条消息（常无 text），不是「最终回复」。(b) §3.2 失败模式 A「30 个工具调用的全部输入输出都发给标题模型」不成立——现状触发点在首个 iteration 的 turn_end，只注入 user + 首条 assistant + 首批 toolResult，非整轮。(c) C3「首 turn 出错后永不命名」不成立——error 消息的 message_end 先于 turn_end 发射并落库（`agent-loop.js:240/253`→`108-111`；真实 JSONL 第 13 行存在 `stop=error` assistant entry），error 轮自身的 turn_end 时 countAssistantReplies===1 即触发 rename（基于 error 上下文命名）；「永不命名」只在 error 发生在第 ≥2 个 iteration 时成立。(d) §4 数据流图「turn 内 [assistant→toolResult]×N → 最终 assistant → turn_end」与真实事件流不符。**注意：方案的代码机制（§7.3 fast path `stopReason!=="stop"` + `countSuccessfulAssistantReplies===1`）在正确语义下推演仍成立**——fast path 过滤掉中间 iteration，最终 iteration 的 turn_end 时 stop 计数恰为 1 且 event.message 即最终消息；甚至纯 stop 计数本身（无 fast path）也自防护（中间时刻 stop 计数为 0）。错误的是文档的论证与现状分析，不是机制。但按反例集「运行时断言靠推理」病根，带错误模型的文档会让实施者用错误理解去写 E2E 断言与排查问题。 | 用正确语义重写 §4 定义/数据流、D2、§3.2 A/C3：明确「pi turn = 一次 LLM response + 工具调用；用户轮次 = 多个 turn」；把现状真实失败模式补上（**工具型首轮在首个 iteration 中途触发 rename，基于不完整上下文生成标题**——这本身就是标题质量问题，比文档列的三个缺口更贴近用户观感）；D2 的✅声明改为引用 extensions.md 的 turn 定义 |
| MUST_FIX | §6 D5 vs §7.3 | P0-10 方案未完全解决目标 / P0-12 副作用 | **防覆盖检查位置内部矛盾 + LLM 调用窗口竞态**：D5 说「**落库前** `if (pi.getSessionName()) return`」（正确位置：setSessionName 之前，即 LLM 返回后），但 §7.3 的 handler 代码草图把检查放在 fire-and-forget 调用 `callRenameLLM` **之前**。按 §7.3 实现，用户在 LLM 调用进行中（2-5s，超时上限 30s）手动 `/name`（RPC `set_session_name`，已核实存在：`docs/rpc.md:772-784`）→ rename 返回后 `pi.setSessionName(title)`（现状 `index.ts:39-42` 的 .then 路径）**仍然覆盖手动命名**——G3「不被覆盖」未完全交付。 | 把检查明确放在 `.then(title => { if (!title) return; if (pi.getSessionName()) { debug日志; return; } pi.setSessionName(title) })`；§7.3 草图同步修正；A3 可加一个「turn_end 后、rename 返回前手动命名」的竞态子场景（实施上可在 debug 日志出现 request 后立即 RPC set_session_name） |
| SUGGESTION | §8.2 回应用户三问-1 / §6 D9 | P0-13 验收证据链论证 | **证据链能证明结论，但证明力来源与文档所述不符**：(1)「JSONL 行序（最硬）」言过其实——行序只证明 rename **完成**于该轮全部 entry 之后（session_info 的位置），不能单独证明**调用发起**于 turn_end 之后（中途发起、稍后完成的调用同样满足行序）；真正起判别作用的是**内容匹配**（中途 iteration 触发时 assistant 文本与「该轮最后一条 assistant message」必不一致）——而这一判别恰好依赖文档缺失的正确 turn 语义（每 iteration 一次 turn_end 才存在「中途触发」的可能）。（2）D9 日志无时间戳、无 turnIndex/turn 标识，「一次 turn 只有一条 LLM request 日志」的归属只能靠单轮 E2E 场景保证。（3）内部矛盾：D9 规定每条 message text 截断 200 字符，§8.2 却断言「日志含 user prompt 的**首尾**特征片段」——超过 200 字符的 prompt 尾片段根本不在日志里（A1 场景 prompt 短，实际不炸，但断言写法错了）。 | debug 日志行加时间戳（或 ISO time）+ turnIndex；E2E harness 交错记录 stdout 事件流与 stderr 日志的到达顺序（这是「调用时机」的直接证据，比行序硬）；删掉「尾片段」断言或改为「日志对长 prompt 显式输出 head+tail 各 N 字符」 |
| SUGGESTION | §6 D6 / §7.3 fast path | P0-12 边界遗漏 | **`stopReason === "length"` 边缘**：pi `StopReason = "stop" \| "length" \| "toolUse" \| "error" \| "aborted"`（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:273`）。fast path 与 stop 计数都把 `length`（输出被 max token 截断，但轮次实质成功）当非成功——首轮以 length 结束的 session 本轮不命名，退到下一轮（stop 计数届时为 1，仍会命名，但基于下一轮回复）。60 个真实 session 统计中 length 出现 0 次，属低频边缘，但设计未提。 | 在 D6 说明 length 的处理（要么文档化为「延迟一轮命名」，要么 fast path 放行 length 并计入成功） |
| SUGGESTION | §8.3 A4 | P0-13 可执行性 / P1-3 | **阶段 2「换回正常模型配置（同 session 继续）」机制未指明**：provider/models.json/enabledModels 配置在进程启动时读取，阶段 1→2 换配置必须重启 pi 进程，再以 `--session <path\|id>` 恢复同一 session（两者均已核实存在：`docs/sessions.md:14`、`docs/usage.md:199`）。文档不写明，实施者可能尝试同进程换配置而失败。 | A4 补一句实施路径：阶段 2 = 改 `PI_CODING_AGENT_DIR` 配置 + `pi --mode rpc --session <file>` 重启续跑 |
| SUGGESTION | §8.3 A2 vs §11.4 | P0-14 / P1-5 | **kebab-case 通过标准与「不做硬转换」的张力**：A2 断言「英文标题为小写 kebab-case」，但 §11.4 明确 cleanTitle 不做空格→kebab 硬转换——通过与否完全押在模型遵从率上，验收可能 flaky 且失败时的裁决（微调 prompt？算 fail？）未定义。 | A2 给 kebab-case 断言标注「模型遵从依赖」，并写明失败时的处置路径（按 §11.4 走 prompt 微调重跑，而非无限重试） |
| SUGGESTION | §9 M3 / §10 U3 | P0-12 连带遗漏 | **遗漏 `.changeset`**：项目发布规范（AGENTS.md「发布与 CI」）要求 PR 内写 `.changeset/<slug>.md`（行为变更 + body 进 CHANGELOG）。U3 只列了 README 更新。extension 有 CHANGELOG.md 且这是行为级变更。 | U3 交付物补 changeset |
| SUGGESTION | §1 / §7.2 | P1-8 细节事实 | (1) §1「代码分三个文件」——实际四个（`commands.ts` 的 /auto-rename 命令未提，虽不改动）。(2) §7.2 只提删 LTC3 断言，但删 `buildMessages` 会使 `llm.test.ts:29-67` 整个 describe（LTC1/LTC2/LTC3）失效；`index.test.ts` 的触发判定相关用例同样受 D6 改造影响，文档只笼统提「集成测试改造」。(3) `extractUserPromptText` 返回 `string | null`，null 时 callRenameLLM 行为（跳过？只发 finalText+instruction？）未定义。 | 补全文件清单、测试销毁范围、null 路径裁决 |
| SUGGESTION | §6 D3 | P1-8 | 4000 码点截断「约 1-2k token」对中文偏乐观（中文 1 字≈1 token，4000 字≈4k token），总量估算「≤约 5k token」相应偏低。不影响方向性结论（任何现代模型窗口都远超）。 | 修正估算或删掉具体数字 |

## 专项判定（任务点名要求）

### 1. §8 证据链能否证明「turn 结束后才调用 LLM」与「LLM 收到了两段文本」

**判定：能证明，但需按下述修正；文档现有论证有 3 处弱点（对应 SUGGESTION #3）。**

- 「turn 结束后才调用」：JSONL 行序证明的是 rename **完成**时序，不是调用**发起**时序，单靠行序存在绕得过的反例（中途发起、turn_end 后完成）。真正闭合证据链的是内容断言：中途（iteration-k）触发时注入的 assistant 文本 ≠ 该轮最后一条 assistant message 文本 →「finalTextLen>0 且与 JSONL 最后 assistant message 文本一致」（A1③）不可满足 → 证伪。此判别**在修正 turn 语义后成立**（前提：实现真的只在 turn_end handler 里构造输入——D9 同对象日志可以佐证）。
- 「LLM 收到了 user prompt + final text」：D9「日志内省传给 callLLM 的同一对象」作为**实现承诺**成立（日志语句序列化传入 callLLM 的同一 messages 变量，代码评审可查），加「不含 toolResult 片段」的负向断言后证据充分。弱点仅在于 200 字符截断 vs「首尾片段」断言的内部矛盾。
- 加固手段（可证明的替代/增强）：日志行加时间戳 + turnIndex；harness 交错捕获 stdout（RPC 事件流到达序）与 stderr（扩展日志到达序），用两条流的墙钟交错直接证明「最终 assistant 事件先于 LLM request 日志」。

### 2. D6「成功-turn 计数」在 error-turn 前提两种实测结果下是否无害

**判定：无害，且比文档声称的还多修一个问题——但前提的「两种结果」表述本身被错误 turn 模型污染。**

- 前提为真（error 轮 append `stopReason:'error'` assistant entry）：**已用真实数据证实为真**（实测 60 个近期 session 中 36 条 `stop=error` assistant entry 落库）。新计数不数 error → error 轮不触发、下一成功轮 stop 计数=1 触发。✅ 符合 C3 修复意图。
- 前提为假（error 不落库）：新函数与 `countAssistantReplies` 行为一致，改造无差。✅ 无害。
- 附带收益（文档未自知）：在正确语义下，现状 `countAssistantReplies===1` 对工具型首轮会在**首个 iteration 的 turn_end 中途触发**（上文 MUST_FIX #1 证据③），新 stop 计数把触发点修正到轮末最终消息——D6 顺带修掉了这个更常见的现状缺陷，文档应把它列为被修复的失败模式而非只谈 error 轮。

### 3. D1-D9 方案对比充分性与被否理由（含 kvcache 论证）

- **kvcache 不成立的论证：成立**。已核实现状代码 `llm.ts:79`（resolveModel 独立选模）与 `llm.ts:93`（75 字符精简 systemPrompt）——rename 请求与主对话在 system 段第一个字节就分叉，且模型大概率不同，prefix cache 物理不可命中；`llm.ts:42` 的「字节级一致命中 kvcache」注释确属虚假前提。
- D5「比较新旧名字不可行」：成立（`session-manager.js:833-844` 的 session_info entry 无来源标记字段）。
- D6「被否 turnIndex===0」：成立（`agent-session.js:428-431`，agent_start 时 `_turnIndex` 重置为 0，resume 后首个 turn_end 也是 0，会误触发）。
- D7 timeoutMs：成立（`llm-shared/call.ts:37,124` 已支持透传）。
- D2/D4/D8/D9 的对比与裁决无事实性问题（D2 的论证基础错误见 MUST_FIX #1，但「直接用 event.message」的结论在 fast path 配合下仍对）。

## 通过项（抽查）

- P0-1 五段骨架齐全；P0-2 无 delta 链（附录变更史合规）；P0-3 各章结论先行 + SCQA。
- P0-13/14/15 验收：5 个真实场景 + 真实 pi 进程 + 真实模型 + 真实 session 文件断言，每场景回溯 G1-G4，具体业务例子充分，改动规模（大改动）与验收投入匹配。测试模型 mimo-v2.5-pro 与项目测试规范一致；「不在 xyz-agent 桌面端验证」符合 AGENTS.md「pi extension 测试优先本地 pi 实测」约定。
- P0-17 §4 有物理数据流；P0-18 §5.2 失败表带恢复指引；P0-16 其余✅/⛔标记（D5/D6/D7、C3 前提）除 MUST_FIX #1 涉及项外均核实属实。
- E2E 基础设施事实核：`--mode rpc`/`--session-dir`/`--extension`/`--approve`/`--session`（`docs/usage.md:173,199,201,220,243`）、`PI_CODING_AGENT_DIR`（`dist/config.js:396,412`）、RPC `set_session_name`（`docs/rpc.md:772`）全部存在。
