---
phase: pr
verdict: pass
---

# Overall Retrospect — streaming-collapse-clarify

覆盖全部 5 个 Phase 的整体复盘。

## Phase 5 (PR) 执行质量

### 做得好的

1. **CI 修复效率高** — 3 轮 CI 修复，每轮针对具体错误（typecheck path alias → test mock → test mock），无盲目重试
2. **附带修复了分支预存问题** — ChatOutline、ExtensionsPane、extension-resolver、ChatInput-subagent 的 4 个预存错误一并修复，让分支整体 CI 变绿

### 可改进的

1. **预存 CI 错误应更早发现** — 分支中已有 ChatOutline、ExtensionsPane、extension-resolver 等文件的 typecheck/test 错误，但 Phase 3 dev 阶段没有跑 typecheck（只跑了 eslint）。应该在 Phase 3 防护预检时加入 `vue-tsc --noEmit`，而非等到 PR 阶段
2. **compact-utils import 路径问题** — 编码时用相对路径 `../lib/compact-utils`，本地 eslint 通过但 vue-tsc 报错。应该在编码时就用项目约定的 `@/` 别名

### 关键数字

| 指标 | 值 |
|------|---|
| CI 轮次 | 3（fail ×2 + pass ×1） |
| 附带修复文件数 | 4（ChatOutline, ExtensionsPane, extension-resolver.test, ChatInput-subagent.test） |
| Gate 轮次 | 1（pass） |

## 全 5 Phase 纵览

### 整体效率

| Phase | Turns | Gate 轮次 | MUST_FIX | 核心产出 |
|-------|-------|-----------|----------|---------|
| 1. Spec | ~10 | 1 | 0 | spec.md 6 处澄清修改 |
| 2. Plan | ~8 | 2 | 1 | plan.md 3 Tasks + 4 辅助文件 |
| 3. Dev | ~13 | 1 | 2 | 2 文件修改 + 1 新增 + 6 review 文件 |
| 4. Test | ~10 | 4 | 1 | test_execution.json 11/11 pass |
| 5. PR | ~10 | 1 | 0 | CI green + PR evidence |
| **合计** | **~51** | **9** | **4** | **~20 个文件** |

### 跨 Phase 共性问题

#### 1. "2 文件修改 vs 20 文件交付物"的比例失调

实际代码改动只有 2 个 Vue 文件 + 1 个工具模块（约 150 行有效代码），但 harness 产出了约 20 个文件（spec、plan、4 个辅助文档、6 个 review、test template、test execution、pr evidence、ci results、5 个 retrospect、4 个 gate review）。**交付物/代码比为 10:1**。

对 L1 纯前端小改动，这个比例过高。Phase 2 的 plan 阶段产出了 5 个文件，但核心就是 plan.md 一个。Phase 4 的 test 阶段 10 个 TC 全是 code_review 类型，实质上是 Phase 3 code review 的重复。

#### 2. Gate 的 untracked files 循环

几乎所有 Phase 都遇到"gate 生成 gate_review 文件 → gate 报 untracked → commit → 重跑 gate"的循环。这个 pattern 在 5 个 Phase 中出现了至少 4 次，浪费了约 4 轮 gate 调用。

#### 3. L1 前端项目的 test phase 价值存疑

Phase 2 规划时所有 TC 标为 `manual`，Phase 4 执行时发现无法实际运行，改为 `code_review`。但 `code_review` 类型的 TC 在 Phase 3 的五步专项审查中已经覆盖。Test phase 实质上是对 dev phase 审查结果的二次声明。

### Harness 体验总评

**有价值的机制：**
- 五步专项审查（BLR → Standards → Taste → Robustness → Integration）确实发现了重复代码问题（MUST_FIX），推动了 compact-utils.ts 的提取
- Gate review 的反欺诈检查有效防止了虚假测试声明
- Spec → Plan → Dev 的分阶段澄清确保了编码前需求明确

**高 overhead 机制：**
- L1 plan 的 5 个辅助文件（e2e-test-plan、use-cases、non-functional-design、test_cases_template、interface_chain）对纯前端改动过重
- 五步审查对 2 文件改动需要 6 个 review 文件
- Gate review 文件自身的 untracked 检查循环

## 建议改进（优先级排序）

1. **L1 快速通道** — 允许 L1 任务将 Phase 2-4 合并为"编码+验证"单阶段：plan 精简为 task list（非完整 plan.md），test 合入 dev 的 self-check，省去 3 个 Phase 的 gate overhead
2. **Gate 产物排除 untracked 检查** — `gate_review_*.md` 文件由 gate 自身生成，应自动排除在 untracked 检查之外，或改为内存传递不写文件
3. **Gate 工具修复 ts_taste_review 匹配** — 已在 test retrospect 中记录，跨 Phase 重复出现说明这是一个需要优先修复的工具 bug
4. **Phase 3 防护预检加入 typecheck** — 对前端项目，预检不仅跑 eslint，还要跑 `vue-tsc --noEmit`，避免 PR 阶段才发现 typecheck 错误
