---
verdict: fail
must_fix: 5
---

# Plan Review v1: Phase 2 交付物审查

**审查日期**: 2026-06-08
**审查模式**: Mode 1 — Plan review（验证 plan 可行性）
**Phase**: Phase 2 — Plan

---

## 总评

**Phase 2 的 5 个交付物全部缺失。** 当前 harness 目录下仅存在 `spec.md`（Phase 1 产出）及 Phase 1 的 review 文件。Phase 2 尚未开始执行。

---

## 交付物存在性检查

| 交付物 | 状态 | 说明 |
|--------|------|------|
| `plan.md` | ❌ 不存在 | 实施计划，应包含任务拆分、依赖关系、实施顺序 |
| `e2e-test-plan.md` | ❌ 不存在 | E2E 测试计划，应覆盖 spec 的验收标准 |
| `test_cases_template.json` | ❌ 不存在 | 测试用例模板，结构化测试场景 |
| `use-cases.md` | ❌ 不存在 | 用例文档，应展开 spec 中的 UC-1/2/3 |
| `non-functional-design.md` | ❌ 不存在 | 非功能设计，应覆盖性能、主题、兼容等 |

---

## MUST_FIX 问题

### MUST_FIX-1: plan.md 缺失

**文件**: `plan.md`

实施计划是 Phase 2 的核心交付物。spec.md 已定义 6 个功能需求（FR-1~6）和 8 个验收标准（AC-1~8），需要 plan 将其拆分为可执行的任务，明确：

- 任务列表（每个任务对应一个独立可验证的改动集）
- 任务间依赖关系（串行/并行）
- 每个任务涉及的文件和改动范围
- 与 spec constraints 的对应关系（不改 shared types、不改 useChat 等）

**阻塞级别**: 无法进入 Phase 3（dev）。

### MUST_FIX-2: e2e-test-plan.md 缺失

**文件**: `e2e-test-plan.md`

E2E 测试计划应覆盖 spec 的 8 个验收标准，特别是：

- AC-5 的 4 组符号序列分组测试（可直接转化为测试用例）
- AC-4 streaming MergeBlock 实时更新验证
- AC-7 legacy 消息兼容性验证
- AC-8 standaloneTools 配置变更立即生效

**阻塞级别**: Phase 4（test）的输入依赖。

### MUST_FIX-3: test_cases_template.json 缺失

**文件**: `test_cases_template.json`

结构化测试用例模板，为自动化测试提供输入。

**阻塞级别**: Phase 4（test）的输入依赖。

### MUST_FIX-4: use-cases.md 缺失

**文件**: `use-cases.md`

spec.md 定义了 3 个业务用例（UC-1/2/3），use-cases.md 应展开为详细的用户操作步骤、预期结果和边界条件。

**阻塞级别**: 测试用例设计的输入依赖。

### MUST_FIX-5: non-functional-design.md 缺失

**文件**: `non-functional-design.md`

spec 的 AC-6 要求 light/dark/dim 三主题兼容，Constraints §5 要求不新增 CSS 变量。非功能设计文档应明确：

- 性能要求（50+ contentBlocks 的渲染策略）
- 主题兼容的具体验证点
- 无障碍访问考虑
- compactStreaming 开关切换时的状态处理

**阻塞级别**: 实施阶段的设计参考。

---

## Spec 状态确认

Phase 1 已完成并通过：

- `spec.md` 存在（10965 字节），内容完整
- `gate_review_1.md` verdict: pass, must_fix: 0
- `spec_review_v2.md` verdict: pass, must_fix: 0

Phase 2 的前置条件已满足，可以开始执行。

---

## 建议

执行 Phase 2（plan phase），生成上述 5 个交付物。重点关注：

1. **plan.md 任务拆分粒度**：spec 评估为"中等复杂度"，建议拆为 5-7 个 task，每个 task ≤ 3 文件 / 1000 行改动
2. **AC-5 符号序列测试**：spec 已给出 4 组精确的输入/预期输出，e2e-test-plan 应完整覆盖
3. **streaming 路径**：spec v2 review 的 SHOULD_FIX-3 提到 streaming 期间展开能力缺失，plan 应明确是否实现或在后续迭代补充
