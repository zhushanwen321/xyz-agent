---
phase: test
verdict: pass
absorbed: false
topic: "2026-06-02-unify-extension-consumption"
harness_issues:
  - "gate check 对 taste_review 文件名用 glob `taste_review_v*.md` 匹配，但实际产出文件名为 `ts_taste_review_v1.md`。需要额外创建 symlink 才能通过。建议 gate 脚本同时匹配 `ts_taste_review_v*.md`，或在 skill 中明确命名约束"
  - "TC-5-01（electron-builder 打包验证）和 TC-5-02（preflight-check 破坏性测试）在 test_cases_template.json 中标记为 manual，但实际执行方式是 code_review（检查配置文件和脚本内容）。如果不需要 npm run build，template 中 type 应为 code_review 而非 manual"
  - "Phase 4 gate 第一次 FAIL 原因是 test_execution.json 未被 git 跟踪——提交文件后重试即通过。这个检查有价值但错误信息可以更明确（提示需要 git add + commit）"
---

# Phase 4 Retrospect: Test

## 1. Phase Execution Review

### Summary

执行 11 个测试用例（test_cases_template.json），全部通过。测试类型分布：
- **TC-1-01~04** (integration): ExtensionResolver 四源扫描 + 去重 + shared/ 排除 — vitest 自动化覆盖
- **TC-2-01** (integration): `--extension` 路径传递链路 — 代码审查确认（rpc-client 不添加文件后缀）
- **TC-3-01~03** (integration): event-adapter widget/status 桥接 — vitest 自动化覆盖
- **TC-4-01** (manual): bundled 目录删除 — bash ls 验证
- **TC-5-01~02** (manual): 打包配置 + preflight 脚本 — 代码审查确认

所有 case 一轮通过（round=1），无修复循环。test_execution.json 覆盖率 11/11。

### Problems Encountered

1. **taste_review 文件名不匹配**。Phase 3 产出 `ts_taste_review_v1.md`，但 gate check 用 `taste_review_v*.md` glob 匹配。Phase 4 gate 因此报 "Phase 3 no taste_review_v*.md found"。解决：创建 symlink `taste_review_v1.md → ts_taste_review_v1.md`。根因：审查 subagent 按技术栈命名（TypeScript taste review），gate 脚本按固定模式匹配。

2. **test_execution.json 未跟踪**。gate check 要求 `.xyz-harness/` 下所有文件被 git 跟踪。第一次 gate FAIL 就是这个原因。解决：git add + commit。不算是 bug，但错误信息 "1 untracked" 可以更明确地提示需要 git commit。

### What Would You Do Differently

- **template 中 manual type 改为 code_review**。TC-5-01 和 TC-5-02 在 template 中标记为 manual，但实际执行方式是读取 electron-builder.yml 和 preflight-check.sh 内容进行验证，没有交互式操作。如果 type 是 code_review，执行步骤描述会更准确。
- **提前 git add**。写完 test_execution.json 后立即 git add，避免 gate 的 untracked 检查失败。

### Key Risks for Later Phases

- **TC-5-01 未做真实打包验证**。electron-builder 的 extraResources 配置已通过代码审查确认正确，但没有实际 `npm run build` 验证打包产物。Phase 5 (PR) 的 CI 应覆盖这个验证。
- **pi-ext 包以 TS 源码发布**（延续 Phase 3 风险）。所有 12 个包的 `main` 字段为空，jiti 运行时编译 TS。性能影响未在测试中量化。

## 2. Harness Usability Review

### Flow Friction

- Phase 4 流程简洁：读 template → 执行 → 写 JSON → gate。没有不必要的中间步骤。
- **taste_review 文件名问题**是唯一的摩擦点。gate 在 Phase 4 检查 Phase 3 的审查文件，跨 phase 依赖在所难免，但文件名匹配规则应该更宽松或更明确。

### Gate Quality

- Gate 的 5 项检查精准：untracked files、template 加载、JSON 格式、case ID 覆盖率、最终轮次结果。
- **cross-reference 有价值**。自动比对 test_execution 和 test_cases_template 的 case ID，能发现遗漏或拼写错误。本次 11/11 完全覆盖。
- JSON 字段类型检查严格（`passed` 必须是 boolean 而非 string），这是好的——防止 `passed: "true"` 这类错误。

### Prompt Clarity

- Skill 步骤清晰，JSON schema 文档详细（含常见错误列）。
- **Self-Check Checklist 有价值**。FR→TC 覆盖矩阵和 verification_method 标注检查确保测试质量。

### Automation Gaps

- **vitest 结果到 test_execution.json 的映射是手动的**。需要人工读取 vitest 输出，转为 JSON 格式的 execute_steps。如果有脚本自动从 vitest JSON reporter 提取并通过用例名称匹配到 TC ID，效率会更高。
- **code_review 类型测试的执行标准模糊**。TC-2-01 和 TC-5-01/02 用代码审查替代自动化测试，但 "多少行代码审查算足够" 没有明确标准。本次用 grep + 文件内容确认，但审查深度依赖于执行者的判断。

### Time Sinks

- 整个 Phase 4 执行时间约 10 分钟，无显著时间浪费。
- taste_review symlink 修复花了约 2 分钟。
