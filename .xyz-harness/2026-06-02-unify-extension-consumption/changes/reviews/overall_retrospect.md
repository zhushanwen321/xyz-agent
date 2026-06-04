---
phase: pr
verdict: pass
absorbed: false
topic: "2026-06-02-unify-extension-consumption"
harness_issues:
  - "五步审查 + gate 的文件名约定不一致。审查 subagent 按技术栈命名（ts_taste_review_v1.md），gate 脚本按固定 glob 匹配（taste_review_v*.md）。需要在 skill 中明确命名规则，或在 gate 脚本中增加 alias 匹配"
  - "CI 修复循环（lint → typecheck）需要 3 次 push 才全部通过。根因：本地 tsc 通过但 CI 的 tsc 配置不同（strict mode），以及 eslint 对 unused args 的规则比本地更严。建议 Phase 3 dev 阶段就运行与 CI 完全相同的 tsc --noEmit 和 eslint 命令"
  - "gate check 对 review 文件名的 glob 匹配不校验 v1 是否 pass。如果 v1 是 fail v2 是 pass，gate 仍然通过——这可能是预期行为（最终通过即可），但 harness 应明确声明"
  - "test_cases_template.json 中 manual 类型被用于 code_review 验证方式。建议 skill 区分 manual（需要人工交互）和 code_review（读取文件/脚本确认）两种类型"
  - "v1→v2 审查循环是手动的（5 审查 × 2 轮 = 10 次 dispatch）。harness 应提供自动化的修复循环：dispatch review → 检查 must_fix → 如果 >0 则自动修复并重新 dispatch"
---

# Phase 5 Overall Retrospect: PR

## 1. 全流程执行回顾

### 总览

5 个 Phase 全部完成，产出：
- **Spec**: 8 FR、8 AC、7 约束、7 决策
- **Plan**: 5 Task、3 Execution Group、2 Wave、11 测试用例
- **Dev**: 10 源文件变更、554 测试（含 20 个新增）、10 审查报告（5 v1 + 5 v2）
- **Test**: 11/11 测试用例通过
- **PR**: PR #66 创建，CI 3/3 通过（Lint + Test + TypeCheck）

### Phase-by-Phase 回顾

#### Phase 1 (Spec) — 顺利
- 核心挑战：spec 增量编辑导致文件损坏（stale anchor），最终用 write 重写解决
- 决策质量高：Path Resolver 方案（Option A）在后续 4 个 Phase 中没有动摇
- 风险识别到位：FR-4.4（pi.extensions manifest）被正确标注为 postponed

#### Phase 2 (Plan) — 中等复杂度
- 核心挑战：deduplicate 逻辑方向错误、Task 3 跨组冲突
- Task 3 拆分为 3a/3b 是关键决策，避免了 subagent 间的文件竞争
- 风险：传递依赖白名单需要运行时验证（FR-7.4b 是 TODO stub）

#### Phase 3 (Dev) — 最复杂
- 产出最多（10 文件 + 20 测试 + 10 审查），耗时最长
- 核心问题：8 个 MUST_FIX 跨 4 个审查维度，根因都是"按假设编码未验证"
- 修复质量高：所有修复一次通过 v2 审查，无二次返工
- CI 发现了本地未捕获的 lint/typecheck 错误（需要 3 次 push 修复）

#### Phase 4 (Test) — 顺利
- 11/11 测试一轮通过，无修复循环
- taste_review 文件名不匹配是唯一的摩擦（通过 symlink 解决）
- TC-5-01/02 用 code_review 替代真实打包验证，风险可控

#### Phase 5 (PR) — 中等
- PR 创建顺利，CI 修复循环是主要时间消耗（3 次 push）
- CI 失败根因：本地 tsc 通过但 CI 的 tsc 配置更严格（strict mode 对 mock 返回类型检查）、eslint 对 unused args 规则更严
- 最终 Lint + Test + TypeCheck 3/3 通过

### 跨 Phase 模式

1. **"先验证再编码"被反复违反**。Phase 3 的 8 个 MUST_FIX 中有 5 个根因是"按假设编码"（piExtension 字段、去重 key 格式、文件型 extension、日志缺失、注释矛盾）。这个模式在 Phase 1 的假设审计中已被识别但没有形成可执行的约束。
2. **文件名/路径约定是系统性问题**。从 Phase 1 的 gate 脚本路径、Phase 3 的 taste_review 命名、到 Phase 4 的 test_execution.json 跟踪状态，每一步都有"文件在哪里/叫什么"的问题。
3. **CI 与本地环境差异**。Phase 5 暴露了 3 处本地通过但 CI 失败的差异。这不是 harness 的问题，但 harness 可以在 Phase 3 的防护预检中要求运行 CI 等价的命令。

### 整体风险

1. **pi-ext 包以 TS 源码发布**。从 Phase 3 贯穿到 Phase 5 的遗留风险。jiti 运行时编译 12 个包的性能影响未量化。FR-4（编译产物）是 postponed 状态。
2. **打包验证未做真实 npm run build**。TC-5-01 通过代码审查确认 electron-builder.yml 配置正确，但没有实际打包验证。需要在下一个发布周期的 CI 中覆盖。
3. **前端 widget/status 集成未做视觉验证**。vue-tsc 和 vite build 通过，但 ExtensionWidgetPanel 的实际渲染效果需要 `npm run dev` 手动确认。

## 2. Harness 体验回顾

### Flow Friction（跨 Phase 系统性问题）

- **审查循环是全流程最大的手动操作**。Phase 3 的五步审查需要 10 次 subagent dispatch（5 v1 + 5 v2），每次 dispatch 都需要：构造 task prompt → 等待完成 → 读取结果 → 检查 must_fix。如果 harness 提供 `dispatch_reviews --auto-fix` 模式，可以节省约 30 分钟。
- **gate check 的 untracked files 检查反复触发**。几乎每个 Phase 都至少有一次 gate FAIL 是因为文件写完后忘记 git add + commit。建议 gate 脚本在报错时附带提示 `git add -A && git commit`。

### Gate Quality

- Gate 检查覆盖率从 Phase 1（4 项）逐步增加到 Phase 5（3 项），Phase 3 达到峰值（18 项）。每个 Phase 的检查项都与该 Phase 的交付物精确匹配。
- **没有误报**。所有 gate FAIL 都指向真实问题（文件未跟踪、审查未通过、测试未通过）。
- **taste_review 文件名 glob 匹配**是一个设计缺陷。gate 用 `taste_review*.md` 匹配，但实际文件名是 `ts_taste_review_v1.md`。需要 symlink workaround。

### Prompt Clarity

- 5 个 Phase 的 skill 描述都足够清晰，没有出现"不知道该做什么"的情况。
- **Phase 3 的防护预检**是最有价值的 prompt 设计——发现 pre-commit hook 未安装，避免了后续 commit 缺少检查。
- **Phase 2 的"禁止实现代码"与"No Placeholders"矛盾**（已在 plan_retrospect 中记录）是唯一的 prompt 清晰度问题。

### Automation Gaps

1. **审查多轮编排**（5 Phase × 多轮）：dispatch → 等待 → 检查 → 修复 → 重新 dispatch。这是全流程最大的自动化缺口。
2. **vitest 结果到 test_execution.json 的映射**：需要手动将测试输出转为 JSON 格式。
3. **CI 与本地环境对齐**：本地 tsc/eslint 通过但 CI 失败，需要 3 次 push 才发现和修复。harness 可以在 Phase 3 要求运行 CI 等价命令。

### Time Sinks

| Phase | 时间消耗 | 主要原因 |
|-------|---------|---------|
| Spec | ~20% | spec.md 增量编辑损坏 |
| Plan | ~15% | deduplicate 逻辑分析 + Task 3 拆分联动更新 |
| Dev | ~40% | 五步审查（10 次 dispatch）+ MUST_FIX 修复 + replace_text 工具问题 |
| Test | ~10% | 流程顺畅 |
| PR | ~15% | CI 修复循环（3 次 push） |

**Dev Phase 占 40%** 是合理的（最复杂的 Phase），但其中约一半时间花在审查编排和工具问题上而非实际编码。
