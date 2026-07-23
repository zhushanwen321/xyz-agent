# Spec Review — sidedrawer-per-session

**日期**: 2026-07-23
**审查方法**: 主 agent 自审（已读全部相关代码：useSideDrawer / chat-message-effects / PanelContainer / SideDrawer.vue / useSidebar.selectSession / useSessionScopedState）。禁读重建：从 objective + CL1 独立推导 spec 应有内容，与初稿 diff。

## 审查范围

- 重建章节：FunctionalRequirements + AcceptanceCriteria + 潜在遗漏
- diff 对象：初稿 specSections（8 FR / 6 AC / 3 决策）

## 重建 vs 初稿 diff 结论

初稿覆盖了核心诉求（控制态分区、sid 守卫、pendingOpen、tasks docked 收进分区、调用方透明、session 销毁清理、测试隔离）。FR/AC 与 objective + CL1 结论对齐良好，无矛盾，术语统一。

但重建时识别出 4 个初稿未覆盖或定义不足的点：

## 发现的问题

| ID | severity | dimension | ref | 问题 |
|----|----------|-----------|-----|------|
| SR1 | must-fix | reasonableness | FR-3 | pendingOpen 消费的**挂点**未明确。FR-3 只说「focusedSessionId 变化时消费」，但没说挂在哪。若实现者挂独立 `watch(focusedSessionId)`，会撞上项目已记录的「Runtime broadcast 时序竞争」（AGENTS.md 架构约定：session 级状态在 selectSession 流程内部发出会早于 renderer 订阅）。正确挂点是 **useSidebar.selectSession 内部**（与 commands/context/subagent 兜底拉取同位置），保证 session 切换编排在单一时序点。 |
| SR2 | must-fix | completeness | FR-2/FR-3 | 「用户手动 open drawer 时是否清 pendingOpen」语义未定义。场景：session A 有 pendingOpen=true（后台 tasks 事件），用户切回 A 后**手动**点了文件树的文件（drawer.open('detail')）而非等 pendingOpen 自动开 tasks。此时 pendingOpen 是否清？两种合理做法：(a) 手动 open 不清——用户没看 tasks tab，tasks 事件仍「未展示」；(b) 手动 open 即清——用户已主动打开 drawer 说明注意到该 session，持续提示是打扰。不定义会导致实现者随意选一个，行为不可预测。 |
| SR3 | should-fix | completeness | AC | 缺「快速来回切 session（A→B→A）pendingOpen 不重复触发 open」的显式 AC。FR-3 的「清标记」隐含幂等，但无 AC 直接验证。幂等性是 watch 消费类逻辑的常见坑，值得显式覆盖。 |
| SR4 | should-fix | completeness | FR-1/D3 | 双 panel split 模式下，drawer 是单实例跟随 active panel（PanelContainer 只有 1 个 `<SideDrawer>`）。spec 没声明 standby panel 的 drawer 状态语义。隐含结论：drawer 永远只展示 active panel session 的状态，standby panel 无独立 drawer 状态（切到 standby 即它变 active，其 session 分区状态自然显示）。应在 D3 或 FR-1 显式声明，避免实现者误以为要给两个 panel 各维护一份 drawer 状态。 |

## 修复（spec_review_fix 第 1 轮）

经 CL2 clarifyRecord 补齐 specSections：
- SR1 → FR-3 重写（消费挂 selectSession 内部，不挂独立 watch）
- SR2 → 新增 FR-9（手动 open 即清 pendingOpen，经用户确认）
- SR3 → 新增 AC-7（A→B→A 快速切换幂等）
- SR4 → 新增 FR-10 + AC-9（双 panel standby 无独立 drawer 状态）

## 复查结论（spec_review turn 2）

4 个 issue 全部闭环。spec 现有 10 FR + 9 AC + 3 决策，覆盖：控制态分区、sid 守卫、pendingOpen（消费挂点 + 手动清 + 幂等）、tasks docked 收进分区、调用方透明、selectedCommandName 不分区、session 销毁清理、测试隔离、双 panel standby 语义。术语统一，无矛盾，AC 均可机器判定。

**spec 就绪进 plan。**
