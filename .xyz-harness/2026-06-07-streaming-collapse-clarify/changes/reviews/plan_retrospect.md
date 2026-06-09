---
phase: plan
verdict: pass
---

# Plan Retrospect — streaming-collapse-clarify

## Phase 执行质量

### 做得好的

1. **复杂度评估准确** — 快速判定 L1（纯前端，无跨服务/DB），避免了不必要的 L2 子文档拆分，plan 保持单文件
2. **接口验证前置** — 在写 plan 前用 grep 验证了 ToolCallCard 和 ThinkingBlock 的 defineProps 签名，plan 中引用的 props 类型与代码一致
3. **v1 review 的 MUST_FIX 修复精准** — review 发现 FR-5 chip 类型 overflow 遗漏后，一次性修复了 MUST_FIX + 2 个 LOW + 1 个 INFO，v2 直接通过

### 可改进的

1. **FR-5 遗漏本应在 self-review 阶段发现** — spec FR-5 明确列出两种 overflow（item >8 + chip >4），plan 初版只覆盖了第一种。self-review 扫描 spec 每条 FR 时不够细致，依赖 review subagent 发现
2. **Task 2 虚假依赖** — Task 2 声明 depends on Task 1，但两者修改不同文件。v1 review 指出后改为"可并行但建议串行"，初始规划时就应该识别无依赖

### 关键数字

| 指标 | 值 |
|------|---|
| Task 数量 | 3 |
| Review 轮次 | 2（v1: must_fix=1, v2: pass） |
| MUST_FIX 修复 | 1（FR-5 chip 类型 overflow） |
| ADR 产出 | 0（无决策满足三条件） |

## Harness 体验

### 流畅的

1. **Spec Coverage Matrix** — 强制追踪 spec AC → interface → task 的覆盖关系，帮助发现了 FR-5 的半覆盖问题（虽然是在 review 阶段而非 self-review）
2. **review subagent 的 MUST_FIX 机制** — review 发现具体问题后，修复 → re-dispatch → pass 的闭环效率高

### 痛点

1. **交付物数量多** — plan.md + e2e-test-plan.md + test_cases_template.json + use-cases.md + non-functional-design.md，对于一个 2 文件修改的 L1 任务，文档 overhead 偏重。特别是 non-functional-design 中"不适用"占了一半维度
2. **Interface Contracts 对 L1 过重** — 强制要求 methods 表 + data 表 + AC 覆盖矩阵，但本任务的核心是修改 Vue 组件的渲染逻辑，没有传统意义上的"类方法"。最终写了组件 props/emit/emits 的签名表，勉强凑格式

### 建议改进

1. **L1 plan 交付物精简** — 允许将 e2e-test-plan + use-cases + non-functional-design 合并为 plan.md 的附录章节（单文件），减少文件数量。L2 保留独立文件
2. **Interface Contracts 适配前端组件** — 对纯前端 L1 plan，允许用"组件交互图 + props/emit 签名"替代 methods 表格式，更贴合 Vue 组件的设计表达
3. **Self-review checklist 增加 FR 逐条扫描** — 在 self-review 中强制要求"对 spec 每个 FR 的每个子项，标注 plan 中对应的 step 编号"，避免依赖 review subagent 发现遗漏
