---
target: "配色管理:侧边栏/对话流/drawer/split active"
total_score: 15
p0_count: 0
p1_count: 1
timestamp: 2026-07-09T03-08-11Z
slug: panel-color-system-sidebar-stream-drawer-split
---
# Critique: 配色管理（侧边栏 / 对话流 / 右 Drawer / Split Panel Active）

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | sticky header 半透明透字（SessionList 仍有一处） |
| 4 | Consistency and Standards | 2 | bg-elevated 嵌套进 surface 容器内，亮度层级倒挂 |
| 6 | Recognition / Recall | 3 | active panel 靠 ring+opacity，单/双态语义不一致 |
| 8 | Aesthetic / Minimalist | 3 | 暗色冷蓝方向对，但层级表达靠色差微弱 |
| **Total** | | **15/20** | **Good with structural flaw** |

## Anti-Patterns Verdict

LLM: 不像 AI 生成。配色走 CSS 变量 SSOT，无硬编码色泛滥，无渐变文字/玻璃拟态/侧色条。冷蓝暗色方向准确。问题不在乱，在层级语义倒挂。

Deterministic scan: 2 warnings (single-font 忽略, em-dash 在 CSS 注释非用户文案)。配色层面 0 硬编码色违规。

## Priority Issues

### P1: bg-elevated 嵌套进 surface 容器内，亮度层级倒挂
MainPanel(bg-surface #151519) 内的 Panel section / SideDrawer 用 bg-bg-elevated(#1c1c20)，子比父亮。设计意图是 MainPanel 唯一浮起。Fix: 方案A(section 三态透明, float-panel 统一 surface, 双panel时 main 退化为 bg 壳) 或 方案B(section 改 bg-surface 同色, 靠 ring 区分)。

### P2: SessionList sticky group header bg-surface/95 + blur
SessionList.vue:16 同 turn-meta 旧问题。侧边栏底色透明(融合 bg), sticky header 用 surface/95 半透明透字。Fix: 不透明色与侧边栏底色一致。

### P2: 侧边栏无独立底色, hover/active 缺承载层
AsideRegion/Sidebar 透明, SessionItem hover(bg-surface-hover #1f1f26)/active(bg-surface-2 #1b1b20) 比 bg(#0d0d0f) 亮太多, 无过渡层。Fix: 给 sidebar 补 bg-surface/bg-bg-elevated 微亮底色。

### P3: 单/双 panel active 表达不一致
双 standby 用 opacity-50 整面板变暗影响可读。Fix: standby 只变 border/header, 内容保持可读。

### P3: ProgressZone 用 bg-bg-input 与 Composer 同色
语义混淆(进度区 vs 输入区)。Fix: ProgressZone 用 bg-surface+border 或 bg-surface-2。

## Minor
- bg-elevated(#1c1c20) 与 surface-2(#1b1b20) 几乎同色语义不同, 建议合并或拉开
- SessionItem active ring(accent-ring 30% alpha) 在 #1b1b20 上对比偏弱

## Questions
1. bg-elevated token 是否还需存在? 语义与 surface 重叠
2. 侧边栏要不要补底色? (透明融合 vs hover 承载层)
3. standby 用 opacity 变暗是否可接受?
