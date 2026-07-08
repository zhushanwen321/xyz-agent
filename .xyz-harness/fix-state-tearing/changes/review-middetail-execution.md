---
verdict: fail
reviewer: 独立 reviewer（Wave 依赖 + 测试闭环）
upstream: execution-plan.md
scope: 组A 编排结构 + 组B 测试闭环
---

# Review — execution-plan.md（Wave 编排 + 测试闭环）

## Verdict

**fail** —— Wave 编排结构（DAG / P 级 / Prefactor 判断 / 文件影响）本身合理，但**测试验收清单存在 3 处数据错误**，破坏「验收清单 ID 集合 = §6 全量」与「按测试层分组准确」两条硬约束（wave-template 检查清单第 11、7 条）。均为局部订正可修复，无需重排 Wave。

**结构层面 PASS 项**（无 must_fix）：
- Wave 依赖 DAG 与 issues.md blocked_by 一致：W1 内部串行链（protocol #1 → chat #2#8 → effects #3 → dispatcher #4 → useConnection #6）尊重 #3←#2、#4←#1、#6←#2、#8←#2 全部依赖；W2 的 #5←#2#3、#7←#5 亦成立。
- P0（#1#2）全部落在 W1（首个功能 Wave），满足「P0 在 Wave 0-1」。
- P3 #9 标注延后理由（BC-6 + 依赖 pi clear_queue），清晰。
- 无 Prefactor Wave 的判断正确（refactor 但不挪文件，删符号同 Wave 原子完成）。
- Wave 覆盖列表并集 = §6 全量（T1.1-T1.4 / T2.1-T2.5 / T3.1-T3.3 / T4.1-T4.7 / T5.1 / T6.1-T6.3 / T7.1-T7.3 / T8.1-T8.2 / T9.1-T9.18），W1∩W2 无交集（覆盖层面无遗漏无重复）。
- 骨架→Wave 映射完整（4 骨架 + #4/#6/#7 实现期直改均有 Wave 归属）。

---

## must_fix

### M1. T9.18 在验收清单分层表遗漏（ID 集合 ≠ 全量）

- **证据**：W1 覆盖列表（execution-plan.md:77）含 `T9.18`；全量清单（:188）含 `T9.1-T9.18`；但验收清单 unit 层表（:171）写作 `T9.1~T9.8, T9.12, T9.13, T9.15~T9.17` —— **不含 T9.18**。
- **影响**：wave-template 第 11 条「验收清单用例 ID 集合 = §6 全量」fail。T9.18（M22，timer callback logger.warn 落盘）在 Wave 覆盖层有归属（W1），但验收清单分层表查不到 → 下游 coding-execute 按清单验收时会漏跑。
- **修复**：unit 层表该行补 T9.18（`T9.15~T9.18`）或单独列出一行。

### M2. T9.3 测试分层错误 + perf-chaos 层表遗漏

- **证据**：code-arch §6 来源 B（code-architecture.md）T9.3 测试层 = **perf-chaos**（parallelGroup `perf`，= T8.1 同断言）。但 execution-plan 验收清单把 T9.3 含在 unit 层表 `T9.1~T9.8`（:171），perf-chaos 层表（:184-185）只有 T8.1/T8.2，**无 T9.3**。
- **影响**：wave-template 第 7 条「按测试层分组准确」fail。T9.3 是性能用例（n=1000 scan < 1ms），错放 unit 层会导致下游按 unit mock 环境执行，无法验证性能断言。
- **修复**：T9.3 从 unit 层表移除，加入 perf-chaos 层表（归属 W1，dependsOn #2）。

### M3. T9.9 / T9.10 / T9.11 测试分层错误

- **证据**：code-arch §6 来源 B 三者测试层均 = **unit**（parallelGroup 分别 `chat-store`/`usechat`/`usechat`）。但 execution-plan 验收清单 integration 层表（:169）`T9.9~T9.11` 归 integration。
- **影响**：同 M2，分层不准确。这三条是 pendingSend 幂等 / isActive 派生路由 / editAndResend guard 的单测断言，错放 integration 层会改变执行环境（real vs mock）与 parallelGroup 分配。
- **修复**：T9.9/T9.10/T9.11 从 integration 层表移到 unit 层表（归属 W2，dependsOn #5）。

---

## should_fix

### S1. Wave 划分偏离 code-arch §8 建议，未说明理由

- **证据**：code-architecture.md §8 DAG 建议 `W1(#1#4, #2#3) → W2(#5, #6, #7, #8 随#2)`，即 #6 useConnection 与 #8 timer 归 W2。execution-plan.md 实际编排 `W1(#1#2#3#4#6#8) → W2(#5#7)`，把 #6#8 从 W2 提到 W1。
- **评估**：execution-plan 的划分本身自洽（#6#8 只依赖 #2，#2 在 W1 内部先行，串行链可保证顺序），按「契约+核心模型层 vs 编排+UI 层」分层也合理，甚至更紧凑。但与上游 §8 的「建议 Wave」不一致且未注明偏离理由，审查视角 1（从 §4/§8 推导的依赖是否准确）会触发疑问。
- **修复**：在「Wave 编排总览」补一句说明「#6#8 仅依赖 #2，随 #2 同属 W1 核心模型层，比 §8 建议更紧凑」；或回填 §8 同步划分。二者择一。

### S2. 末尾验收 Wave（Acceptance Gate）缺失

- **证据**：wave-template.md「末尾验收 Wave 模板（强制）」+ 检查清单第 12 条要求独立验收 Wave（blocked_by 所有功能 Wave）。execution-plan.md 只有「测试验收清单」章节 + 「交接」段落（DoD = 清单全绿），无独立 Wave。
- **评估**：mid tier 下 CW `test` action 实质承担验收 Wave 职责（跑全量 + judgeByExpected），故功能上未必缺失。但文档层面与 wave-template 结构不符，且当前交接措辞把验收责任全压给「下游 coding-execute」而非显式 Wave。
- **修复**：二选一 —— (a) 补一个 Wave 3 验收 Wave（读清单→跑测试→填 PASS/FAIL），或 (b) 在「交接」段显式注明「验收 Wave 职责由 CW test action 承担，不单独建 Wave」并给出对应 caseId 提交约定。

### S3. 时序图 1 的 alt 分支（api.send 失败回滚）无专门用例（上游 §6 遗留）

- **证据**：code-arch §4 时序图 1 有 alt「api.send 失败 → clearPendingSend + throw → Composer 恢复草稿 + toast」。code-arch §6 覆盖自检称「时序图 1 alt→T1.x catch」，但 UC-1 表（T1.1-T1.4）无 catch 用例，全树也无「send reject 回滚」单测。wave-template 第 9 条「每张时序图 alt/else → 落在某 Wave 覆盖里」因此悬空。
- **评估**：根因在 code-arch §6（用例枚举遗漏 alt 分支），非 execution-plan 自身能补（它不能无中生有创造 §6 没有的用例 ID）。但 execution-plan 的 Wave 覆盖因此继承了这个缺口。
- **修复**：回流 §6 补一条用例（如 T1.5 unit：send api.send reject → clearPendingSend + throw），再在 execution-plan W2 覆盖列表登记。若判定该分支由 T1.4 integration 隐式覆盖，需在 §6 显式标注 T1.4 含 catch 断言。

---

## nit

### N1. W1 串行链步骤 4 的依赖描述不准

- **证据**：execution-plan.md:96 `message-dispatcher + session-message-handler（#4）—— 依赖 #1 类型 + #2 runtime 侧 isGenerating 查询`。
- **问题**：#4（runtime message-dispatcher）的 isGenerating 查询来自 runtime 侧 `activeSession.isGenerating`（sessionService 维护，见 code-arch §2 模块 F + issues #4 方案 A），**不来自 #2（renderer chat.ts）**。#4 真实依赖只有 #1（send.rejected 类型契约）。issues.md #4 blocked_by 也仅列 #1。
- **影响**：不影响编排正确性（#4 排在 #2 之后仍满足其真实依赖 #1），仅描述误导——可能让实现者误以为 runtime 需等 renderer chat.ts 改完。
- **修复**：改为「依赖 #1 类型（runtime 侧 isGenerating 为现有 sessionService 能力，非 #2 引入）」。

---

## 闭环校验汇总

| wave-template 检查项 | 结果 | 证据 |
|---|---|---|
| 1. Wave 方法定义在更早 Wave | PASS | W1 串行链内序满足全部 blocked_by |
| 2. 同组 Wave 不改同文件 | PASS | 无并行 Wave（全串行），无冲突 |
| 3. P0 在 Wave 0-1 | PASS | #1#2 ∈ W1 |
| 4. P3 标延后理由 | PASS | #9 理由清晰 |
| 5. Prefactor 铺路 | N/A | 无 Prefactor（refactor 不挪文件，判断正确）|
| 6. 每 Wave 标覆盖用例 ID | PASS | W1/W2 均标 |
| 7. Wave 覆盖并集 = 全量 | PASS | T1-T9 全覆盖，无交集 |
| 8. 用例无重复归属（Wave 层）| PASS | W1∩W2 = ∅ |
| 9. 时序图 alt/else 有 Wave 覆盖 | **FAIL** | 时序图 1 alt 无用例（S3，上游 §6 遗留）|
| 10. 骨架叶子→Wave | PASS | 4 骨架 + 3 实现期直改均有归属 |
| 11. 验收清单 ID = 全量 | **FAIL** | T9.18 遗漏（M1）|
| 12. 末尾验收 Wave 存在 | **FAIL** | 缺失（S2，mid tier 可注明 CW test 替代）|
| 13. Wave 覆盖↔验收清单双向一致 | **FAIL** | T9.3/T9.9-11 分层错位（M2/M3）致归属失配 |
| 14. 交接硬契约 DoD | PASS | 「DoD = 测试验收清单全绿」为硬契约 |

**结论**：FAIL 项集中在测试验收清单的数据订正（M1/M2/M3）+ 结构可选项（S2）。Wave 编排 DAG 本身无需重排。修复 M1-M3 + 回应 S1-S3 后可重审转 pass。
