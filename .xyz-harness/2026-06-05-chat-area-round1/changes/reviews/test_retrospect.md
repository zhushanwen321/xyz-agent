---
phase: test
verdict: pass
absorbed: false
topic: "2026-06-05-chat-area-round1"
harness_issues:
  - "taste_review 命名不一致：skill 指示 TS 项目输出 ts_taste_review_v1.md，但 gate-runner index.ts 只识别 taste_review 前缀。需要统一命名规范。"
  - "gate-runner 对 prior phase reviews 的校验模式与 skill 命名约定不同步。Phase 4 gate 检查 Phase 3 reviews 时用的 glob 模式应同时匹配 ts_taste_review 和 taste_review。"
  - "test_cases_template.json 中 14/23 为 UI 类型，但 Phase 4 明确不执行 UI 级 E2E 测试。大量 UI 用例只能通过 code_review 验证，降低了 test phase 的实质价值。建议在 plan phase 区分 automated 和 code_review 类型的 TC，减少 Phase 4 中的低价值验证。"
---

# Phase 4 Retrospect — Chat Area 第一轮优化 (Test)

## 1. Phase Execution Review

### Summary

Phase 4 执行了 test_cases_template.json 中的 23 个测试用例。其中 4 个 API 测试通过单元测试验证（fork/clone label 命名、WS protocol 类型），3 个 integration 测试通过单元测试验证（collectMessageContent markdown/plain 格式），2 个 manual 测试通过代码审查验证（macOS 布局），14 个 UI 测试全部通过代码审查验证（组件结构、事件处理、CSS 行为）。

额外新增了 3 个单元测试覆盖 `data-markdown-source` 的读取路径（markdown 格式优先读 data 属性、无 data 属性时 fallback 到 textContent、plain 格式忽略 data 属性），使 renderer 测试从 104 增加到 107。

**关键数字：**
- 23/23 test cases executed and passed
- 613 automated tests green (506 runtime + 107 renderer)
- 3 new unit tests added during execution
- 0 lint errors / 0 typecheck errors
- 1 gate retry (taste_review 命名问题)

### Problems Encountered

1. **taste_review 命名不匹配导致 gate FAIL**
   - 现象：Phase 3 产出的文件名为 `ts_taste_review_v1.md`（按 TS 项目的 taste skill 指示），但 Phase 4 gate 检查 Phase 3 reviews 时寻找 `taste_review` 前缀
   - 根因：gate-runner index.ts 的 `reviewPrefix` 数组只包含 `"taste_review"`，不包含 `"ts_taste_review"`。skill 文档说 TS 项目用 `ts_taste_review_v1.md`，但 gate 和 skill 的命名约定不一致
   - 解决：重命名文件 `ts_taste_review_v1.md` → `taste_review_v1.md`
   - 影响：额外 1 次 commit + gate retry

2. **14/23 UI 测试只能 code_review**
   - 现象：test_cases_template.json 中 14 个标记为 `type: "ui"` 的 TC 无法自动化执行，Phase 4 只能通过代码审查验证
   - 根因：项目没有 Playwright/Cypress E2E 测试基础设施；Phase 4 skill 明确说明"不执行 UI 级 E2E 测试"
   - 解决：每个 UI TC 用代码审查步骤（验证组件结构、事件绑定、CSS 类名）替代实际交互测试
   - 影响：code_review 验证强度低于自动化测试——能验证"代码存在且结构正确"，但不能验证"运行时行为符合预期"

3. **data-markdown-source 测试覆盖不足**
   - 现象：Phase 3 集成修复添加了 `data-markdown-source` 属性和 `collectMessageContent` 的优先读取逻辑，但 Phase 3 没有新增对应测试
   - 根因：集成修复由主 agent 直接完成（不在 subagent TDD 流程中），测试补充被遗漏
   - 解决：Phase 4 执行 TC-2-01 时发现并新增 3 个单元测试
   - 教训：MUST_FIX 修复应同步补充测试（或在 Phase 3 Self-Check 中要求）

### What Would I Do Differently

- **test_cases_template.json 应区分 verification_method**：在 plan phase 就标注每个 TC 的验证方式（`automated` / `code_review` / `manual`），减少 Phase 4 中"发现 UI TC 无法执行"的意外
- **集成修复必须补充测试**：Phase 3 的 MUST_FIX 修复（特别是 M#3 markdown source）应包含对应的单元测试
- **gate 前先检查 review 文件命名**：在提交 gate 之前用 `ls` 快速验证所有 review 文件名匹配 gate 期望的前缀

### Key Risks for Later Phases

- **UI 测试覆盖为零**：14 个 UI 交互场景（hover、click、dropdown、scroll、sidebar collapse）仅有代码审查验证，没有运行时测试。任何 CSS 重构或组件 API 变更都可能破坏这些场景
- **macOS fullscreen 布局未实际运行验证**：TC-7-01/TC-7-02 仅通过代码审查验证布局条件分支，未在 macOS 上实际运行
- **Alt 键残留问题**（Phase 3 遗留）：Alt+Tab 切换后 isAltPressed 可能残留 true，此问题在 Phase 4 未验证

## 2. Harness Usability Review

### Flow Friction

- **taste_review 命名不一致**是唯一的摩擦点。Phase 3 skill 说 TS 项目输出 `ts_taste_review_v1.md`，Phase 4 gate 只认 `taste_review`。需要查源码才能定位原因
- Phase 4 本身执行很流畅：read template → verify via tests/code review → write test_execution.json → gate

### Gate Quality

- **gate 交叉验证有效**：gate 检查 test_execution.json 中的 caseId 是否覆盖 test_cases_template.json 中的所有 id，防止遗漏
- **gate 对 JSON 类型检查严格**：`passed` 必须是布尔值，`round` 必须是数字，`execute_steps` 不能为空数组
- **命名问题是唯一的 gate 质量问题**：gate 对 review 文件前缀的匹配逻辑过于严格（glob `taste_review_v*.md`），应同时匹配 `ts_taste_review_v*.md` 和 `rust_taste_review_v*.md`

### Prompt Clarity

- Phase 4 skill 的步骤描述清晰：read template → execute → record → fix → gate
- "本阶段执行集成/功能测试，不执行 UI 级 E2E 测试"的限定明确，避免浪费时间尝试无头浏览器测试
- `code_review` 作为验证方式在 skill 中有提及但未详细说明格式。实际操作中以 "code_review: Verified..." 前缀的 execute_steps 代替

### Automation Gaps

- **缺少 UI 组件测试基础设施**：项目没有 Vue Testing Library / @testing-library/vue 等组件测试工具，无法在 vitest 中模拟用户交互（hover、click dropdown、scroll）
- **缺少 test_execution.json 自动生成**：需要手动编写 JSON，容易出错（布尔值 vs 字符串、空数组检查）
- **缺少 review 文件命名校验**：没有工具在 Phase 3 结束时检查 review 文件名是否符合 gate 期望的前缀

### Time Sinks

- **手动编写 test_execution.json（23 条）**：每条需要精确的 caseId、步骤描述、evidence，耗时约 10 分钟
- **taste_review 重命名 + gate retry**：约 2 分钟，但需要查源码定位根因

## Overall Verdict

**pass** — Phase 4 完成 23/23 TC 执行，新增 3 个单元测试，全部自动化测试通过。主要教训是 taste_review 命名规范需要 gate 和 skill 保持一致，以及 UI TC 的 code_review 验证强度有限。
