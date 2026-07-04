# Handoff · sidebar · session-item

## 1. 路径
- 目录：`v3/sidebar/`
- 文件：`draft-session-item.html`（★ 待做）
- 层级：L2 Module · Sidebar Session List 内单个会话项（原子单元）
- 上游：`ui-skeleton.md`（Sidebar 模块）/ 待补 `sidebar/spec.md`

## 2. 产物 HTML 规范
- standalone 单文件，内联 CSS，冷蓝 token
- 画单个 Session Item 的全部状态 + 交互，不画整个 Sidebar 容器（那是 draft-five-states）
- Session Item 是 Session List 的原子，复用于 sidebar 和 overview 卡片

## 3. 要做的事情
- [ ] 状态圆点：running / idle / done / error（与 panel-header 状态圆点一致）
- [ ] 主信息：session 标题 + 分支 pill（mono + accent）+ 最后活动时间
- [ ] 未读 / 后台 agent 活动徽标
- [ ] 激活态视觉（与 workspace 双 Panel 激活标识呼应：左侧竖条 + bg-elevated）
- [ ] 右键菜单：重命名 / 复制 / 删除（带确认）/ 归档 / 在新 Panel 打开
- [ ] 折叠子会话 / 分支节点（若有分支结构）

## 4. 关联文档
- 上游：`ui-skeleton.md`（Sidebar）/ `architecture-and-terminology.html`（Session Item 定义）
- 同层：`draft-five-states`（整体五态，本叶是其原子细化）/ `draft-file-view`（File View 兄弟子视图）
- 下游：`overview/draft-overview`（卡片信息源同 Session Item，可复用）

## 5. 关联 HTML
- 参考：`draft-five-states.html`（现有 session 项画法）/ `workspace/draft-dual-panel.html`（panel-header 状态圆点要对齐）
- 集成点：Session List 的原子单元；点击 → workspace 载入该 session 到 Panel

## 6. 验收（P0）
- [ ] 4 状态圆点齐全且与 panel-header 一致
- [ ] 激活态与 workspace 四层激活标识视觉呼应
- [ ] 右键菜单完整
- [ ] 冷蓝 token 一致，无废弃术语

## 7. Suggested skills
- `frontend-design`（状态圆点 + 右键菜单）
- `impeccable`（激活态可识别性 review）
