# Handoff · sidebar · draft-collapsed-state（验收型 · 已完成 · 孤儿补录）

## 1. 路径
- 目录：`v3-demo/sidebar/`
- 文件：`draft-collapsed-state.html`（✅ 已完成 · 孤儿补录）
- 层级：L2 Module · Sidebar 容器自身状态（与 five-states 姐妹稿）
- 上游 spec：`sidebar/spec.md`（容器定义）+ `shell/spec.md`（traffic light / 全屏态）

## 2. 产物现状
- standalone，内联 CSS，冷蓝 token
- **唤回机制三路冗余**：header 按钮 / 左缘 / 键盘，折叠态下语义重排（各司其职不冲突）
- **Header 接管 chrome**：折叠 + 非全屏时，第一个 panel header 接管 traffic light 区域
- **面板分割差异**：只有 P1 header 受影响，P2 保持原状（不复制 chrome）
- **全屏态差异**：无 traffic light（OS 自动隐藏），h-nav 仍在
- **动画时序**：320ms · `--duration-slow` · 多轨同步（折叠 / 展开 / 唤回 / 全屏切换）
- **状态保留**：折叠 / 唤回不丢上下文（tab / active session / scroll / 视图节点 / chrome 状态）

## 3. 已做的事（回顾）
- [x] 唤回三路冗余设计（不冲突）
- [x] Header 接管 chrome 触发条件（折叠 + 非全屏）
- [x] 面板分割（仅 P1 受影响）
- [x] 全屏态差异（无 traffic light）
- [x] 动画时序 320ms 多轨同步
- [x] 状态保留清单（5 项）

## 4. 关联文档
- `sidebar/spec.md`（容器折叠 / 展开）
- `shell/spec.md`（traffic light / 全屏态）

## 5. 关联 HTML
- `sidebar/draft-five-states.html`（容器五态，本稿是其折叠态深化）
- `shell/draft-overlay-states.html`（全屏态切换）

## 6. 验收 P0
- [x] 唤回三路冗余不冲突
- [x] Header 接管条件明确（折叠 + 非全屏）
- [x] 状态保留清单完整

## 7. suggested skills
- 无（已完成）

---

⚠️ 动画时序待联调：320ms（`--duration-slow`）与 shell overlay-states 的曲线是否协调，需跨稿联调确认。
