# Chat Area 设计改进方案

基于 impeccable `critique` → `layout` / `shape` / `distill` / `clarify` 四个子命令的设计分析与用户确认。

## 1. Message Turn 布局

**问题**: 用户气泡、ThinkingBlock、ToolCallCard、SystemNotification 四种组件使用几乎相同的背景色 (L=97-98%)、相同的 1px border-radius、相同的渐变 header，视觉层次极弱。

**选定方案: B. Turn 分组 + 细分割线**

每轮对话 (用户+助手) 作为一个视觉单元，内部用 1px `border-left` 分区，缩进 12px。Thinking / Tool / Text 三级通过彩色圆点 + 标签区分。

- 助手内容区块按类型分组: Thinking 区 → Tool 调用区 → 文本区
- 每区用 1px `border-left: 1px solid var(--border)` + `padding-left: 12px` 缩进
- 区标签用 10px 文字 + 4px 彩色圆点 (thinking=accent, tool=success, text=agent)
- Turn 之间用 `border-top: 1px solid var(--border)` + `padding: 12px 0` 分隔

> **注**: Turn 分组的完整实现还未在 MessageBubble/ChatPanel 中落地，当前改动先聚焦其他三项。

**Demo**: [01-layout-message-turn.html](01-layout-message-turn.html)

---

## 2. Chat Outline 浮动迷你目录

**问题**: 长对话 (50+ 条消息) 中用户无法快速定位内容。

**选定方案: B. 浮动迷你目录 (可收起/展开)**

- 组件: `ChatOutline.vue`
- 位置: 聊天区域右上角，`position: absolute`，`z-index: 20`
- 收起态: 仅显示一个 26x26 的 hamburger 按钮
- 展开态: 160px 宽的浮动面板，列出每条消息的摘要
- 每条消息显示: 4px 彩色圆点 + 截断标签 (最长 28 字符)
- 颜色区分: user=accent, assistant=agent, done=success, alert=danger, warning=warning, info=agent
- 底部显示进度条 (完成数/总数)
- 阈值: `messages.length > 3` 时才显示

**Split Panel 兼容**: ChatOutline 放在 `chatMsgsRef` div 内部 (该 div 有 `position: relative`)，每个 panel 有自己独立的 outline 实例。

**Demo**: [02-shape-chat-outline.html](02-shape-chat-outline.html)

---

## 3. Skill Header 精简

**问题**: 独立的左边线卡片占用垂直空间，"加载 Skill:" 文字冗余，展开内容与气泡同级导致视觉混乱。

**选定方案: Codex 风格内联 Link + Panel 级全屏抽屉**

### Skill Link (嵌入气泡内)

- 移除独立的 `skill-header` 卡片
- Skill 名称以可点击 link 形式嵌入用户消息气泡文本开头
- 样式: `display: inline-flex`, accent 色, mono 字体, 11px, 600 weight, 带下划线
- 激活态: accent 背景色 + 白色文字 + 1px 圆角 (类似高亮标记)
- 点击后 emit `open-skill` 事件给父组件

### Skill Drawer (Panel 级)

- 组件: `SkillDrawer.vue`
- 位置: `position: absolute; inset: 0` 在 chat-content div 内部，覆盖整个聊天区域
- 行为: 点击 link 后抽屉从右侧滑入，占满整个 panel 宽度
- 内容: Markdown 渲染的 SKILL.md 文件内容
- 关闭: 点击 backdrop 或 ESC 键
- `z-index: 30` (抽屉) / `z-index: 29` (backdrop)

**Split Panel 兼容**: SkillDrawer 放在 chat-content div 内部 (有 `position: relative`)，左右 panel 各自独立。

**Demo (迭代过程)**:
- [03-distill-skill-header.html](03-distill-skill-header.html) — 初始三方案对比
- [03-distill-skill-header-v2.html](03-distill-skill-header-v2.html) — Codex 风格 + 全局抽屉
- [03-distill-skill-header-v3.html](03-distill-skill-header-v3.html) — 最终确认: Panel 级抽屉 (Split Panel 兼容)

---

## 4. System Notification 区分度

**问题**: 当前 `done` 和 `info` 类型使用完全相同的绿色圆点+浅绿背景，无法区分。`warning` 类型缺失。

**选定方案: B. 内联状态行 + 图标**

- 组件: `SystemNotification.vue` (重写)
- 从 "全宽横幅" 改为 "单行内联状态行"
- 高度从 ~40px 降到 ~24px
- 每种类型有独立 SVG 图标:
  - `done`: 绿色圆圈 + 对勾
  - `alert`: 红色圆圈 + 感叹号
  - `warning`: 黄色三角 + 感叹号
  - `info`: agent 蓝色圆圈 + 时钟
- 背景色和文字色按类型统一
- description 以 `· ` 前缀拼在标题后面
- action label 用 underline 样式

**Demo**: [04-clarify-system-notifications.html](04-clarify-system-notifications.html)

---

## 改动文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `components/chat/SystemNotification.vue` | 重写 | 横幅 → 内联状态行 + 图标 |
| `components/chat/MessageBubble.vue` | 修改 | skill-header → skill-link + emit open-skill |
| `components/chat/ChatOutline.vue` | 新增 | 浮动迷你目录 |
| `components/chat/SkillDrawer.vue` | 新增 | Panel 级全屏抽屉 |
| `components/panel/ChatPanel.vue` | 修改 | 整合 ChatOutline + SkillDrawer + scrollToMessage |

## 待办

- [ ] Message Turn 分组布局的完整实现 (方案 B: 细分割线 + 缩进分组)
- [ ] MessageBubble 中的残留模板代码清理 (lines 155-162 有重复的旧气泡代码)
- [ ] ChatOutline 的 activeIndex 跟随滚动位置自动更新
- [ ] SkillDrawer 中的 event-bus listener 在组件卸载时未 off (内存泄漏风险)
