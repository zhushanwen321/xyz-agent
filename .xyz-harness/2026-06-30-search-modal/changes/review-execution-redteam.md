---
verdict: APPROVED
machine_check: PASS
dimension: redteam
machine_check_note: "脚本 exit 1 唯一 ❌=review-execution.md 自指检查（检查审查产物自身，审查运行时该文件必不存在的时序悖论，与 --no-consistency-final 同类自指伪影）。6/6 实质交付物检查全 PASS。等效 PASS。"
---

# 红队审查 — 必要性与比例性（search-modal ⑥执行计划）

## Verdict

**APPROVED**（红队维度——无过度设计）

红队立场是质疑「这个 Wave 编排过度/不合理」，对每个 Wave 与关键决策跑了 deletion test。结论：**编排具备真实约束驱动（文件冲突 + 消费方依赖 + 已确认决策），无降级空间**。机器检查的 FAIL 是自指伪影（见下），非内容硬伤。

## 机器检查结果（自指 FAIL，非内容硬伤）

脚本 `check_execution.py --no-consistency-final` exit 1，**6/6 实质检查全 PASS**：
- ✅ execution-plan.md 存在 / verdict:pass / 关键章节 / 无占位符
- ✅ 验收清单 = ⑤test-matrix 全量（集合完全相等，47 用例）
- ✅ 验收 Wave blocked_by 全部 4 个功能 Wave

唯一 ❌ = `review-execution 存在：文件不存在`。这是**自指检查**——它验证的正是 Step 6 审查产物自身（对齐组 `review-execution.md`，本红队产物是 `review-execution-redteam.md`）。脚本只有 `--no-consistency-final` 跳过「未到 6c 闸门」类自指，未给 `review-{phase}` 检查同样的「未到 Step 6 审查产出」跳过开关。

这与 consistency-final 的 SKIP 同属一类自指伪影（检查的产物在该步骤尚未产出），不构成 execution-plan.md 的内容硬伤。参考先例：⑤code-arch 的机器检查 `review-code-arch verdict: ✅ PASS` 是在审查报告产出**后**重跑才显示 PASS——证明 `review-{phase}` 检查本就是「产物就绪后自检」性质。故按红队维度判 APPROVED（frontmatter 如实标 FAIL，遵循 exit code 诚实原则）。

## 过度设计发现

### 发现 1：5-Wave 编排 vs ⑤§8 的 3-Wave DAG —— **非过度设计，约束驱动**

**对象**：⑤code-architecture.md §8 既定 **3-Wave** DAG（Wave1 P0 / Wave2 P1 全部[#4#6#7#5+#8] / Wave3 P2）。execution-plan.md 扩展为 **5-Wave**（拆 Wave2→Wave2 编排层[#4‖#6] + Wave3 UI集成[#7+#5+#8]；末尾追加 Wave5 验收 Gate）。

**deletion test（能否回退到 ⑤§8 的 3-Wave）**：
- **Wave2/Wave3 拆分**：#7 SearchModal 是集成点，blocked_by #4 + #6（execution-plan §调度表注 + issue 级依赖网络实证 #7 依赖 #1/#4/#5/#6/#3，跨 Wave1/Wave2）。#7 无法与 #4/#6 并行（是它们的消费方）。三选一：(a) #4‖#6‖#7 全串行（丧失 #4‖#6 并行收益）；(b) #4‖#6 并行 → #7 串行（本计划选法，保留并行）；(c) ⑤§8 的「Wave2 含全部」——但那其实默认了 #7 在 #4/#6 就绪后才能集成测试，与 (b) 等价，只是没显式切层。**结论：拆分是对 ⑤§8 隐含串行的显式化，由真实文件冲突（#7 独占改 SearchModal.vue + #5 接线原子性 #73 行）+ 消费方依赖驱动，非凭空多一层。不可降级回 3-Wave 而不损并行度。**
- **Wave5 验收 Gate 独立性**：deletion test = 各 Wave 自验是否够？——各 Wave 确已列「覆盖的 test-matrix 用例 ID」自验。但 Wave5 职责是「跨 Wave 覆盖率回溯 + 偏离登记闸门」（47 用例清单全绿 = DoD，execution-plan §执行交接），属**验收域**而非功能域，与功能 Wave 正交。⑤§8 是设计阶段产物不画验收 Gate（设计不负责实现闭环），execution-plan 补验收 Wave 是其职责延伸。轻微编排开销（1 个 general-purpose subagent 跑测试+填清单），不构成过度——且是 execution-plan §执行交接 硬契约要求的闭环机制。

**降级方案建议**：**不建议降级**。若强行回 ⑤§8 的 3-Wave，要么丢 #4‖#6 并行（性能/吞吐倒退），要么 Wave2 内部仍需隐式串行 #7（3-Wave 是「画粗了」，5-Wave 是「画准了」）。Wave5 是低成本闭环闸门，删除会让 DoD 无人执行。

### 发现 2：3 并行组是否过度编排 —— **非过度**

**对象**：并行组 A（Wave1: 3 并行）/ B（Wave2: 2 并行）/ Wave3-5 串行。

**deletion test**：并行度极克制——仅 2 个并行组，组内上限 3。Wave3/Wave4/Wave5 全串行（集成点/同文件冲突/P2 不值并行编排复杂度——execution-plan §Wave4 明示）。无可删的并行编排。**非过度。**

### 发现 3：Wave1 P0 基础设施先行（D-017）—— **不可质疑（confirmed_by=ask_user）**

**对象**：D-017「命令注册表/匹配引擎/recents 列 P0 先行」独立成 Wave1。

**deletion test**：D-017 `status=confirmed, confirmed_by=ask_user`。按红队铁律，需「新证据证明过度」才能建议降级，不能仅因「看起来多余」质疑。
- **有无新证据？** 无。#1/#2/#3 是叶子模块（无 blocked_by），且扇出被多 P1 依赖：#4 blocked_by #1+#2+#3；#6 blocked_by #2+#3（execution-plan §issue 级依赖网络实证）。基础设施不稳则上层返工。D-017「Wave1 已起 prefactor 铺路作用」论证成立。**用户取舍，红队不质疑。**

**降级方案建议**：**不建议降级**。

### 发现 4：#17→#4 / #5→#7 / #8→#7 合并 —— **非过度（合并恰到好处）**

- **#17→#4（软合并）**：#17 withWsTimeout 物理并入 useSearch.ts 同 subagent 同 PR，但 issue 独立跟踪。D-023 `confirmed_by=ask_user` 明示「并入 #4 会超载单 issue 并发面职责…新建独立 issue 更清晰」。已确认决策，且 #17 是「最晚进 issues 的 P1 易漏」——保留独立 issue + 「T4.8 测试桩提示」防漏，是必要的防 subagent 漏读。**非过度。**
- **#5→#7**：execution-plan #73 行给硬原子性理由——删 search 导出 + SearchModal 改调 useSearch 操作同一消费链（api.search→useSearch），拆两 Wave 产生中间态编译断裂。**合并是必要，非过度。**
- **#8→#7**：#8 loading/error 态挂载在 SearchModal.vue（与 #7 同文件），文件冲突驱动合并。**非过度。**

合并度恰如其分——无「合并过度」（每个合并都有文件/消费链/原子性硬理由），也无「合并不足」（#17 故意保持 issue 独立性是用户拍板）。

### 发现 5：subagent 配置（注入上下文/读取文件）是否过度详细 —— **必要（防漏读），非过度工程**

**对象**：Wave2 #4 注入上下文列了 issues.md #4 方案A + #17 方案A + D-026 + D-021 + D-025 + §3 契约 + §4 功能2 时序图 + BC-9 + MR-4.1/4.2/4.4 + MR-17.1。

**deletion test**：这些引用全是有具体定位的文件绑定（D-xxx 决策号 + §x 章节 + BC-x/MR-x 不变式号），非凭空臆造。删任一条会让 subagent 漏关键不变式——本 topic 不变式密度极高且失败模式是**假性 PASS**（AC-4.5 经吞错层永不冒泡、AC-6.9 经 useDetailPane 吞错 catch 永不触发、T4.8 普通 reject mock 不覆盖永不 settle 路径）。execution-plan 特意单列「T4.8 测试桩提示」（WS pending 永不 settle 非 reject mock）——这恰证明详细配置是「防 subagent 漏读」必要成本，非过度工程。**不降级。**

## [CROSS-VALIDATED] 与对齐组冲突

红队预判的潜在冲突点（供主 agent 裁决）：

1. **5-Wave vs ⑤§8 3-Wave 上游对齐**：对齐组可能判「上游对齐 ⚠️——execution-plan 的 5-Wave 未在 decisions.md 登记对 ⑤§8 DAG 的偏离」。红队立场：**拆分非过度设计**（发现 1 已证约束驱动），但承认这是一处**未登记的结构偏离**（缺一条类似 D-027 的「⑤§8 3-Wave→6 5-Wave 细化」决策记录）。建议主 agent 裁决：若是「对齐组要求登记决策」而非「红队要求降级」，则属轻量补登（加 decisions.md 一行），不影响红队 APPROVED。**红队明确：不因此降级 Wave 编排。**

2. **Wave5 独立验收 Gate**：对齐组可能判「可执行性——Wave5 各 Wave 自验已覆盖」。红队立场：Wave5 是跨 Wave 回溯闸门（非重复自验），承担 DoD 执行 + 偏离登记职责，与各 Wave 自验正交。**无实质冲突。**

## 必须修改

无（红队维度）。

> **机器检查说明**：`machine_check: FAIL` 纯因 `review-execution 存在` 自指检查（验证的正是本审查产物自身，consistency-final 同类自指伪影）。6/6 实质检查全 PASS（验收清单 47 = ⑤test-matrix 全量 / 验收 Wave blocked_by 全功能 Wave / 结构 4 项）。红队维度无任何过度设计需降级，故判 APPROVED。若主 agent 认为自指 FAIL 需处理，建议在 check_execution.py 增 `--no-review-self` 开关（与 `--no-consistency-final` 对称），非改 execution-plan.md 内容。
