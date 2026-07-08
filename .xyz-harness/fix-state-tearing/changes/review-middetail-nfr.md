# NFR 副作用 + 回灌指针审查报告

> 审查对象：`non-functional-design.md`（fix-state-tearing）
> 审查视角：7 维度覆盖 / 副作用真实性 / 回灌指针 / 需骨架验证项 / 决策账本对齐
> 交叉核对源：`issues.md` / `system-architecture.md` / `code-architecture.md`

## Verdict

**conditional_pass** — NFR 自身的 7 维度分析质量高（副作用具体、有源码/决策/约束引用，缓解可落地，无泛泛而谈；D-001~D-010 全部尊重，无冲突）。但**回灌指针核对发现 2 处 must_fix**：NFR 明确的缓解决策未被 code-arch 忠实消费（M22 测试用例丢失、tool_call_end sealed 边界被 §5 反向实现）。需在 code-arch 侧修补 + NFR 统计订正后方可放行进入 execution。

**正面结论（无需改动）**：
- **7 维度覆盖完整**：8 issue × 7 维度 = 56 子节齐全，无「—」跳过。matrix 表 56 格与逐节详情完全一致（逐格比对通过）。refactor 模式下安全维度全 ✅ 合理（不引入新外部边界，system-arch §6 已确认无新 Port）。无任何维度被不当标 ✅ —— 每个一行理由都给出了正交化/委托/类型层零开销等具体依据。
- **副作用真实性**：22 个 ⚠️ 子节全部具体（引用源码行号 useChat:117/Composer:320/dispatcher:89-92/102/150/164、决策编号 D-003/D-008/D-010、架构约束 #3/#4、effects [HISTORICAL] 注释），缓解措施均有明确落点（文件+符号+测试 ID）。无一条泛泛而谈。
- **决策账本对齐**：D-001(B 策略)/D-003(timer 24h)/D-005(computed scan)/D-007(假收口改真收口)/D-008(abort 终态 complete)/D-009(runtime 预检)/D-010(sealed) 全部在相应缓解中保持，无一处推翻。#9 P3 延后项正确登记在残余风险表（不进 7 维矩阵）。

## must_fix

### MF-1: M22（timer 24h 触发 warn 日志）回灌指针断裂 — 代码测试缓解项在 code-arch §6 来源 B 无对应用例

**证据**：
- NFR 回灌表 M22（`non-functional-design.md:337`）：可观测性 / 回灌去向「⑤代码」/ 验收方式「代码测试」/ 占位 ID `NFR-T-LOG-TIMEOUT` / 状态「待落」。
- NFR 统计括号清单（`:328`）列入 M22 属 ⑤代码。
- code-arch §6 来源 B（`code-architecture.md:448-466`）T9.1~T9.17 引用的缓解项 = {M2,M3,M4,M5,M7,M8,M9,M11,M13,M14,M15,M16,M17,M18,M19,M20,M21}，**无 M22**。
- `comm -23` diff 确认：NFR 标代码测试的 18 项中，唯一缺失来源 B 对应的就是 M22。

**影响**：#8 可观测性 ⚠️ 的缓解（timer callback `logger.warn` 落盘）在 execution 期无测试覆盖。timer 24h 触发是 pi 静默卡死的极端归因证据（架构约束 #4），日志缺失会让事后排查无据。

**修复**：code-arch §6 来源 B 补一条 `T9.18 | M22 | unit | timer callback 触发 finalizeSession('timeout') 时 logger.warn 调用 | #8 | chat-store`。

### MF-2: tool_call_end sealed 边界 — NFR 明确决策被 code-arch §5 反向实现，且 code-arch 自相矛盾

**证据**：
- NFR 三处一致声明「tool_call_end 不 sealed」：
  - `:130` #3 数据完整性缓解：「sealed guard **仅对 delta 流类**生效…**tool_call_end 不 sealed**（允许覆盖 end_not_received → completed）」
  - `:320` M8：「sealed guard **仅对 delta 流类**生效，tool_call_end 允许覆盖」
  - `:364` SV-2：「对 tool_call_end 不生效（允许覆盖 end_not_received → completed）」
  - `:131` 明确警告边界判错后果：「误把 tool_call_end 也 sealed 会导致工具结果丢失」
- code-arch §5 反向实现：
  - `:341`：「streaming 类事件（…tool_call_end…）必须**幂等丢弃**」
  - `:369`：「覆盖的 handler（**全部加 guard**）：…`message.tool_call_end`…」
- code-arch §6 T9.5（`:466`）却又与 NFR 一致：「tool_call_end 允许覆盖 end_not_received→completed」→ **code-arch §5 与 §6 T9.5 内部自相矛盾**。

**影响**：NFR #3 数据完整性的核心副作用防护被架空。若按 §5 实现，finalizeSession 后迟到的真实 `tool_call_end` 被 guard 丢弃 → toolCall 永久卡 `end_not_received` → 真实工具 output 丢失。这正是 NFR `:131` 与残余风险表（`:352`）点名的高严重度失败模式。

**修复**：code-arch §5 的 sealed handler 列表（`:341` 与 `:369`）须将 `message.tool_call_end` 移出「全部加 guard」，明确 tool_call_end 走覆盖路径（end_not_received → completed）。骨架 effects-skeleton 的 sealed guard 须只覆盖 delta 流类，tool_call_end 单独走覆盖分支（SV-2 stub 的「tool_call_end 覆盖路径 stub」须真实存在）。

## should_fix

### SF-1: 回灌去向统计三份数字互相矛盾

**证据**（`non-functional-design.md:328-330`）：
- 声称「⑤代码（test-matrix 来源 B）：**14 条**」
- 同行括号清单实际列了 **17 个** M 项（M2/M3/M4/M5/M7/M9/M11/M13/M14/M15/M16/M17/M18/M19/M20/M21/M22）
- 按「验收方式=代码测试」grep 统计，实际为 **18 条**（括号清单还漏列了 M8 —— M8 行 `:320` 验收方式是「代码测试」且 code-arch 来源 B 有 T9.5 对应）
- code-arch 来源 B 实际 17 条（含 M8、不含 M22）

**影响**：自检章节声称「回灌表完整…其中 14 条标代码测试供 code-arch 引用」与实际不符，误导下游对回灌完整性的判断。MF-1 的 M22 丢失未被自检捕获，部分原因即统计失真。

**修复**：将统计订正为「⑤代码 18 条（M2/M3/M4/M5/M7/M8/M9/M11/M13/M14/M15/M16/M17/M18/M19/M20/M21/M22）」，并同步修正自检章节「14 条」表述。订正后 MF-1 的缺口会自然暴露。

### SF-2: SV-4 的 catch 路由 open question 未在 code-arch 决断，且无骨架覆盖

**证据**：
- NFR SV-4（`:374`）明确留了 open question：「catch 路由可能需保守处理：所有 prompt 失败都走 send.rejected？还是仅 busy？…**待 code-arch 决定 catch 分类策略**」，stub 要求「sendPrompt 入口检查 stub + **catch 路由 stub**」。
- code-arch §7 骨架覆盖核验表（`:524`）：`dispatcher.sendPrompt 预检 | （骨架未单列…）| N/A` —— dispatcher 无骨架，catch 路由 stub 不存在。
- code-arch §2 模块 F（sendPrompt 签名）只规定预检 return `{blocked, rejected}`，**未规定 catch 分类策略**（pi 拒绝 vs 其他 prompt 错误如何分流）。
- code-arch §6 T9.8（M13）测试「pi 拒绝 catch 路径走 send.rejected」—— 隐含了决策，但决策本身未在 §2/§5 显式陈述，也无骨架验签。

**影响**：SV-4 自认的未决项在 code-arch 只被测试用例隐式覆盖，缺乏签名级契约。实现期遇非 busy 的 prompt 失败（如 pi 抛非 already_processing 错误）时，路由去向（send.rejected vs message.error）无依据，可能实现出与 T9.8 假设不一致的行为。

**修复**：code-arch §2 模块 F 补 catch 分类契约（建议：busy 语义 → send.rejected；其他 prompt 错误保持现行 message.error —— 与 NFR #4 并发缓解「pi 拒绝走 send.rejected 非 message.error」一致，且不扩大 send.rejected 语义）。或在 NFR SV-4 明确缩小范围：「本 topic 仅决 pi 拒绝→send.rejected，其他 prompt 错误维持现行」以关闭 open question。

## nit

### N-1: SV-2「预期结论方向」可加一句指针提示
SV-2（`:365`）「边界判定需在 handler 入口区分事件类型（delta vs end）」结论正确，但未显式提示该区分在 code-arch §5 的 handler 列表里如何落地。结合 MF-2，建议 SV-2 补一句「此边界须在 code-arch §5 sealed handler 列表中体现为 tool_call_end 不入 guard 列」，让回灌核对方向更显式。（MF-2 修复后此条自动消解。）

### N-2: 残余风险表「#9 abort 复活 steer」监控方式为「—」
`:355` 残余风险表 #9 行「监控方式」填「—（P3 独立 ticket）」。该条接受理由充分（BC-6 依赖 pi RPC clear_queue 扩展），但监控方式留空可填「无（超出本 topic，靠 P3 ticket 跟踪）」更显式，与其他三行格式一致。非阻塞。

---

## 附：核对方法说明

- **7 维度覆盖**：逐 issue 逐维度比对 matrix 表（`:54-63`）与详情节（`:65-275`），56 格全一致；无 ❌、无「—」跳过。
- **副作用真实性**：22 个 ⚠️ 子节逐条核查「副作用/缓解/残余」三段式，均含具体引用（源码/决策/约束），缓解均可映射到回灌表 M# 或 SV#。
- **回灌指针**：grep NFR 表所有「代码测试」缓解项（18 个）与 code-arch §6 来源 B 引用 M#（17 个）做 `comm` diff → 唯一差集 M22（MF-1）。反向核对 code-arch 来源 B 的 M# 全部存在于 NFR 表（无幽灵指针）。
- **需骨架验证项**：SV-1~SV-5 逐项核对 code-arch §7 骨架文件清单 + §7 覆盖核验表 → SV-1/SV-3/SV-5 覆盖；SV-2 矛盾（MF-2）；SV-2 tool_call_end 覆盖路径 stub + SV-4 catch 路由 stub 缺失（MF-2/SF-2）。
- **决策账本**：D-001/D-003/D-005/D-007/D-008/D-009/D-010 在对应缓解中逐条核对，无冲突。
