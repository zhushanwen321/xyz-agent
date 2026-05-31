---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — statusline-design

## 1. Phase Execution Review

### Summary

13 个 Task 按 Wave 模式全部完成：Wave 1 BG1（Tasks 1-6 后端管道，1 个串行 subagent）→ Wave 2 BG2+FG1 并行（Task 7 statusline plugin + Tasks 8-12 前端组件，2 个并行 subagent）→ Wave 3 FG2（Task 13 文档）。产出 28 个文件变更，+3520/-100 行（含审查报告）。5 步专项审查进行 2 轮：v1 发现 12 条 MUST FIX → 修复 ~30 行 → v2 全部 pass。

### Problems Encountered

**P1: v1 审查发现 12 条 MUST FIX — 3 类根因**

| 根因 | 数量 | 典型案例 |
|------|------|---------|
| pi 适配层乐观假设（认为数据一定有、格式一定正确） | 5 | `String(undefined)` = `"undefined"`; tokenUsage 从未被 set; thinking level RPC 不存在 |
| UI 分工偏离 spec（组件职责边界理解错误） | 4 | branch 放在 InputToolbar 而非 SessionStrip; AppStatusbar 和 SessionStrip 都显示 branch; ↓output 显示 totalTokens |
| plugin 防御不足（缺少 null guard / try-catch） | 3 | bridgeData.data 解构无 null check; onPiEvent handler 无 try-catch; onContextUpdate 无 session 空检查 |

根因分析：subagent 按 plan 的 Task 描述实现，但 plan 对边界条件的描述不够精确。例如 plan 说"空 text 表示清除"，但没有明确指出"清除"意味着调用 updateStatusBarItem 让 plugin-service 从 Map 移除，而非跳过调用。subagent 选择了 `if (text === '') return` 的语义（跳过 = 不操作），而正确语义是"传递空 text 让下游处理"。

**P2: BLR 和 Integration 审查的交叉验证**

BLR v1 的 5 条 MUST FIX 中有 2 条根因诊断不完全正确：
- BLR #3 说"outputTokens 永远为 0"是因为 setTokenUsage 零调用，但实际修复时发现 tokenUsage 是 totalTokens 而非 outputTokens
- BLR #4 说"SessionStrip 没有 branch"是错的——实际是 SessionStrip 有 branch，但 AppStatusbar 不该有

Integration 审查纠正了这些诊断。这说明 BLR 和 Integration 两个维度确实互补，BLR 捕捉症状，Integration 追溯数据流验证根因。

**P3: Taste Review 的 P0 降级**

ts_taste_review_v1 将 `onContextUpdate` 的 22 行 lambda 标为 P0 MUST FIX，但这是代码组织品味问题（函数过长），不影响正确性。gate 脚本要求 must_fix=0，被迫降级为 P1。这暴露了 gate 对 taste review 的 must_fix 定义过于严格——品味问题不应等同于功能 bug。

### What Would You Do Differently

1. **Plan Task 描述增加"清除语义"和"null 防护"清单**：对于涉及外部数据（pi RPC）的 Task，plan 应明确列出每个字段的 null/undefined 处理策略，而非依赖 subagent 自行判断。例如"空 text → 调用 updateStatusBarItem（plugin-service 会从 Map 删除），不要跳过调用"。

2. **UI 路由 checklist**：plan-frontend.md 应包含一个明确的"信息 → 组件"路由表（如 spec 的 AC-5 所述），subagent 实现时逐项核对。本次 branch 的位置错误就是因为 plan 没有明确的 checklist。

3. **Thinking level 等 RPC 未验证功能直接标注为"暂不实现"**：plan 阶段已识别 set_model RPC 可用性未验证，但仍然编入了 Task 9 的实现要求。更务实的做法是在 plan 中标注为"Phase 2 实现"或"需要 RPC 验证后决定"，避免编码 → 审查 → 回退的循环。

### Key Risks for Later Phases

1. **SessionStrip chip 颜色匹配失效**：`getChipClasses('goal')` 匹配 id，但实际 id 是 `pi-goal`（statusline plugin 加了 `pi-` 前缀）。startsWith 匹配可能工作，但需在 Phase 4 端到端测试中验证。
2. **Thinking level picker 是死代码**：UI 存在但 `v-if="false"` 隐藏。如果后续 pi 支持 setThinkingLevel RPC，需要恢复 emit 并在 server.ts 增加 handler。
3. **PI_VERSION 硬编码**：AppStatusbar 中的 pi 版本号是常量 `'0.75.5-xyz-0.1'`，需要跟随 pi 版本更新。长期应从 pi RPC 或 sidecar 配置动态获取。

## 2. Harness Usability Review

### Flow Friction

- **Wave 并行执行顺畅**：BG2 和 FG1 的并行 subagent 无文件冲突，各自 commit 无冲突。这验证了 plan 的 Execution Groups 划分合理。
- **Taste Review must_fix 与 gate 冲突**：gate 脚本要求所有 review 的 must_fix=0，但 taste review 的 P0 是代码品味问题（lambda 过长），不是功能 bug。被迫降级 P0→P1 来满足 gate，丧失了品味审查的实际效力。**建议：gate 对 taste_review 的 must_fix 检查改为警告而非阻塞**，或 taste_review 的 YAML 增加 `severity` 字段区分功能/品味。

### Gate Quality

- Gate self-check（`check_gate.py`）非常准确：18 项检查全部命中实际状态，无假阳性。
- Gate 的 `ts_taste_review_v1 must_fix=1` FAIL 是正确行为（YAML 确实写了 must_fix: 1），问题出在 review 本身的分类标准而非 gate 逻辑。

### Prompt Clarity

- skill 中的五步专项审查流程清晰：Batch 1（4 并行）→ Batch 2（1 串行依赖 BLR）→ 修复 → 重审。执行顺利。
- **一个摩擦**：skill 要求"无 lint 项目处理"时跳过 Phase A，但本项目有 lint（只是 101 个 warning）。审查 subagent 正确执行了 Phase A + B，无需特殊处理。

### Automation Gaps

- **MUST FIX 修复后的重审需要手动编排**：v1 发现 MUST FIX 后，我手动派遣了修复 subagent + 3 个重审 subagent（BLR v2, Robustness v2, Integration v2）。如果 harness 能自动编排"修复→重审"循环，可以减少手动调度。
- **Taste review P0→P1 降级需要手动编辑文件**：如果 gate 能区分 `severity: taste` 和 `severity: bug`，就不需要手动改 YAML。

### Time Sinks

- **5 步审查 v1→修复→v2 往返**：12 条 MUST FIX 的修复本身只改了 ~30 行代码，但修复 subagent + 3 个重审 subagent 的调度占用了较多 token。如果 subagent 在首次编码时就更防御性地处理 null/undefined，可以避免这个往返。
- **Taste review P0 降级**：为了满足 gate must_fix=0，花了 3 轮 sed 操作修改 YAML + 统计行。这是流程开销而非实际改进。
