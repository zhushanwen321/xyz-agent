# Handoff · panel · detail-pane

## 1. 路径
- 目录：`v3-demo/panel/`
- 文件：`draft-detail-pane.html`（已完成）
- 层级：L2 Module · **Side Drawer 内**（Side Drawer 归 Panel 联动，非固定 zone）
- 上游 spec：`panel/spec.md`（line 54 Side Drawer 裁决 + line 88 骨架 + line 105 未决）

## 2. 产物 HTML 规范
- standalone 单文件，内联 CSS，冷蓝 token
- 画 Side Drawer 浮起态 + 内部 Detail Tab 切换
- **未决**（panel/spec line 105）：Side Drawer 浮起形态——从 Panel 内右浮 还是 整 Panel 覆盖？宽度占 Panel 多少？**本叶需裁决**
- 单 / 双 Panel 差异：单 Panel 从右滑出；双 Panel 时 panel-1 触发的从右覆盖 panel-2，panel-2 触发的从左覆盖 panel-1

## 3. 要做的事情
- [x] **裁决已落地（实现级）**：浮起形态 = workspace-body 级 absolute；单 session 关联 panel 收窄到 50% 并排、双 session 覆盖对侧 standby（dir-right/left）。⚠️ `panel/spec.md` L105「未决」措辞待回填为已裁决
- [x] Detail Tab 两类：ChangeSet Detail（变更集详情）/ SubAgent Detail（子 agent 详情）
- [x] Tab 切换动效（dd-tabs + view-toggle Diff/预览）
- [x] 空态（dd-empty）
- [x] 反向联动（L734/L780 JS 已实现：源块点击触发 drawer + 反向高亮）

## 4. 关联文档
- 上游：`panel/spec.md`（Side Drawer 归属 + 5 种 Drawer 类型）/ `architecture-and-terminology.html`（Side Drawer 定义）
- 同层：`draft-message-stream`（file-changes 块 → ChangeSet Detail；subagent → SubAgent Detail）/ `draft-companion-zones`（git Diff 入口 → 本叶）
- 下游：`flows/flow-3-subagent`（SubAgent Detail 是子 agent 编排的呈现位）

## 5. 关联 HTML
- 参考：`draft-message-stream.html`（file-changes / subagent 块，跳转源样式要对齐）/ `workspace/draft-dual-panel.html`（Drawer 现有画法）
- 集成点：从 Panel 内浮起；最终在 `panel/spec.md` Side Drawer 段落描述

## 6. 验收（P0）
- [x] 浮起形态已裁决并落地（workspace-body 级 absolute，单/双 session 方向正确）
- [x] ChangeSet Detail + SubAgent Detail 两 Tab 完整
- [x] 反向联动（源块高亮）能演示
- [x] 单 / 双 Panel 下方向正确（dir-right/left，单 session 收窄并排）

## 7. Suggested skills
- `frontend-design`（Drawer 浮起 + Tab 切换动效）
- `impeccable`（反向联动可见性 review）
- `recursive-skeleton`（裁决未决项前置）
