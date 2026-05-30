---
phase: pr
verdict: pass
---

# Overall Retrospect — provider-model-mapping

## 1. Phase Execution Review (全部 5 个 Phase)

### 整体 Summary
5 个 Phase 顺利完成，产出 1 个功能特性（provider model thinkingLevelMap UI），涉及 6 个源文件（+257 -18），全部 5 项专项审查通过，10 个测试用例全部 PASS。PR #60 已创建并更新描述。

总耗时分布：Spec（2 轮 review）→ Plan（2 轮 review）→ Dev（2 轮 review，4 个 MUST_FIX）→ Test（1 个 round-2 ACCEPT）→ PR（顺滑）。

### Phase-by-Phase 回顾

**Phase 1 (Spec)** — 效率高，需求明确（用户已提供 demo HTML）。Review v1 发现 2 条 MUST_FIX（序列化歧义 + 缺少错误处理），v2 通过。核心教训：序列化策略应在 spec 中确定唯一方案，不用"或"留歧义。

**Phase 2 (Plan)** — L1 复杂度评估合理，5 个 Task + 2 Wave 结构清晰。Review v1 发现 1 条 MUST_FIX（原生 `<button>` 违规），v2 通过。核心教训：plan 代码模板必须遵守 xyz-ui 规范，即使在伪代码级别。

**Phase 3 (Dev)** — 最有价值的 Phase。5 个 Task 一次编码正确，但五步专项审查捕获了 4 个 MUST_FIX：
- **BLR MUST_FIX-1（Critical）**：ConfigService.setProvider 全替换丢失 reasoning 等字段——这是已有 bug 但本功能使其高频触发。`{ ...base, id }` merge 策略修复。
- **Robustness M1**：Watch 重入导致 Input 失焦。selfEmitting 标志修复。
- **Robustness M2**：expandedModels 跨 Modal 会话泄漏。重置修复。
- **Robustness M3**：类型校验不严格。isValidThinkingLevelMap 类型守卫修复。

核心教训：Plan review 应该识别 ConfigService 的字段丢失风险——这是整个功能链路上最关键的集成点。

**Phase 4 (Test)** — 10 个 TC 通过 code review + build verification 执行。TC-5-02（WS 异步错误传播）round-1 FAIL 后接受为已知架构限制。核心教训：UI TC 应标注 verification_method: code_review，避免歧义。

**Phase 5 (PR)** — 顺滑。PR #60 已存在（大分支），更新描述即可。CI 未在 feature 分支触发（workflow 仅 main 触发），本地验证代替。

### 跨 Phase 的一致性问题

1. **Pre-existing TS2345 反复验证**：InputToolbar.vue 的 2 个类型错误在 Dev 和 Test Phase 各验证一次（共 ~8 min）。应在 Dev Phase 开始时建立 baseline 并记录，后续 Phase 直接引用。
2. **Review 两轮模式**：Spec、Plan、Dev 都经历了 v1 FAIL → 修复 → v2 PASS 的两轮模式。这不是偶然——review 的价值正在于捕获问题。但手动 dispatch 两轮 review 是可自动化的。
3. **ConfigService 集成点**：这个文件在 Plan（Task 2）、Dev（BLR MUST_FIX-1）、Test（TC-1-2-5-01）三个 Phase 都是焦点。高风险集成点应在 Plan Phase 被标记为"需要额外审查"。

### What Would You Do Differently

- **在 Plan Phase 标记高风险集成点**：ConfigService.setProvider 是已有代码中唯一的 models 写入路径，任何新字段保存都经过它。Plan 应显式标记"此文件修改需验证字段保留完整性"，减少 Dev Phase 的 MUST_FIX。
- **建立 build/lint baseline**：Dev Phase 开始时运行一次 `npm run build && npm run lint`，输出保存为 baseline。后续 Phase 对比即可，不需要反复人工验证 pre-existing errors。
- **selfEmitting 应作为 Vue 组件默认模式**：所有 v-model 组件 + internal watch 都应使用此模式。纳入 frontend-dev skill 编码规范。

### Key Risks (Post-Merge)

- **WS fire-and-forget 限制**：所有 Provider 保存操作（不只是 thinkingLevelMap）都不具备 async 错误反馈。未来需引入 WS request-response 模式。
- **InputToolbar.vue TS2345**：2 个 pre-existing 类型错误应在后续 PR 修复。
- **No E2E browser coverage**：所有测试为 code_review 类型。视觉回归（如 Input focus 丢失）难以通过代码审查捕获。

## 2. Harness Usability Review (整体评估)

### Flow Friction
整体流程顺滑。Phase 间衔接自然，每个 Phase 的交付物自然成为下一个 Phase 的输入。Gate check 机制有效防止了"跳步骤"——spec 不通过不能写 plan，code review 不通过不能进 test。

唯一的 friction：两轮 review dispatch 需要手动操作（v1 FAIL → 读报告 → 修代码 → 重新 dispatch v2）。这个模式在 Spec、Plan、Dev 三个 Phase 都出现了，占用了可观的交互轮次。

### Gate Quality
Gate 在 5 个 Phase 都正确执行：
- Phase 1：正确检测 untracked files（commit 前调用 gate）
- Phase 2：YAML frontmatter + 文件存在性检查通过
- Phase 3：审查 MUST_FIX 数量归零后通过
- Phase 4：test_execution.json 格式 + 全部 PASS 验证通过
- Phase 5：pr_evidence + ci_results 格式验证通过

无 false positive。Gate 的严格程度恰到好处。

### Prompt Clarity
Skill instructions 在每个 Phase 都提供了清晰的步骤指引和检查清单。YAML frontmatter 格式说明详细，字段类型（boolean vs string）的强调避免了常见错误。

改进建议：Gate 脚本路径（`skills/xyz-harness-gate/scripts/check_gate.py`）在 worktree 中不存在，应更新 skill instructions 为仅使用 `coding-workflow-gate` 工具，或说明路径的 fallback 逻辑。

### Automation Gaps（按优先级）

1. **Review 两轮自动重试**（高）：v1 发现 MUST_FIX → 自动 dispatch fix subagent → 自动 re-dispatch review。减少 3-5 轮手动交互。
2. **Build/lint baseline 自动建立**（中）：Dev Phase 开始时自动运行并保存 baseline，后续 Phase 自动对比。
3. **FR→TC 覆盖矩阵自动检查**（低）：Gate 脚本验证每个 spec AC 至少有一个 TC 覆盖。
4. **Code review TC 自动 dispatch**（低）：当所有 TC 为 code_review 类型时，自动 dispatch 验证 subagent。

### Time Sinks
- **ConfigService merge 设计**（~15 min）：Dev Phase 最有价值的思考时间。设计正确的 merge 策略比写代码本身更重要。
- **Pre-existing error 反复验证**（~8 min）：跨 Dev + Test Phase 的重复工作。
- **Review 两轮 dispatch 手动操作**（~10 min）：3 个 Phase × 读报告 + 修代码 + 重新 dispatch。
- **TC-5-02 取舍决策**（~5 min）：已知架构限制 vs test PASS 的判断。

### 总体评价
Harness 流程在本 feature 上运行良好。五步专项审查是最大的质量保障——BLR 发现的 ConfigService 字段丢失问题如果未被捕获，会导致一个"表面上工作但实际破坏已有功能"的严重 bug。这验证了多维度审查的价值。

流程改进的核心方向是**自动化 review 循环**——当前的手动两轮模式是最大的效率瓶颈，但也是质量保障的关键环节。自动化 fix→re-review 循环可以在保持质量的同时减少交互轮次。
