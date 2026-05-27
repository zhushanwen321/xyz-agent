---
phase: pr
verdict: pass
---

# Overall Retrospect — bundle-pi-extensions (Phase 1-5)

## 1. Phase Execution Review

### Summary

整个 feature 历经 5 个 phase，最终产出 PR #53（77 files, +13540/-14）。实际有效编码量约 10 行（logger 路径修复 + ensureLogDir 移入 try），其余改动是 48 个 extension 源码文件复制 + wiring 代码（在 harness 流程启动前已完成）。

### Per-Phase 回顾

| Phase | 耗时占比 | 核心产出 | 关键问题 |
|-------|---------|---------|---------|
| 1 (spec) | 35% | spec.md + ADR-0011 | 过早实现导致 spec 描述"已完成+待完成"混合状态；渲染器误判为冲突 |
| 2 (plan) | 15% | plan.md + 4 个辅助文件 | 大部分工作已在 Phase 1 前完成，plan 只剩 logger 修复 + 删除目录 |
| 3 (dev) | 25% | logger.ts 修改 + evolution-engine 删除 + 5 步审查 | ensureLogDir 在 try 外（taste review 发现）；5 步审查对 10 行改动过重 |
| 4 (test) | 10% | test_execution.json（9 TC 全 pass） | 所有 TC 退化为 code_review，无运行时验证 |
| 5 (pr) | 15% | PR #53 + CI pass | push + PR 创建顺利，CI 一次通过（Lint/Test/TypeCheck） |

### Cross-Phase 关键教训

1. **过早实现是贯穿全流程的最大问题**：wiring 代码在 harness 启动前就已写完，导致 Phase 2 (plan) 变成"为已有代码写文档"，Phase 3 (dev) 变成"收尾两个遗漏项"，Phase 4 (test) 变成"静态验证已有代码"。整个 harness 流程的正确价值（先规划再执行）被削弱了。

2. **渲染器 vs extension 冲突误判**：Phase 1 将前端渲染器（RenderDescriptor.vue）误判为与 extension 功能冲突。实际上渲染器就是为展示 extension 输出而写的——是协同关系。正确的判断方法是检查 tool name 匹配，而不是按功能描述对比。

3. **5 步专项审查与改动规模不匹配**：Phase 3 的 5 步审查（BLR/Standards/Taste/Robustness/Integration）发现 1 个 MUST_FIX（ensureLogDir），但 dispatch 了 5 个 subagent、等待了 2 轮。对于 10 行改动，一个单步 code review 就足够。

4. **evolution-engine 误复制**：复制 extension 时没过滤，导致 Plan 要加一个删除 Task。应在复制前按 spec 排除列表过滤。

### What Would I Do Differently (Overall)

- **严格遵守"先分析后动手"**：即使需求看起来很明确，也等 spec 审查通过后再写代码。这次的经验证明了 harness 流程的价值——spec review 发现了目录结构遗漏，taste review 发现了 ensureLogDir 问题，这些都是编码时没注意到的。
- **为小改动使用轻量审查**：5 步专项审查应有改动规模门槛（如 > 50 行 / > 3 文件）。低于门槛时用单步 code review，避免 dispatch 开销。
- **TC 类型标注要诚实**：code_review 验证的 TC 不要标为 `manual`，直接标 `code_review`，避免给人"已手动验证"的误导。

### Key Risks Post-Merge

- **生产构建未实际验证**：只确认了 electron-builder.yml 配置正确，没跑 `npm run build` 检查打包产物。发布前需要验证。
- **无运行时验证**：没有启动 `npm run dev` 实际触发 extension 加载、slash command、tool 调用。如果 pi 的 jiti 在 RPC 模式下加载某个 extension 报 TS 编译错误，当前测试无法捕获。
- **migrateToPiSubdir 一次性同步限制**：app 更新后新增的 bundled extension 不会自动同步到 `~/.xyz-agent/`（目标存在则跳过）。用户需要手动删除旧目录触发重新同步。

## 2. Harness Usability Review

### Flow Friction

- **"已完成工作"在 harness 中的定位缺失**：harness 假设从零开始（spec 描述需求 → plan 规划实现 → dev 编码 → test 验证），没有处理"部分工作已完成"的场景。Phase 2 的 plan.md 不得不发明 "Pre-existing wiring" 段落来标注已完成代码，这不在 skill 模板中。

- **5 个交付物对 L1 改动过重**：Phase 2 的 L1 plan 仍需产出 5 个文件（plan.md + e2e-test-plan.md + test_cases_template.json + use-cases.md + non-functional-design.md）。对于 2 个 Task、10 行代码的改动，use-cases.md 和 non-functional-design.md 的边际价值接近零。

- **Phase 3 和 Phase 4 的验证重复**：Phase 3 的 test_results.md 和 Phase 4 的 test_execution.json 做了相同的代码路径追踪验证。区别仅是格式（markdown vs JSON）和粒度（整体 vs 逐 TC）。对于无法自动化的测试，这种重复是纯格式开销。

### Gate Quality

- **Gate check 脚本整体可靠**：5 个 phase 共执行了 3+9+17+4+2 = 35 项检查，全部正确，无假阳性、无遗漏。
- **YAML 类型检查有效**：`all_passing`、`pr_created`、`ci_passed` 的布尔类型检查避免了常见的 YAML 字符串/布尔混淆。
- **cross-reference 逻辑有效**：Phase 4 的 template case ↔ execution case 交叉引用检查确保了覆盖完整性。

### Prompt Clarity

- 各 phase skill 的文档质量整体较高，特别是：
  - Phase 1 brainstorming 的"先分析再动手"流程
  - Phase 2 writing-plans 的 L1/L2 分流
  - Phase 3 dev 的简单/复杂路径判断
  - Phase 5 PR 的"禁止 merge"安全约束
- 不足之处：
  - Phase 3 的 5 步审查没有改动规模门槛，导致小改动也必须走完整 5 步
  - Phase 4 的 TC 验证标准缺失（code_review 类型 TC 需要验证到什么程度？）

### Automation Gaps

- **Pre-commit hook false positive**：bare repo worktree 模式下 `.git/hooks/pre-commit` 是文件不是目录，gate 的 hook 检查总是报 "未安装"。需要增加对 worktree 模式的检测。
- **CI 等待无自动化**：Phase 5 需要手动 `sleep` + `gh pr checks` 轮询 CI 状态。应该有内置的 CI 等待机制（或至少在 skill 中提供推荐轮询脚本）。
- **Review 间数据传递无 schema**：BLR 产出的"模拟数据和执行路径"没有标准格式，Integration Review 需要自行解析。建议为 BLR 产出定义 schema。

### Time Sinks

| 阶段 | 时间消耗 | 实际价值 | 改进空间 |
|------|---------|---------|---------|
| Phase 1 冲突分析 | 2 轮对话 | 低（误判后纠正） | 检查 tool name 匹配即可 |
| Phase 2 5 个文件 | 产出+review | 中（plan.md 有价值，其他低） | L1 允许合并 use-cases/non-functional |
| Phase 3 5 步审查 | 5 subagent + 修复 + re-review | 中（发现 1 个 MUST_FIX） | 设规模门槛，小改动用单步 review |
| Phase 4 9 TC 编写 | 格式化已有验证 | 低（与 Phase 3 重复） | code_review 类型 TC 自动从 review 生成 |
| Phase 5 CI 等待 | 2 次 sleep 轮询 | 必要但手动 | 自动化 CI 等待 |
