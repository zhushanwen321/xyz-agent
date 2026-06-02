---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-02-unify-extension-consumption"
harness_issues:
  - "brainstorming skill 的 Step 2-4 与 Step 6 之间缺乏明确的中间产物检查点。从用户确认设计到写 spec 之间，假设审计和 six-element check 容易被压缩或跳过"
  - "edit 工具在多轮增量编辑同一文件时产生 stale anchor 和重复行问题。建议 brainstorming skill 明确建议：对复杂 spec 的修改超过 3 处时，直接 write 整个文件而非增量 edit"
---

# Phase 1 Retrospect: Spec

## 1. Phase Execution Review

### Summary

完成了 xyz-agent 统一 Extension 消费架构的 spec。核心产出：spec.md（8 FR、8 AC、7 约束、7 决策、3 业务用例）+ VS Code 架构调研文档 + 2 轮 review。

关键决策：pi.extensions manifest（FR-4.4）确保编译产物入口被 pi 发现、传递依赖白名单（FR-7.3/7.4）防止 electron-builder pruning、第三方 extension 同样受益于 setWidget/setStatus 桥接。

### Problems Encountered

1. **spec 增量编辑导致文件损坏**。在修复 review v1 的 2 个 MUST_FIX 时，用 edit 工具对 spec.md 做了 6 处增量修改。由于 stale anchor 和 replace 操作的边界问题，产生了重复的 FR-1.3~1.6 行和两个 FR-2 标题。最终直接 write 整个文件解决。耗时约 15 分钟在 edit 调试上。

2. **gate check 脚本路径不在项目内**。`check_gate.py` 在 `~/.agents/skills/xyz-harness-gate/scripts/` 下，但 coding-workflow 的 skill instructions 引用了 `skills/xyz-harness-gate/scripts/check_gate.py`（项目相对路径），导致首次运行时 No such file。需要 `find` 定位实际路径。

3. **review subagent 首次 dispatch 后 inactive**。subagent 运行超时触发 needs_attention 信号，但实际已完成输出。需要手动检查状态确认结果已写入。

### What Would You Do Differently

- **从一开始就用 write 而非 edit 修改 spec**。spec 是线性文档，增量 edit 的锚点管理开销超过了重写的成本。对超过 100 行的 markdown 文件，修改 3+ 处时应该直接 write 整个文件。
- **假设审计更早执行**。review v1 发现的两个 MUST_FIX（入口路径冲突、传递依赖缺失）本质上都是假设错误。如果在 Step 5 假设审计时更彻底地检查 pi loader 源码（而非只读 event-adapter），可以避免 review 阶段的返工。

### Key Risks for Later Phases

1. **FR-4.4 的 pi.extensions manifest 需要验证**。假设 pi 的 `resolveExtensionEntries` 优先读取 `package.json` 中的 `pi.extensions` 字段，但这一假设基于代码阅读而非运行时验证。Phase 2 应包含验证脚本任务。
2. **传递依赖白名单维护成本**。FR-7.3 要求手动扫描每个 pi-ext 的 dependencies 加入 files 白名单。每次 pi-ext 新增依赖都需要同步更新 electron-builder.yml。Phase 2 应考虑自动化脚本。
3. **打包验证是高风险操作**。CLAUDE.md Rule #12 已有打包配置 bug 先例。Phase 3 的每个打包相关改动必须逐个 commit 验证。

## 2. Harness Usability Review

### Flow Friction

- **brainstorming skill 步骤粒度不均**。Step 1-4（overview + questions + approaches + design）是自然对话流，但 Step 5-8（假设审计 → 写 spec → 完整性检查 → 术语/ADR）感觉像是在执行 checklist 而非探索性工作。实际执行中 Step 5-8 被压缩在一起，没有独立的检查点。
- **compacted context 导致步骤追踪困难**。session compact 后，brainstorming skill 的步骤进度（当前在 Step 5 还是 Step 6）变得模糊。建议 skill 提供显式的进度标记机制。

### Gate Quality

- Gate check 准确。4 项检查（untracked files、spec verdict、review verdict、review must_fix）都指向真实问题。首次 FAIL 是因为文件未 commit（untracked files 检查），commit 后 PASS。
- 没有误报。

### Prompt Clarity

- brainstorming skill 的 Step 5（假设审计）描述清晰，但缺少具体的假设提取模板。实际执行时依赖 AI 自行判断"哪些是假设"，容易遗漏。
- review subagent 的 task prompt 效果好，两轮 review 都产出了结构化的 YAML 结果和具体的问题列表。

### Automation Gaps

- **gate check 脚本路径发现**需要手动 `find`。coding-workflow 应该自动解析 skill 安装路径，不需要 AI 猜测。
- **spec review 的多轮编排**（dispatch → 检查结果 → 修复 → 重新 dispatch）是手动执行的。可以自动化为：dispatch review → 检查 must_fix → 如果 >0 则自动修复并重新 dispatch。

### Time Sinks

- **spec.md 增量编辑调试**占了 phase 总时间的 ~20%。根因是 edit 工具的 stale anchor 机制与多轮编辑模式不兼容。
- **review subagent 的 needs_attention 信号**造成了不必要的等待和状态检查。subagent 实际已完成但触发了 inactive 超时。
