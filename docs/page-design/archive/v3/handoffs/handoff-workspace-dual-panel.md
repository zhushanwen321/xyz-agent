# Handoff · workspace · draft-dual-panel（验收型 · 已完成）

## 1. 路径
- 目录：`v3/workspace/`
- 文件：`draft-dual-panel.html`（✅ 已完成）
- 层级：L1 Region · Workspace 容器（含 1-2 个 Panel）
- 上游 spec：`workspace/spec.md`（主从决策 + 四层激活标识 + 已知限制）

## 2. 产物现状
- standalone，内联 CSS，冷蓝 token
- **双 Panel 主从模式**：同一时刻默认只有一个 Panel 真干活，另一个待机/参考；active panel 对话区永不被压缩遮挡
- **四层激活标识**（叠加一眼认焦点）：左侧 2px accent 竖条 + inset 1px accent-ring（30% 透明）+ bg-elevated 微亮 + 整体 opacity（激活 1 / 非激活 0.5 / hover 0.78）
- **单一 panel-header**（无工作区级横跨 header）：状态圆点 + session名 + 目录 + ⋯三点 + ×关闭
- 单 session 时 Panel-2 隐藏（Panel-1 撑满）
- progress-zone（composer 上）+ git-zone（composer 下）位置已定

## 3. 已做的事（回顾）
- [x] 主从模式（非对等）决策 + 理由
- [x] 四层激活标识系统（避开双 panel 中缝双线打架）
- [x] 单一 panel-header 结构
- [x] 进度浮层方案废弃 → composer 上下内嵌 zone

## 4. 验收（回顾 · 若改动需重过）
- [x] active panel 对话区不被压缩遮挡
- [x] 四层激活标识无中缝双线打架（用 inset ring + opacity 而非整圈实线）
- [ ] ⚠️ **已知限制**（spec 末尾「遗留」）：
  - diff 抽屉仍浮层覆盖对侧（v1 不处理）
  - TaskTree 不做（初期不含）
- [ ] ⚠️ **待同步**：spec 末尾「工作区操作入口待定」——上轮 panel/spec 已裁决「新建会话→workspace 顶部，split→panel-header（双 Panel 时隐藏）」，workspace/spec 需补这句

## 5. 关联文档
- 上游：`workspace/spec.md`（主从 + 四层激活 + 已知限制）
- 同层：`shell/spec.md`（Workspace 嵌在 main float-panel 内）
- 下游：`panel/spec.md`（Panel 是 Workspace 内工作载体）+ panel 4 draft

## 6. 关联 HTML
- 参考：`architecture-and-terminology.html`（§4 双 Panel 主从 + session vs panel 对照）
- 集成点：L1 Region，Panel 挂在其内；sidebar 点 session → 本容器载入

## 7. Suggested skills（接手改稿时）
- `frontend-design`（若补工作区顶部操作栏）
- `impeccable`（四层激活标识对比度 review，opacity 0.5 校准点）
