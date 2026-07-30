# Handoff · panel · draft-breadcrumb-popovers（验收型 · 已完成 · 孤儿补录）

## 1. 路径
- 目录：`v3/panel/`
- 文件：`draft-breadcrumb-popovers.html`（✅ 已完成 · 孤儿补录）
- 层级：L2 Module · panel-header 导航组件深化（横跨 header / detail-pane）
- 上游 spec：`panel/spec.md`（panel-header 结构）+ `shell/spec.md`（traffic light）

## 2. 产物现状
- standalone，内联 CSS，冷蓝 token
- **仅分支段可点击**：L1（仓库）/ L2（工作区）为只读静态文本，只有分支段支持 popover
- **切换分支（主操作 · 卡 A/B）**：git 状态前置 · ahead/behind 预防同步坑
- **新建分支（次操作 · 卡 C）**：内联表单 · 不开新弹层
- **状态联动**：切换/新建后 main-panel 内容如何变化
- §6 决策卡：7 项待验证的最终落地（⌘B 矩阵 / tooltip / 折叠+fetch / 校验非法态）

## 3. 已做的事（回顾）
- [x] L1/L2 只读态去点击化
- [x] 分支 popover 通用规则（位置 / 动画 / 触发 / 关闭）
- [x] 切换分支卡 A/B（git 状态前置）
- [x] 新建分支卡 C（内联表单）
- [x] 状态联动设计
- [x] 7 项决策记录

## 4. 关联文档
- `panel/spec.md`（panel-header）
- `shell/spec.md`（traffic light 位置避让）

## 5. 关联 HTML
- `panel/draft-detail-pane.html`（面包屑常驻 detail-pane 顶部）
- `panel/draft-companion-zones.html`（git-zone 显示 ahead/behind）

## 6. 验收 P0
- [x] 仅分支段可点击，L1/L2 只读
- [x] 切换 / 新建分支两种 popover 形态
- [x] 7 项决策卡标注完整

## 7. suggested skills
- 无（已完成）

---

⚠️ 归属待定：本稿横跨 panel-header 与 detail-pane，未在 panel/spec 5 zone 体系中显式归位。后续若 detail-pane spec 深化，需把面包屑导航纳入 detail-pane 顶部规范。
