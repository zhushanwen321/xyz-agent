---
verdict: APPROVED
reviewer: independent-issue-reviewer
date: 2026-06-24
---

# 独立 Issue 审查报告 — issues.md

## 审查输入

1. `issues.md`
2. `system-architecture.md`
3. `requirements.md`
4. `spec-w11.md`
5. `changes/tracing-round-7.md`

## Verdict

**APPROVED**

issues.md 与上游 requirements.md、spec-w11.md、system-architecture.md 保持一致，P0/P1 全部覆盖，方案对比充分，优先级与依赖关系一致，P2/P3 迷雾处理得当，验收标准可执行。发现的 3 项均为可记录的改进建议，不阻塞批准。

---

## 五维评分

### 1. Issue 完整性 — 9/10

- **覆盖度**：requirements.md F1-F12 12 项功能全部映射到 issue；system-architecture.md G1-G4 及搭便车目标均有对应条目。
- **遗漏扫描**：未发现未被 issue 覆盖的架构挑战或需求功能点。P3 延后项（#14-#17）与 waves.md D1-D10 边界一致。
- **扣分点**：#12（契约裂缝）与 #8（stores/chat 补全）在 `ToolCallStatus.pending` / `FileChangeStatus.unmerged` 上存在内容重叠，建议在两处 issue 正文中互相引用，避免执行时重复或遗漏。

### 2. 方案质量 — 9/10

- **P0/P1 方案对比**：#1-#11 全部含 ≥2 方案，取舍依据均来自系统性质（D-9 职责边界、contract.md 范式、v3 SSOT、C8 用户确认、D-7 session 隔离）而非「简单」。
- **长期/短期判断**：方案选择普遍偏向长期架构正确（如完整 IGitExecutor、按 contract.md 全量重写 domain），并用 ponytail 注释合理抑制了过早抽象（#8 不引入 reducer）。
- **扣分点**：#4 方案 A 的收益说明可更具体——「固定剧本足够覆盖所有 message.* 类型」应列出具体事件清单，方便执行时核对。

### 3. 优先级一致性 — 9/10

- **P0 阻塞性**：#1/#2 作为 P0，下游 #3/#5/#6/#7/#9 的 blocked_by 关系正确，且与 system-architecture.md 模块依赖一致。
- **P1 链路**：#9 已由 P2 提升为 P1，与 requirements.md G2.1 对齐；#11 依赖 #9 形成清晰 P1 链路。
- **P3 延后理由**：#13 UI 形态未决、#14-#17 为协议级/产品级延后，理由在 issues.md 与 requirements.md 中均有说明。
- **扣分点**：Wave 编排表出现 W1/W2/W3/W5 但缺失 W4，未说明原因。建议补一行注释或删除 W5 改为 W4，使 wave 编号连续。

### 4. 迷雾处理 — 9/10

- **P2/P3 标注**：#13 在 mermaid 图、标题、正文均明确标注为 `?` / 迷雾 / Speculative，未强行展开 UI 方案。
- **范围控制**：P3 延后项统一放在「后续迭代」章节，避免混入 P1/P2。
- **扣分点**：#13 既列入 Wave W5，又被描述为「UI 形态未完全确定」。建议将 #13 从 Wave 表移至「待确认/后续迭代」或加注「W5 仅预留，需 UI 形态确认后方可排期」，减少执行歧义。

### 5. 可执行性 — 9/10

- **验收标准**：每项 issue 均有可 grep/可测试的 AC，如 `grep -rn "GitZone"`、`grep -rn "case 'message.thinking_end'"`、`vue-tsc 0 错` 等。
- **Wave 编排**：P0 集中在 W1，P1 分布在 W1-W3，符合串行执行、先地基后 UI 的顺序。
- **扣分点**：
  1. #13 无验收标准（因迷雾），但 Wave 表仍占位，建议明确其 AC 为「确认 UI 形态后补方案」。
  2. #8 与 #12 在枚举补全上的协作关系未在 AC 中体现，建议 #8 增加一条「依赖 #12 的 protocol.ts 变更」或反过来 #12 增加「为 #8 提供类型基础」。

---

## 发现的问题（3 项，均不阻塞）

### P1 — 内容重叠未交叉引用

**位置**：#8 与 #12

**问题**：#8 要补 `ToolCallStatus.pending`、`FileChangeStatus.unmerged` 的 store 消费；#12 要补同样的 protocol.ts 类型定义。两者独立成 issue，但未互相引用，执行时可能出现在 #8 里又改一遍枚举或在 #12 里漏掉 #8 需要的字段。

**修复建议**：
- 在 #8 正文中增加一行：「依赖 #12 完成 protocol.ts 枚举补全；如 #12 未先完成，#8 可临时用字符串字面量占位，最终需回扫替换。」
- 在 #12 正文中增加一行：「本项为 #8/#10 提供类型基础，字段类型需与 #8 验收标准中 'ToolCallStatus 含 pending / FileChangeStatus 含 unmerged' 对齐。」

### P2 — Wave 编号不连续

**位置**：依赖关系汇总表末尾

**问题**：Wave 列出现 W1/W2/W3/W5，缺少 W4，容易让执行者误以为计划被截断或遗漏。

**修复建议**：将 #13 的 Wave 从 W5 改为 W4，或在表下加注释「W4 为预留缓冲/验收波次，本轮不排具体 issue」。

### P3 — 迷雾项不应占具体 Wave

**位置**：#13

**问题**：#13 标记为迷雾（UI 形态未决），却又列入 Wave W5，形成「未确定却排期」的微小矛盾。

**修复建议**：将 #13 从 Wave 表移出，改为「后续迭代 / 待确认」；或在 #13 正文中明确「W5 为占位，实际进入需先确认 UI 形态」。

---

## 改进建议

1. **交叉引用**：在 issue 间增加 1-2 行依赖说明，特别是 #8↔#12、#4↔#3、#1↔#3 这类「数据生产-消费」对。
2. **AC 细化**：#4 方案 A 的收益说明追加固定剧本覆盖的事件清单；#13 补充「UI 形态确认」作为可验收的退出条件。
3. **Wave 表连续性**：统一 wave 编号，避免跳号，并为迷雾/延后项单独分区。

---

## 总体结论

issues.md 已达到可进入下一步（代码架构 / Wave 执行）的质量标准。上述问题均为文档层面的 refinements，不影响 issue 决策图的完整性与一致性。
