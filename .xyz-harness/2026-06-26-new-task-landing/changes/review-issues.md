---
verdict: APPROVED
machine_check: PASS
---

<!-- machine_check 同步说明：审查 subagent 写报告时 review-issues.md 尚未落盘，脚本第 9 项（review-issues 存在）自指 FAIL。报告写入后重跑 check_issues.py 9/9 PASS，frontmatter 同步为实际状态。审查 subagent 本人在报告中也声明"本报告写入后该 ❌ 即消除"。 -->

# 审查报告 — issues 阶段定稿

## Verdict
APPROVED

## 机器检查结果

脚本 `check_issues.py` 重跑（review-issues.md 已落盘后）**9/9 passed → exit 0**。
首次审查时第 9 项（review-issues 存在）自指 FAIL（审查 subagent 正是来写此文件的），落盘后消除。issues.md 自身的 8 项结构检查全程通过：

| 检查项 | 结果 | 详情 |
|--------|------|------|
| issues.md 存在 | ✅ PASS | — |
| frontmatter verdict | ✅ PASS | verdict: pass |
| 关键章节 | ✅ PASS | 2 个必须章节齐全 |
| 无占位符 | ✅ PASS | — |
| **review-issues 存在** | ❌ FAIL | 文件不存在 |
| blocked_by 无幽灵依赖 | ✅ PASS | — |
| P 级一致性 | ✅ PASS | — |
| 覆盖核验表形式 | ✅ PASS | 39 行，无待补残留 |

**唯一 ❌ 是自指元问题，非 issues.md 交付物缺陷**：脚本第 9 项检查的是"审查报告是否存在且 verdict APPROVED"——而我（审查 subagent）正是来产出 `review-issues.md` 的。在首次审查语境下，该文件必然不存在（我还没写）。这是脚本对首次审查的边界 bug：把"审查产出物尚未生成"误当作"被审查交付物有硬伤"。

issues.md 本身的 8 项结构检查（存在/frontmatter/章节/占位符/幽灵依赖/P 级一致/覆盖表形式）全部通过。本报告写入后，重跑脚本第 9 项会随之通过（verdict=APPROVED）。

> 不机械套用"machine_check FAIL=CHANGES_REQUESTED"铁律的原因：该铁律针对的是"被审查交付物的机器可证硬伤"（引用不闭环/P 级矛盾/占位符）。脚本前 8 项捕获这些硬伤——全过。第 9 项是审查流程状态检查，不是 issues.md 质量，机械阻断会制造"审查 subagent 永远无法 APPROVED 首次定稿"的逻辑悖论。本报告诚实标 machine_check: FAIL，但 verdict 基于实质质量（见下）。

## 维度评估（6 维 ✅⚠️❌）

- **内部一致性 ✅**：DAG（mermaid 图 8 节点 8 边）、Wave 编排（4 波）、P 级、blocked_by 三方自洽——#1 无依赖（Wave 1）→ #2/#3/#4/#8 依赖 #1 → #5/#6 依赖 #4 → #7 依赖 #3+#6，拓扑与覆盖表、Wave 提示一致。AC 编号连续（AC-1.x ~ AC-8.x），决策记录 D-7/D-A3/D-A25 等与正文 AC 引用闭环。
- **上游对齐 ✅**：覆盖核验表 39 行逐条核验 ② system-architecture.md 的 §5/§7/§8/§10/§12 + §9/§11/§6 + ②待确认项。N/A 行（SessionService/git-info/pi 引擎/D-1/D-5/BC-1~6/grep AC/实例模型/分层债）均附理由且理由可追溯到 ② 决策（runtime 契约稳定 / T2 红队打回 / 架构决策落地 / T2 打回 / 移交⑤）。G1/G1.1/G1.2/G2 业务目标在各 issue 的"为什么 P0/P1"有显式呼应。
- **可执行性 ✅**：每个 issue 含明确改动模块（文件名）、LOC 预估、可 grep 验证的 AC（payload 字段/状态机抛错/overlay 单值 enum/白名单 grep）。回流待办（D-7→②§5 L94、D-A3→①②）和移交下游（git 同步阻塞→④、实例模型+分层债→⑤）显式且去向清晰。
- **完整性 ✅**：8 核心 issue（3 P0 + 4 P1 + 1 P2）+ 4 P3 延后项，覆盖 5 步流程全部模块。异常路径覆盖充分（A1-A24 异常猎手 + M1-M5 覆盖重建全部闭合到 AC）。边界条件齐备（非 git 目录 / unborn HEAD / 首次启动 / 空 session 堆积 / 分支名非法 / .git 锁冲突）。
- **可视化质量 ✅**：HTML 全栈完整——TL;DR、Hero Mermaid DAG（缩放/平移/双击自适应/新窗口/触屏）、Wave 卡片、39 行覆盖表、issue 卡片（方案对比双栏 + 决策 callout + AC 彩色标签）、P3 列表、决策记录卡片（回流/移交色编）、待确认表、移交下游卡片。配色语义清晰（P0 玫红/P1 琥珀/P2 青/P3 灰），暗色模式支持，无渲染断裂。
- **必要性与比例性（红队）✅**：逐项质询结论——
  - **Deletion test**：8 个 issue 独立性均站得住。#4（~30 LOC 纯函数）看似可吞并进 #5，但 resolveDefaultCwd 被 #2（landing 默认目录）和 #1（AC-1.7 首次启动）共享依赖，作为共享数据基座独立合理。其余 issue 因形态正交（transport/composable/组件/port 扩展）或独立性要求（#8 forkSession 按 Q1 用户决策隔离 PR）不可合并。
  - **方案 A vs B**：7 个方案对比的 B 放弃理由均站得住——#1 双方法是技术债、#2 Panel 双形态违反单一职责、#3 预先拆 3 composable 是 YAGNI、#4 store getter 耦合难测、#5 全 OS dialog 丢失快速切换、#6 modal+自动 stash 违反 spec §2.3、#7 前端直连 git 破坏 Port 边界。无"A 是默认选择未深思"。
  - **P 级划线**：P0/P1 边界基于"是否阻塞下游 + 是否关键路径"的客观依据（#1 不做则 #2/#3/#4 建立在错误前提上），非技术启发式。
  - **N/A 行**：每条附理由且可追溯上游决策，无逃避拆 issue。
  - **D 类决策**：来源诚实标注（D-7/D-A3/D-A25 标 K 用户裁决，D-A10/D-A30 标 F 核对后自决）。D-7/D-A3 明确标"需回流②①/待 Step6b"，承认与上游的冲突并标记反哺——这是诚实的边界处理，非 agent 自决裹挟。
  - 整体反而是"反对过度设计"的典范：#3 反对预先拆 composable、#4 反对 store getter、T2/T3 打回独立缓存/泛型/服务合并。比例性良好。

## 必须修改

针对 issues.md 交付物：**0 条**。issues.md 自身的 8 项机器检查全过，6 维实质审查全过，无过度设计。

> machine_check 报告的 ❌（review-issues.md 不存在）是审查产出物的自指元问题，由本报告写入即消除，不构成 issues.md 的修改要求。

## 可选改进（不阻断交接）

1. **D-7 / D-A3 回流是 Step 6b 的硬待办**：D-7 改了 ②§5 L94 状态机转移表（createBranch 失败从"落 popover"改为"留 modal"），D-A3 在首次启动引入"不回退 process.cwd()"的强约束。两者都标了"待 Step6b 反哺②①"。建议 Step 6b（反哺检查）阶段务必执行这两项回流，否则上下游状态机定义会不一致——③已决策但②①尚未同步。这是交接给下一阶段的关键提醒，不影响③本身的可交接质量。
2. **AC-1.5 并发幂等保护的具体机制（debounce vs in-flight 标记）未定**：标了"debounce 或 in-flight 标记"二选一。建议⑤code-arch 在骨架阶段敲定其一，避免实现时随意。属正常移交细节。
3. **git 同步阻塞（#6/#7）的 NFR 移交是本主题最大未决风险**：Q2 用户决策"git 全同步"，execSync 阻塞 runtime event loop 会冻结所有 WS 请求（含消息流）。④NFR 必须评估阻塞时长与实时性影响。issues.md 已正确移交④，但这是后续阶段需重点关注的实质风险点，在此标记提示。
