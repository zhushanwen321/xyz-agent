---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — statusline-design

## 1. Phase Execution Review

### Summary

完成了 L2 复杂度的完整实施计划，包含 13 个 Task、4 个 Execution Group（BG1/BG2/FG1/FG2）、3 个 Wave 编排。产出 11 个文档（plan.md 主文档 + 3 个子文档 + interface_chain.json + 4 个辅助文档 + 2 个 review 文档），通过 3 轮独立审查修复了 4 个 MUST FIX。

### Problems Encountered

**P1: 第 1 轮评审发现 3 个 MUST FIX — 代码扫描深度不足**
- 缺少 `index.ts` 回调注册 → Task 4 遗漏了管道的关键连接点（event-adapter 的 onStatusSetUpdate 回调在 index.ts 中注册）
- `contextOutputTokens` 无数据源 → spec 中写了"token stats 显示 ↑input ↓output"，但 chatStore 根本没有 outputTokens 字段，且数据来自两个不同时序的消息（context.update vs message.complete）
- `context.update` 后端未实现 → InputToolbar 的 context bar 依赖此消息，但 plan 初版没有增加发出此消息的 Task

根因：plan 编写前的代码扫描（subagent）覆盖了类型签名，但没有验证数据流的完整性（字段有定义但值为空、消息有 handler 但无人发出）。**应该多问一句："这些字段的数据实际从哪里来？"**

**P2: 第 2 轮评审发现 1 个 MUST FIX — 子文档与主文档不同步**
- plan.md 新增了 Task 5（emit context.update），但 plan-backend.md 没有对应的设计章节
- subagent 编写 plan-backend.md 时读的是旧版 plan.md（Task 编号已变更但子文档未更新）

根因：master plan 先修改了 Task 编号，但 subagent 编写子文档时没有重新读取最新版 plan.md。**应该在修改 master plan 后标记子文档需要同步更新。**

**P3: Gate 检查 2 次失败**
- `interface_chain.json` 缺少 `version` 字段 → 添加后又报 version 类型错误（需要 string 不是 int）
- `plan_bl_review` 文件缺失 → L2 特有的后端/前端对齐审查文件，gate 脚本要求但 skill 文档未明确提及

### What Would You Do Differently

1. **代码扫描增加"数据流端到端验证"步骤**：不仅扫描类型签名，还要追踪每个字段的数据从产生到消费的完整路径。如果某个字段的值永远为默认值（如 contextUsagePercent=0），标记为"数据源缺失"并在 plan 中增加修复 Task。
2. **Master plan 修改后立即同步子文档**：修改 Task 编号或新增 Task 时，直接在同一轮操作中更新子文档对应章节，而不是等评审指出不同步。
3. **Gate 要求前置检查**：在提交 gate 前，先读取 gate 脚本（check_gate.py）的 Phase 2 检查项，确保所有文件名模式和 YAML 字段格式正确。

### Key Risks for Later Phases

1. **context.update 的 contextWindow 获取方式未最终确定**：plan-backend.md §4a 推荐方案 A（回调模式），但具体由 server.ts 还是 index.ts 查询 modelService 还需要在 Phase 3 开始时确认。modelService 是异步的（可能需要 await），而 event-adapter 回调是同步的，需要 bridge。
2. **model 切换 RPC (`set_model`) 可用性未验证**：spec 假设 pi 有此 RPC 命令，但 Phase 1/2 均未验证。Phase 3 Task 9（InputToolbar）依赖此功能。
3. **tokenUsage 字段语义**：chatStore 有 tokenUsage（total tokens）和 contextInputTokens（input tokens），但两者的数据来源不同（message.complete vs context.update）。InputToolbar 显示时需要明确"显示什么数字"。

## 2. Harness Usability Review

### Flow Friction

- **L2 子文档 + plan_bl_review 是额外的 gate 要求**：skill 文档提到了 L2 需要子文档（plan-backend/frontend/api-contract），但没有明确提到 gate 脚本会额外检查 `plan_bl_review*.md` 文件。这个文件名模式是在 gate FAIL 后才从 check_gate.py 中发现的。建议在 skill 文档中明确列出 L2 gate 的所有必需文件。
- **interface_chain.json 的 version 字段类型**：gate 脚本要求 version 为 string（`"1"`），但 JSON 中直觉写为 int（`1`）。这种类型细节在 skill 文档中没有说明。

### Gate Quality

- Gate 检查非常严格和准确：untracked files（Phase 1）、version type mismatch、YAML frontmatter 缺失——全部是实质问题，没有误报。
- Gate 的错误信息足够定位问题（如 `'version' type=int, expected str`），修复高效。

### Prompt Clarity

- Skill 指令中的 L2 流程描述清晰（step 1-5 有序），Execution Groups 格式模板详细。
- **一个摩擦**：L2 的 "Step 4: API 对齐 subagent" 在实际执行中被 plan_bl_review 替代（gate 脚本检查 bl_review 而非对齐步骤的输出）。Skill 描述的 step 4 与 gate 实际检查的不完全一致。

### Automation Gaps

- **YAML frontmatter 格式验证没有前置工具**：每次 gate FAIL 都是因为 YAML 格式问题（缺少 `---`、字段类型错误）。如果有一个 `pre-gate-check` 脚本在提交前验证所有 YAML frontmatter，可以省掉 1-2 次 gate 重试。
- **子文档编号同步没有自动化**：master plan 的 Task 编号变更后，需要手动确保子文档的章节编号跟随更新。如果 master plan 用 JSON/YAML 定义 Task 列表，子文档可以引用而非硬编码编号。

### Time Sinks

- **3 轮评审**：第 1 轮 3 个 MUST FIX、第 2 轮 1 个 MUST FIX、第 3 轮通过。总计约 20 分钟评审时间。根因是 plan 初版缺少 2 个关键 Task（index.ts 回调注册、context.update 发出），这应该在 plan 编写阶段就发现。
- **Gate 2 次失败**：interface_chain version 类型 + plan_bl_review 缺失，每次修复约 2 分钟。总时间不长但打断了流程。
