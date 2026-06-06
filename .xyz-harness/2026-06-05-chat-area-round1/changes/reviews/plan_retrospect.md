---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-05-chat-area-round1"
harness_issues:
  - "Plan review v2 YAML frontmatter schema is ambiguous: subagent placed verdict/must_fix under nested `review` and `statistics` keys, gate expects them at top level. Skill SKILL.md example only shows top-level, but reviewer subagent inferred a richer schema."
  - "Plan review must explicitly check whether orchestration layer files (e.g. message-handler.ts) are missing when service-layer methods are modified — v1 reviewer caught this only because the subagent was thorough."
---

# Phase 2 Retrospect — Chat Area 第一轮优化 (Plan)

## 1. Phase Execution Review

### Summary

本阶段将 9 项功能需求（FR1-FR9）转化为可执行的实现计划。产出 5 份交付物：
- `plan.md`（19KB，6 个 Execution Groups，24 个 Tasks，含 Interface Contracts / Spec Coverage Matrix / Spec Metrics Traceability / Wave Schedule）
- `e2e-test-plan.md`（13 个测试场景）
- `test_cases_template.json`（23 个 test cases，JSON 验证通过）
- `use-cases.md`（8 个 UC + 覆盖映射表）
- `non-functional-design.md`（5 维度非功能设计）

经过 v1 评审发现 1 个 MUST_FIX（`tree-message-handler.ts` 编排层遗漏），修复后 v2 评审通过（verdict: pass, must_fix: 0），最终 gate PASS。

**关键决策：**
- L1 复杂度（不拆分为 plan-backend/plan-frontend 子文档），因为 8/9 是 UI 工作
- FG4/FG5 选择保留混合类型（前后端），并显式说明混合原因
- FG6 拆出独立的 Task 24 处理编排层（与 Task 21/22 串行），避免修改 service 接口却无人调用的"断头"问题

### Problems Encountered

1. **v1 评审发现 MUST_FIX：编排层文件遗漏**
   - 现象：修改了 `session-service.rebindAfterFork` 签名和 `tree-service.forkFromEntry` 签名，但没改调用方 `tree-message-handler.ts`
   - 后果：fork 路径下 `rebindAfterFork` 会使用 `old.label`（不传新 label），新 session 名为原名；clone 路径无 rename 逻辑，新 session label 等于原 label → **AC10 两条都失败**
   - 根因：v1 plan 编写时没有走完"接口修改 → 调用方 → 测试"的全链路，只盯着接口定义层
   - 解决：v2 plan 新增 Task 24（`tree-message-handler.ts`）+ File Structure 行 + FG6 Subagent 读取文件 + Spec Coverage Matrix

2. **YAML frontmatter schema 不匹配**
   - 现象：reviewer subagent 把 `verdict` 和 `must_fix` 放在 `review:` 和 `statistics:` 嵌套键下
   - 后果：第一次 gate FAIL（"must_fix field missing"）
   - 根因：subagent 推断了一个"更丰富"的 schema（参考 v1 review 的格式），但 SKILL.md 模板明确要求 top-level
   - 解决：在 YAML 顶部显式添加 `verdict: pass` 和 `must_fix: 0`，保留嵌套结构作为补充信息

3. **Task 编号跳跃（21→22→24）**
   - 现象：v1 plan 的 task 编号是 1-23，新增 Task 24 时出现了 24 在 23 之后的"时间倒序"
   - 原因：v2 修复时为了最小 diff，选择在最后追加新 task 而非重排
   - 影响：低。Task List 仍然可读（编号是 ID，不是顺序），但视觉上有点别扭

4. **Stale subagent status notification**
   - 现象：v1 review 完成后系统发了 "needs attention" 通知，但 subagent 已经返回结果
   - 影响：无实际影响（结果已捕获），但造成一次不必要的 status 查询

### What Would I Do Differently

- **Plan 阶段就做"调用链 grep"**：写完 service-layer 接口修改后，立即用 `grep` 找所有调用方，列在 plan 的 Affected Files 中。v1 的遗漏本可避免
- **Reviewer subagent 的 prompt 显式约束 schema**：明确告知"YAML frontmatter 必须在 top level 包含 `verdict` 和 `must_fix`，不要放在嵌套键下"
- **Task 编号规则**：追加新 task 时统一追加到末尾，从 1 顺序递增。v2 时把 Task 24 重排为 Task 24（保持连续），避免视觉混乱
- **Phase 1 期间的 spec.md 已隐含编排层职责**：spec 在 Key Decisions 表中提到 "后端 `rebindAfterFork` 时修改 session label"，但没指明调用方。spec 阶段就应该把"调用方"作为待澄清项之一

### Key Risks for Later Phases

- **Phase 3 (dev) 实际修改 tree-message-handler.ts 的 fork/clone case 时**：必须确保原 fork 行为不变（仅追加 label 拼接），避免回归到非命名修改前的行为。建议在 dev 阶段给 fork/clone 加 E2E 回归测试
- **WS 协议扩展的向后兼容**：spec 已说明新增类型不修改已有类型，但需要在 dev 阶段验证旧客户端与新 sidecar 组合的行为（应该静默忽略新类型）
- **macOS fullscreen 检测**：spec 标为 TODO，dev 阶段需要实现 `did-enter-full-screen` / `did-leave-full-screen` 监听
- **PanelBody flex 改造的影响面**：FG2 的 Task 8（`PanelBody` flex row 改造）会影响所有现有 panel 的渲染，需在 dev 阶段做分屏/全屏/不同窗口大小的视觉回归

## 2. Harness Usability Review

### Flow Friction

- **Plan review round-trip 增加时间**：v1→修复→v2→修复→gate 的循环比预期多 2 个 round。根因是 v1 plan 写完后没有做"调用链自查"，导致 MUST_FIX 在 review 阶段才被发现
- **L1 vs L2 选择的判断成本**：spec 的 5 个 L1/L2 评估维度对当前 spec 来说没有决定性差异（4/5 维度都是 L1，只有 1 个维度 L2 边缘），评估耗时但收益低
- **Mixed Execution Group 的合理性判定**：方法论说"无混合类型 Group"，但 IPC 链路类需求（FG4/FG5）拆分会增加协调成本。需要 reviewer 判断"混合是否合理"——这个判定是主观的，没有量化标准

### Gate Quality

- **Gate 校验精确**：能正确识别 v2 review 缺少 top-level `must_fix` 字段——这是个"格式正确性"问题，gate 抓住了
- **Gate 缺一个"pre-review"步骤**：v2 失败是因为 reviewer subagent 没遵循 frontmatter schema。如果 gate 在 subagent dispatch 之前先校验 schema 格式，可以避免一次 round-trip
- **Gate 对 MUST_FIX 修复的二次校验**：v2 review 显式说"v1 唯一的 MUST_FIX 已完整修复"，gate 没有二次确认修复证据（只检查 verdict/must_fix 数字）。对于强流程要求的场景，可以加"修复证据摘要"字段

### Prompt Clarity

- **writing-plans skill 文档的 interface_chain.json 章节** 强加在 L1 plan 上：L1 明确说"interface_chain.json 可选"，但评审时容易被误判为强制。需要更显式的"如果 complexity=L1，跳过本节"提示
- **writing-plans 的"Execution Group 模板"** 没有覆盖混合类型的场景，迫使 reviewer 临时发明"blockquote 混合类型说明"的格式
- **Reviewer subagent prompt 中的 "YAML frontmatter schema"** 没有 top-level 字段的强约束，subagent 自由发挥导致 schema 不匹配

### Automation Gaps

- **调用链自动检测**：plan 写完后，没有自动化检查"修改的方法是否有调用方被遗漏"。可以加一个 pre-gate 脚本，扫描 plan 中提到的"修改 X 方法"，grep 调用方
- **Reviewer subagent 的 schema 校验**：dispatch reviewer subagent 前，注入一个"必须使用以下 YAML schema"的 schema 字符串，强制 subagent 遵循
- **Plan → Task → Commit 的关联**：plan 中每个 task 写完后，应自动生成对应的 commit message 模板（`feat(${topic}): task ${id} ${description}`），便于后续追溯

### Time Sinks

- **v1 review 的 1 个 MUST_FIX + 4 个 LOW + 2 个 INFO = 7 个 issue**：每个 issue 都需要在 plan 中找对应行 + 改写，耗时约 15 分钟
- **YAML frontmatter 调试**：3 个 git commit 才把 gate 喂饱（v2 review 本身 → schema fix）。这个 round-trip 完全可以避免（参见 Automation Gaps）
- **2 次 subagent "needs attention" 假阳性**：每次都要手动查 status 确认 subagent 实际已完成

## Overall Verdict

**pass** — Phase 2 交付物完整（5 份文件 + 1 份 v1 review + 1 份 v2 review），计划可执行性高（24 个 Tasks / 6 个 Groups / 3 个 Wave 编排），AC 全覆盖（Spec Coverage Matrix 完整），spec→plan 指标链无断裂（Spec Metrics Traceability 完整）。

唯一需要后续关注的是 reviewer subagent 的 schema 约束问题——下次 dispatch review 时应在 prompt 中显式指定 YAML 字段位置。
