# Handoff · shell · draft-overlay-states（验收型 · 已完成 · 两项未决已收口）

## 1. 路径
- 目录：`v3-demo/shell/`
- 文件：`draft-overlay-states.html`（✅ 已完成）
- 层级：L0 Shell（动态两态 + 跨平台窗口控制）
- 上游 spec：`shell/spec.md`（第二节两态 + 第五节跨平台方案 X + 第七节实现要点）

## 2. 产物现状
- standalone，内联 CSS，冷蓝 token
- **两态**：非全屏（traffic light opacity 1 + app-nav-controls left:90px）/ 全屏（opacity 0 + app-nav-controls 左移 left:20px，**320ms** 平移 = --duration-slow，与 traffic-light 同步）
- **应用按钮三件套**（收起 / ← 后退 / → 前进，应用自绘 DOM 三平台统一）
- **跨平台方案 X**：win/linux `frame:false` + 自绘 3 彩色圆点 mimic mac（hover 显 close/min/max），三平台左上视觉统一
- 尺寸表（安全区 / app-nav-controls left / padding-top）

## 3. 已做的事（回顾）
- [x] 两态切换（traffic-light opacity + app-nav-controls 位移）
- [x] 方案 X 跨平台 mimic_mac（取代弃用的流派 A）
- [x] 应用按钮三件套 + 全屏 hover 由 mac 系统提供（应用不画第三态）
- [x] **时间同步**（2026-06-19）：app-nav-controls 与 traffic-light 统一 320ms（= --duration-slow）同曲线；win/linux 两元素皆应用自绘严格同步，mac traffic-light 由 OS 绘制（时长不可控）
- [x] **←/→ 粒度**（2026-06-19，**已确认 · unified_nav**）：定为导航历史（浏览器模型，栈条目 = 会话+视图节点），与 Flow 4「回退分支」解耦

## 4. 验收（回顾 · 若改动需重过）
- [x] 全屏 hover 不画第三态（mac 系统下拉覆盖层提供）
- [x] app-nav-controls 三平台恒 left:90px（全屏 20px）
- [x] **时间同步已定**（2026-06-19）：app-nav-controls 与 traffic-light 统一 320ms（= --duration-slow）同曲线。win/linux 两元素皆应用自绘严格同步；mac traffic-light 由 OS 绘制（时长不可控），应用只保证 app-nav-controls 用 320ms。
- [x] **←/→ 历史栈粒度已定**（2026-06-19，**已确认 · unified_nav**）：←/→ = 导航历史（浏览器模型），栈条目 = (会话, 视图节点)。**与 Flow 4「回退分支」解耦**——分支回退是对话级动作走 Session Tree + 分支 pill，不走 chrome ←/→。原「需对齐 Flow 4」依赖撤销。
- [ ] 折叠态布局 / breadcrumb 跳转目标 —— 属 sidebar L2 / overview，不在本稿范围，deferred

## 5. 关联文档
- 上游：`shell/spec.md`（方案 X 决策演进表 + 实现要点第七节）
- 同层：`draft-skeleton`（兄弟稿，静态拓扑，本稿在其上加动态层）
- 下游：Flow 4（**已解耦**——←/→ 定为导航历史不依赖 Flow 4；Flow 4 的分支回退走 Session Tree + 分支 pill，是独立机制）

## 6. 关联 HTML
- 参考：`draft-skeleton.html`（拓扑底座，两态画在其上）
- 集成点：L0 Shell 的窗口控制层 + 全局快捷键 ⌘N/⌘K（⌘K 跳转 overlays/search-modal）

## 7. Suggested skills（接手改稿时）
- `frontend-design`（两态过渡曲线校准）
- `impeccable`（mimic_mac 三平台一致性 review）
