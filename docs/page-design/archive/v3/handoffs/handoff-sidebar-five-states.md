# Handoff · sidebar · draft-five-states（需改型 · 待修订）

## 1. 路径
- 目录：`v3/sidebar/`
- 文件：`draft-five-states.html`（⚠️ 已存在，需修订）
- 层级：L2 Module · Sidebar 容器（含 Session List / File View 子视图）整体五态
- **⚠️ 无 spec.md**（孤儿）——本 handoff 是 sidebar 单元当前唯一规范载体，修订时建议顺手补 spec

## 2. 产物现状 + 待改
- standalone，内联 CSS，冷蓝 token
- 现状标题：「Sidebar 深化 · 会话列表 IA + 文件视图 + 五态」（卡 A-E）
- **必须改**（术语裁决，architecture-and-terminology §1）：
  - **搜索 modal（卡 D）移出** → 迁到 `overlays/draft-search-modal.html`（⌘K 归 Overlay 级，浮在 Sidebar 之上，不归属 Sidebar）
  - **Sidebar 当容器**（非单一列表）——含 Session List / File View 两个子视图，术语从「会话列表视图」改 Sidebar

## 3. 要做的事情（修订）
- [ ] 卡 D 搜索 modal 移出，本稿只留 Sidebar 容器内的子视图（Session List / File View）+ 五态
- [ ] 五态重命名对齐术语：A 会话列表 / B 文件视图 / C（待定）/ D（原搜索 modal 位置改为空或合并）/ E
- [ ] Sidebar 作为容器的视图切换机制（Session List ↔ File View tab/切换）
- [ ] 术语全文校正：左 aside / 会话列表视图 → **Sidebar**

## 4. 关联文档
- 上游：`ui-skeleton.md`（line 40+ Sidebar 模块定义）/ `architecture-and-terminology.html`（§1 术语 + §3 sidebar 五态）
- 同层：`draft-session-item`（Session List 原子）/ `draft-file-view`（File View 子视图）
- 下游：移出的搜索 modal → `overlays/draft-search-modal`

## 5. 关联 HTML
- 参考：`workspace/draft-dual-panel.html`（Sidebar 在双 Panel 下的表现）
- 集成点：Sidebar 容器，挂在 shell aside-region（padding-top:52px 安全区下）

## 6. 验收（P0 · 修订后）
- [ ] 搜索 modal 已移出，本稿无 ⌘K 内容
- [ ] Sidebar 作容器（Session List + File View 两子视图切换明确）
- [ ] 无废弃术语（左 aside / 会话列表视图）
- [ ] 补 `sidebar/spec.md`（孤儿收口）

## 7. Suggested skills
- `frontend-design`（子视图切换机制）
- `impeccable`（五态信息密度 review）
- `recursive-skeleton`（先补 spec 再改稿）
