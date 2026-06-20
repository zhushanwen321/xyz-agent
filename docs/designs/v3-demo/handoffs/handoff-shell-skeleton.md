# Handoff · shell · draft-skeleton（验收型 · 已完成）

## 1. 路径
- 目录：`v3-demo/shell/`
- 文件：`draft-skeleton.html`（✅ 已完成）
- 层级：L0 Shell（窗口分区骨架，最顶层）
- 上游 spec：`shell/spec.md`（第一节核心拓扑 + 三层语义）

## 2. 产物现状
- standalone，内联 CSS，冷蓝 token（`bg-base #0d0d0f` / `bg-panel` / accent-ring）
- **三层语义已落地**：base 平铺全屏 → sidebar 透明融合（无 background，继承 base）→ main 是唯一 float-panel（bg-panel + border + radius:12px + shadow）
- app-shell `flex p-3 gap-3`；aside-region `width 200px` + `padding-top:52px`（traffic light 安全区）
- 定位：静态拓扑骨架稿，不含动态两态（那是 draft-overlay-states 的职责）

## 3. 已做的事（回顾）
- [x] 三层视觉语义（base / sidebar 透明 / main 浮起）
- [x] 52px 安全区（三平台统一）
- [x] sidebar 无 background（透明融合，命门）

## 4. 验收（回顾 · 若改动需重过）
- [x] main 是**唯一**带 background/border/shadow 的面板（靠属性浮起，不靠 z-index）
- [x] sidebar 无 background（继承 base）
- [ ] ⚠️ **未决**（shell/spec line 末「待验证」）：收起侧栏后的折叠态布局（logo 是否保留 / 折叠宽度 / 展开手势）——属 L2 模块 deepening，本稿不含

## 5. 关联文档
- 上游：`shell/spec.md`（拓扑 + 三层语义 + 安全区尺寸表第三节）
- 同层：`draft-overlay-states`（兄弟稿，画两态 + 跨平台，互补不重叠）
- 下游：所有 Region（sidebar / workspace / panel 都嵌在这个拓扑里）

## 6. 关联 HTML
- 参考：`architecture-and-terminology.html`（§2 L0→L2 架构盒模型，拓扑来源）
- 集成点：L0 Shell 骨架，所有 Region 挂在其内

## 7. Suggested skills（接手改稿时）
- `frontend-design`（若补折叠态布局）
- `impeccable`（三层语义对比度 review）
