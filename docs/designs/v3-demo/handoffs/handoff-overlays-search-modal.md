# Handoff · overlays · search-modal

## 1. 路径
- 目录：`v3-demo/overlays/`（★ 目录待建）
- 文件：`draft-search-modal.html`（★ 待做）
- 层级：L0 Shell · Overlay 级（浮在所有 Region 之上，**不归属 Sidebar**）
- 上游：`shell/spec.md`（⌘K 全局快捷键 + sidebar nav `.a-kbd` 提示）/ `architecture-and-terminology.html`（Search Modal 归 Overlay）

## 2. 产物 HTML 规范
- standalone 单文件，内联 CSS，冷蓝 token
- ⌘K（mac）/ Ctrl+K（win/linux）唤起，居中浮层，Esc 关闭
- **来源**：从 `sidebar/draft-five-states.html` 卡 D 移出（术语裁决：搜索 modal 归 Overlay 非 Sidebar）

## 3. 要做的事情
- [ ] 唤起：⌘K / Ctrl+K，居中 modal + 背景遮罩
- [ ] 多类搜索：命令 / 文件 / 符号 / 会话，分组展示
- [ ] 最近项（recents）默认展示
- [ ] 键盘导航：↑↓ 选择 / Enter 确认 / Esc 关闭 / Tab 切类
- [ ] 匹配高亮（查询词在结果中高亮）
- [ ] 空结果态 / 加载态

## 4. 关联文档
- 上游：`shell/spec.md`（第七节实现要点 ⑤ 全局快捷键 ⌘N/⌘K）/ `architecture-and-terminology.html`（§1 Search Modal 定义，归 Overlay）
- 同层：`sidebar/draft-five-states`（搜索 modal 原出处，移出后该稿需删卡 D）
- 下游：`overview/draft-overview`（搜索会话结果可跳 Overview）

## 5. 关联 HTML
- 参考：`sidebar/draft-five-states.html`（卡 D 现有搜索 modal 画法，迁移基础）
- 集成点：全局 Overlay，z-index 最高，浮在 Sidebar/Workspace 之上；结果跳转 → 对应 Region

## 6. 验收（P0）
- [ ] ⌘K/Ctrl+K 唤起 + Esc 关闭
- [ ] 命令/文件/符号/会话四类分组
- [ ] 键盘导航完整（↑↓/Enter/Esc/Tab）
- [ ] 与 Sidebar File View 内搜索严格区分（全局 vs 文件树过滤）
- [ ] 冷蓝 token 一致

## 7. Suggested skills
- `frontend-design`（modal + 键盘导航 + 分组布局）
- `impeccable`（匹配高亮 + 空态 review）
