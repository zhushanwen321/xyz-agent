---
phase: pr
verdict: pass
---

# Overall Retrospective — Runtime + Front-end Architecture Refactoring

覆盖全部 5 个 Phase（Spec → Plan → Dev → Test → PR）。项目：xyz-agent Runtime Service Layer 提取 + 前端快速修复 + 健壮性修复。

## 1. Phase Execution Review

### Summary

将 xyz-agent Runtime 层从两个上帝类（server.ts 574L + session-pool.ts 472L）重构为 Transport + Service 分层架构，同时完成前端快速修复和 19 项健壮性修复。

**最终指标：**
- 23 commits，60 files，+6406/-993
- server.ts: 569L → ~370L Transport 层
- session-pool.ts: 完全删除
- 新增：services/ 目录（3 个 Service，680L）、interfaces.ts（142L）、message-converter.ts（80L）
- 前端：删除 3 个死 composable，新增 system-notification 工厂，useSession/useProvider refCount 保护
- 健壮性修复：1 个 P0（tool approval 事件名）+ 8 个 P1 + 10 个 P2
- 4 个 ADR 创建（手动 DI、SessionPool 删除、PiEvent 松散类型、原子写入）
- 测试：46 runtime tests 全通过，20 个测试用例全部 PASS
- CI：Lint + TypeCheck + Test 全 PASS

### Phase-by-Phase 回顾

#### Phase 1 (Spec) — 3 轮评审

Infra scan → spec 编写 → 3 轮评审（v1 fail → v2 pass → v3 确认）。核心问题是 session-pool 去向未在一开始明确，导致 FR/AC 文字残留不一致。教训：决策先行，FR/AC 后写；修改决策后必须全文搜索验证。

#### Phase 2 (Plan) — 3 轮评审

10 个 Task 分 4 个 Execution Group（BG1/BG2/BG3/FG1）。核心问题是 BG3 Task 8 粒度过粗（把"定义接口 + 提取 3 个 Service + 重写 server + 删 session-pool"塞进一个 Task），3 轮后才拆为 Task 7 + Task 8。教训：涉及"删一个类 + 提取到 N 个新类 + 重写调用方"的操作默认应拆成多个子 Task。

#### Phase 3 (Dev) — 3 Wave 执行

Wave 1（BG1）和 Wave 2（BG2+FG1）各用 1 个 subagent，顺利通过。Wave 3（BG3）是核心重构，用 1 个 high-complexity subagent 完成。server.ts 365L 超出 AC-1 的 ≤250L 目标，code review 接受。教训：AC 行数目标应附估算依据。

健壮性修复在 dev phase 完成后追加，用 3 个 parallel subagent 执行（Runtime 核心 + 类型安全 + 前端），共修复 19 个问题。这是计划外的工作量，但对生产质量至关重要。

#### Phase 4 (Test) — 20 用例

TC-11-01（`vue-tsc` 类型错误）R1 失败，原因是 SystemNotification.vue 缺少 `'info'` prop。这应在 dev 阶段的 `npm run build` 中被发现，说明 dev 阶段的编译检查不够严格。TC-7-02（server.ts 行数超标）R1 失败，R2 以 code review 结论接受。

#### Phase 5 (PR) — 多次迭代

CI 首轮失败（3 个 unused import），修复后通过。后续健壮性修复推送后 GitHub CI 未再触发新 run（PR synchronize batching），通过本地 pre-merge-check.sh 等价验证。用户在 PR 阶段额外要求了 code-review-worktree 审查和 ADR 创建，这些属于 scope 扩展但合理。

### Problems Encountered (Overall)

1. **Spec 行数目标脱离实际**：server.ts ≤250L 在 27 个消息 handler 的 switch/case 不可压缩的前提下不可能实现。从 spec 到 plan 到 test 三个 phase 都在处理这个偏差。根源是 spec 编写时没有做最小行数估算。
2. **PiEvent 类型绑定的设计承诺无法兑现**：Spec FR-2 承诺 event-adapter 的 translate() 使用 PiEvent 联合类型做 exhaustive check，实际发现 pi 发送 union 外的事件类型。这是 spec 阶段对 pi 协议理解不足导致的——写 spec 时没有实际运行 pi 观察其完整事件输出。
3. **CI pipeline 触发不稳定**：健壮性修复推送后 GitHub CI 未触发新 run，只能用本地验证替代。根本原因是 `concurrency: cancel-in-progress: true` 配合快速连续 push 导致事件被吞。这个问题的解决需要要么改 CI 配置要么减慢 push 频率。
4. **健壮性修复是计划外工作**：code-review-worktree 发现的 19 个问题中，大部分是基线 bug（不是本次重构引入的），但 P0 #1（tool approval 事件名）直接导致核心功能失效。如果不在 PR 阶段发现并修复，merge 后用户会遇到工具审批永远弹不出的严重问题。

### What Would You Do Differently

1. **Spec 阶段加入"代码实证"环节**：对于关键假设（如"pi 事件类型都在 PiEvent union 中"、"server.ts 可以压到 250L"），在 spec 评审前跑一段实际代码验证，而不是基于代码阅读做推断。这 10 分钟的验证可以省掉后续 3 个 phase 的偏差处理。
2. **Dev 阶段每个 subagent task 完成后强制 `npm run build`**：而不是只在每个 Wave 结束后跑 `tsc --noEmit`。TC-11-01 的类型错误本应在 BG3 Task 8 完成时就被发现。
3. **健壮性审查提前到 Dev 阶段**：code-review-worktree 发现的 P0/P1 问题不应该等到 PR 阶段才修复。应在 BG3 完成后、进入 Test 之前做一轮独立的健壮性审查。
4. **减少评审迭代**：5 个 phase 共做了 10 轮评审（spec 3 + plan 3 + code review 2 + test review 1 + PR review 1）。如果评审者在首轮做更彻底的"决策影响分析"和"行数估算验证"，至少可以减少 2-3 轮。

### Key Risks (Post-Merge)

1. **server.ts 370L 仍有增长趋势**：每新增一个消息类型会增加 ~10 行。建议在下一个 spec 中引入 Map-based 路由（`Map<ClientMessageType, MessageHandler>`）彻底解耦。
2. **PiEvent 松散类型绑定的维护成本**：ADR-0003 解释了为什么 translate() 不严格绑定 PiEvent，但未来开发者可能会"修复"这个看起来像 bug 的设计。需要在 event-adapter.ts 的注释中持续维护决策说明。
3. **4 个前端测试 baseline 失败**：Vite 配置缺少 `@vitejs/plugin-vue`，导致前端测试长期不可用。应尽快修复。
4. **atomicWrite 放在 scanner-base.ts 不直觉**：后续应移到独立的 `fs-utils.ts`。

---

## 2. Harness Usability Review

### Flow Friction

**整体顺畅。** Spec → Plan → Dev → Test → PR 的线性流程清晰，每个 phase 的交付物和下游依赖关系明确。主要摩擦点：

1. **Gate check 需要手动运行 Python 脚本**。每次 gate 前需要 `python3 skills/xyz-harness-gate/scripts/check_gate.py {topic} {phase}`，而且需要确保 YAML frontmatter 格式完全正确（布尔值 vs 字符串、`must_fix` 数字等）。格式错误导致 gate FAIL 的频率高于预期——在本项目的 5 个 phase 中，至少 2 次 gate FAIL 是因为 YAML 格式问题（字符串 `"true"` vs 布尔 `true`、缺少顶层 frontmatter 字段）。
2. **Phase 5 的 scope 扩展处理不够结构化**。用户在 PR 阶段要求了 code-review-worktree 审查、健壮性修复、ADR 创建——这些都不在原始 spec/plan 范围内。Harness 没有提供"scope 扩展"的标准流程，只能临时回到 dev 模式修复。
3. **CI 等待是隐形时间消耗**。每次 push 后等待 GitHub CI（30-50 秒）在整个 PR 阶段累积了相当可观的时间。如果 CI 可以在 gate check 时自动验证（而不是手动 `gh pr checks`），流程会更紧凑。

### Gate Quality

**Gate check 整体有效**，正确识别了多个阻塞项：
- Spec v1: 3 条 MUST FIX（session-pool 去向、types.ts 位置、handler 枚举）
- Code review: 正确区分了 MUST FIX 和 LOW
- Test execution: 正确检测了 TC-7-02 和 TC-11-01 的失败

**一个值得改进的点**：gate 脚本检查 YAML frontmatter 的严格程度有时过高。例如 `pr_created: true`（布尔）vs `pr_created: "true"`（字符串）的区别在实践中容易混淆。建议 gate 脚本对布尔字段做类型宽松处理（同时接受布尔和字符串 "true"/"yes"），减少格式问题导致的 false FAIL。

### Prompt Clarity

**Harness 的 prompt 质量整体较高**，特别是：
- 每个 phase skill 的 Prerequisites/Steps/Self-Check 结构清晰
- YAML frontmatter 的字段说明表（类型/必填/允许值/常见错误）非常实用
- test_cases_template.json 的 steps 字段足够具体

**可以改进的地方**：
- **Phase 5 skill 的 "Merge" 步骤应区分"可以 merge"和"禁止 merge"两种模式**。当前 skill 写了 merge 步骤但 coding-workflow 又加了 `CRITICAL RULE: MUST NOT merge`，两者矛盾。如果 harness 自动管理 merge（Auto Mode），skill 中就不应出现 merge 步骤的详细描述。
- **Retrospect 的触发时机描述不够清晰**。Phase 5 skill 写"当 merge 完成后立即执行"，但 coding-workflow 的扩展在 gate PASS 后就自动 dispatch retrospect subagent。主 agent 不知道是应该自己写 retrospect 还是等 subagent 写，导致有时写两次。

### Automation Gaps

1. **Gate YAML 格式验证可以前置**：在 `test_results.md` / `code_review_v1.md` / `pr_evidence.md` 等文件的写入阶段就验证 YAML 格式，而不是等到 gate check 才发现格式错误。可以在 skill 的"Record Results"步骤中加入格式校验 snippet。
2. **CI 结果可以自动收集**：`gh pr checks` 的输出可以自动解析并填入 `ci_results.md`，不需要手动复制 URL 和 commit SHA。
3. **Spec AC ↔ Test Case 的覆盖矩阵可以自动生成**：如果 test_cases_template.json 中每个用例标注覆盖的 AC ID（`"acRefs": ["AC-1", "AC-4"]`），覆盖矩阵可以从 JSON 自动生成。
4. **健壮性审查没有标准流程**：code-review-worktree 是独立 skill，不在 harness 流程中。应在 Dev 和 Test 之间或 Test 和 PR 之间增加一个可选的"健壮性审查"阶段。

### Time Sinks

1. **评审迭代（10 轮）**是最大的时间消耗。Spec 3 轮 + Plan 3 轮是正常范围，但每次评审需要完整重读 spec/plan。如果评审能在首轮更彻底（做行数估算验证、决策影响分析），可以减少 2-3 轮。
2. **CI 等待和调试**：CI 首轮失败（unused import）→ 修复 → 等待 → 健壮性修复推送 → CI 未触发 → 调试 GitHub Actions 配置。累计消耗了约 5 分钟的等待时间。
3. **Gate YAML 格式调试**：2 次 gate FAIL 是因为 YAML 格式问题（缺少顶层 frontmatter、布尔值写成了字符串）。这类问题每次需要 1-2 分钟排查和修复，累计约 3 分钟。
