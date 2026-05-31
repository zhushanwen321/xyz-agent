---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — statusline-design

## 1. Phase Execution Review

### Summary

完成了 statusline 功能的完整 spec 设计，包含：
- 梳理了 pi extension ↔ xyz-agent plugin 两套系统的关系和数据流
- 确定了唯一前端通道架构（所有 statusline 数据统一走 `plugin:statusBarUpdate`）
- 设计了 3 个 UI 区域（Input Toolbar / Session Strip / Global Statusbar）
- 创建了视觉 demo（`views_statusline-v2.html`）
- 新建 statusline built-in plugin 作为 pi extension 数据的适配层
- 产出了 ADR-0014 和 built-in plugin 开发指南的 FR
- 通过 2 轮独立审查，修复了 4 个 MUST FIX 问题

### Problems Encountered

**P1: git pull 冲突（stash + symlink 覆盖）**
- `git pull origin main` 时遇到 `package-lock.json` 冲突和 pi 资源 symlink 被覆盖
- 解决：`git stash` → 删除冲突的 symlink 文件 → pull → `git checkout --theirs package-lock.json`
- 影响：约 5 分钟额外处理，不影响 spec 质量

**P2: 第 1 轮评审发现 4 个 MUST FIX**
- 数据流路径歧义（两条并行通道未收敛为唯一通道）
- Chip 路由规则缺失（没有 scope 字段来区分 per-session vs global）
- Thinking level 固定 6 级与 `thinkingLevelMap` 动态类型冲突
- Model picker 选择后行为未定义
- 根因：spec 初版在方案探索阶段没有深入验证现有代码中的类型定义（`thinkingLevelMap`、`providerStore.models`）
- 修复：全部在 spec v2 中解决，第 2 轮评审 pass

### What Would You Do Differently

1. **在 Step 2 提问阶段就 dispatch on-demand scan 验证关键类型**：如果一开始就扫描 `provider.ts` 中的 `ModelInfo.thinkingLevelMap` 类型定义和 model 切换相关的 RPC 命令，spec 初版就不会出现 thinking level 固定枚举和 model picker 行为缺失的问题。这能省掉一轮评审。
2. **数据流路径应该在 Step 3 方案探索阶段就收敛为唯一方案**：初版同时描述了两条路径（event-adapter 直接广播 vs plugin 中转），在 spec 写作阶段才被评审指出歧义。方案探索时就应该明确选定一条。

### Key Risks for Later Phases

1. **pi RPC `set_model` 可用性未验证**：FR-3 假设 pi 有 `set_model` RPC 命令用于运行时模型切换。Phase 2 需要先验证此 RPC 是否存在，否则 Model picker 需降级为"仅显示"。
2. **statusline plugin hook 机制依赖 plugin-service 的事件路由**：`plugin:statusSetUpdate` 需要被正确路由到 plugin hooks。当前 hook 系统主要处理 `bridge:intercept` 和 `bridge:tool_execute`，新增事件类型需确认 hook 注册和触发链路。
3. **pi extension setStatus 文本格式不固定**：虽然 spec 决定纯透传不做解析，但 goal extension 的 setStatus 文本包含 ANSI theme 标记（如 `ctx.ui.theme.fg("accent", "◆ Goal")`），在 HTML 渲染时需要剥离或处理。

## 2. Harness Usability Review

### Flow Friction

- **Phase 1 的提问阶段（Step 2）是同步交互的，但 skill 指令要求 dispatch subagent**：用户在对话中直接回答了关键问题（scope、数据通道偏好、quota bars 不实现），不需要 subagent。但 on-demand scan 应该更早触发（验证 thinkingLevelMap 等类型）。
- **demo 产出比较自然**：dispatch subagent 创建 HTML demo 效率高，991 行 demo 一次产出。

### Gate Quality

- Gate 检查正确识别了 untracked files（4 个新文件未 git add），是合理的失败原因。
- Gate PASS 后的指令清晰：写复盘 → 调用 `coding-workflow-phase-start()`。

### Prompt Clarity

- Skill 指令整体清晰，brainstorming 流程的 Step 1-9 有序。
- **一个小摩擦**：spec 模板中的六元素检查和自检清单（生命周期/枚举/数据模型）是在 skill 末尾才提到的，实际执行时在 spec 初版写完后才做检查。如果能在 Step 5 写 spec 之前就提醒这些检查维度，可能减少评审轮次。

### Automation Gaps

- **评审 subagent 无法自己创建文件**：需要主 agent 在 task prompt 中精确指定文件路径和格式，略有配置负担但可接受。
- **Git 操作需要手动**：stash/pull/commit/push 都是手动执行，没有自动化。

### Time Sinks

- **研究两套 extension 系统的关系花了大量上下文**：bridge extension、plugin-service、event-adapter 三者的交互链路比较复杂，需要读 10+ 文件才能完整理解。这是项目的固有复杂度，不是 harness 的问题。
- **评审两轮**：第 1 轮 4 个 MUST FIX 都是实质问题（不是误报），说明 spec 初版确实需要这些修复。两轮评审总耗时约 15 分钟，合理。
