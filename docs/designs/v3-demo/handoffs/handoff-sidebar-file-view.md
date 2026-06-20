# Handoff · sidebar · file-view

## 1. 路径
- 目录：`v3-demo/sidebar/`
- 文件：`draft-file-view.html`（★ 待做）
- 层级：L2 Module · Sidebar File View 子视图
- 上游：`ui-skeleton.md`（Sidebar 模块）/ 待补 `sidebar/spec.md`

## 2. 产物 HTML 规范
- standalone 单文件，内联 CSS，冷蓝 token
- 画 File View 子视图（文件树 + git 标注），不画整个 Sidebar 容器
- **与 overlays/search-modal 严格区分**：File View 内搜索 = 文件树过滤；⌘K = 全局命令/文件/符号搜索（Overlay）。两者不混

## 3. 要做的事情
- [ ] 文件树：目录折叠 + 文件层级 + 当前编辑文件高亮
- [ ] git 状态标注：M（修改）/ A（新增）/ D（删除）/ 冲突，颜色对齐 git-zone
- [ ] 文件操作：新建 / 重命名 / 删除（右键或工具按钮）
- [ ] 文件树内过滤搜索框（实时过滤，非全局 ⌘K）
- [ ] 与 message-stream file-changes 块联动：点文件 → 可跳 Panel 高亮

## 4. 关联文档
- 上游：`ui-skeleton.md`（Sidebar）/ `architecture-and-terminology.html`（File View 定义）
- 同层：`draft-five-states`（File View 是 Sidebar 子视图）/ `draft-session-item`（兄弟子视图）
- 下游：`panel/draft-companion-zones`（git-zone 文件列表与本视图同源）/ `panel/draft-message-stream`（file-changes 块关联）

## 5. 关联 HTML
- 参考：`draft-five-states.html`（卡 B 文件视图现有画法）/ `workspace/draft-dual-panel.html`（git-zone 文件标注样式）
- 集成点：Sidebar File View 子视图，与 Session List 通过 tab/切换共存于 Sidebar 容器

## 6. 验收（P0）
- [ ] 文件树 + git 4 标注齐全
- [ ] 当前编辑文件高亮
- [ ] 内搜索是文件树过滤（非 ⌘K 全局搜索），两者不混
- [ ] 冷蓝 token 一致

## 7. Suggested skills
- `frontend-design`（文件树 + git 标注）
- `impeccable`（信息密度 review）
