---
target: 左侧边栏 4 视图（会话/文件/subagent/workflow）
total_score: 25
p0_count: 0
p1_count: 3
timestamp: 2026-07-15T11-14-29Z
slug: packages-renderer-src-components-sidebar
---
# Critique: 左侧边栏 4 视图（会话/文件/subagent/workflow）

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | tab badge 过度信号（已完成任务也亮蓝点） |
| 2 | Match System / Real World | 3 | tooltip 用原生 title，与自定义 UI 格格不入 |
| 3 | User Control and Freedom | 2 | workflow abort 无确认；subagent 列表无任何控制动作 |
| 4 | Consistency and Standards | 2 | ScrollArea vs overflow-y-auto 混用；4 tab count 语义不一致 |
| 5 | Error Prevention | 2 | abort 无确认；pending 行变灰无解释 |
| 6 | Recognition Rather Than Recall | 2 | icon-only tab + 原生 title；hover-only 操作按钮 |
| 7 | Flexibility and Efficiency | 3 | ⌘N/⌘K/⌘B 齐全，但无 tab 切换/列表键盘导航 |
| 8 | Aesthetic and Minimalist Design | 3 | 干净克制，subagentId 原始 hash 是噪声 |
| 9 | Error Recovery | 3 | 全列表 error+retry，toast+fail-fast rollback |
| 10 | Help and Documentation | 2 | 空态被动不教学；phase/术语无 inline 解释 |
| **Total** | | **25/40** | **Acceptable** |

## Anti-Patterns Verdict

非 AI slop。设计克制、token 驱动、无渐变文字/玻璃拟态/侧色条/big-number hero。组件词汇一致（xyz-ui Button）。信息密度匹配目标受众（后端开发者，6h/天使用）。这是合格的产品 UI，问题在打磨层。

## Priority Issues

### [P1] workflow abort 无破坏性操作确认
terminate 一个 running workflow 是不可逆操作，但 WorkflowList L68-77 和 WorkflowDetail L39-47 都直接 emit action，Sidebar.onWorkflowAction L346-357 直调 RPC，无 confirm。对比：SessionItem 删除有 confirm dialog。破坏性操作缺确认 = Error Prevention 违规。

### [P1] hover-only 操作按钮：关键控制对键盘/触屏不可见
WorkflowList L56 操作按钮 `opacity-0 group-hover:opacity-100`。running workflow 的 pause/abort 仅 hover 可见。问题：(1) 键盘 Tab 导航到不了看不见的按钮；(2) 触屏无 hover；(3) 与 WorkflowDetail（L28-48 常驻显示）不一致。running 任务的控制在列表里应常驻或至少 focus可达。

### [P1] 4 tab count 语义不一致 + badge 过度信号
sessions count = 总会话数（有意义）；files count = 顶层节点数（有意义）；subagents/workflows count = 含已完成/失败的全部记录（不反映「多少需要关注」）。badge 逻辑：subagentCount > 0 即亮（L74），已完成任务也亮蓝点——misleading。comment L69 已承认「简化为 count > 0 即亮，后续可按 status 精确判断」。

### [P2] subagent/workflow 空态不教学
SessionList 空态有「新建会话」按钮（可操作）。SubagentList/WorkflowList 空态只说「发起 subagent 后在此查看进度」，不解释如何发起、入口在哪。产品 register 原则：空态应教学，不是「nothing here」。

### [P2] 滚动原语不一致
SessionList/FileView 用 `<ScrollArea>`（自定义暗色滚动条）；SubagentList/WorkflowList/WorkflowDetail 用 `overflow-y-auto`（浏览器默认滚动条）。同侧边栏内 4 视图滚动条样式不统一。

### [P2] pending agent call 变灰不可点击但无解释
WorkflowDetail L79 `opacity-40` + L81 `call.status !== 'pending' && emit`。用户看到灰色行不知道为什么不能点。需要 title 或 inline hint 说明「等待执行」。

## Persona Red Flags

**Alex (Power User)**: 无 ⌘1-4 切 tab 快捷键；subagent/workflow 列表无键盘导航；hover-only 操作按钮键盘不可达；abort 无 ⌘+Z 撤销。

**Jordan (First-Timer)**: icon-only tab 靠原生 title（2s 延迟）才知道含义；subagent 空态说「发起 subagent」但不告诉怎么发起；WorkflowDetail 的 phase 分组、dimmed pending 行无解释；subagentId 原始 hash 对非开发者无意义。

## Minor Observations
- SegmentedTab tooltip 用原生 `title`，慢且不一致，考虑用项目 tooltip 组件
- subagentId 前 12 位 hash 显示在卡片右侧，对监控用途是噪声（workflow 显示 slug 更有意义）
- WorkflowList 进度条按 agent 完成数算，但 agent 可能耗时差异巨大，进度不线性反映时间

## Questions to Consider
- subagent 为什么没有 cancel/pause 操作？后端不支持还是 UI 未接？
- 4 tab 的 count 能否统一为「需关注数」（running 态）而非总数？
- 空态能否加「如何发起」的引导或快捷入口？
