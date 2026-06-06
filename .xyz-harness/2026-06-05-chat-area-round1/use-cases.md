---
verdict: pass
---

# Use Cases — Chat Area 第一轮优化

> 从 spec.md 的功能描述和 Acceptance Criteria 提取并细化的业务用例。

## UC-1: 用户复制单条消息（含 thinking + tool call）

- **Actor**: 终端用户
- **Preconditions**: 会话至少有一条 user 或 assistant 消息；浏览器剪贴板 API 可用
- **Main Flow**:
  1. 用户 hover 某条消息，右上角（或左侧，对齐规则见 FR1）出现 `⋯` 按钮
  2. 用户点击 `⋯`，弹出操作菜单
  3. 用户点击「复制」菜单项
  4. 前端调用 `collectMessageContent(messageEl)` 收集 thinking/tool call/正文
  5. 前端调用 `navigator.clipboard.writeText(markdown)`
  6. Toast 提示「已复制」，1.5s 后自动消失
- **Alternative Paths**:
  - A1: 用户点击「复制纯文本」→ 收集后 strip markdown 符号（`# * [ ]` 等）→ 写入剪贴板
  - A2: 剪贴板写入失败（权限被拒）→ Toast 显示「复制失败，请重试」
  - A3: 用户按 Esc 或点击菜单外区域 → 菜单关闭，不复制
- **Postconditions**: 剪贴板包含 markdown 源码（或纯文本）；Toast 已显示并自动消失
- **Module Boundaries**: 仅前端，无后端交互

## UC-2: 用户进入批量选择模式并复制多条

- **Actor**: 终端用户
- **Preconditions**: 当前 panel 有 ≥1 条消息
- **Main Flow**:
  1. 用户点击 panel header 的 `≡` 按钮
  2. 进入选择模式：所有消息左侧出现 hover 显现的 checkbox
  3. 用户点击消息切换选中状态（视觉：outline + accent 边框 + ✓ 标记）
  4. 顶部 sticky 浮动栏实时显示「已选 N 条消息」
  5. 用户点击「复制 Markdown」或「复制纯文本」
  6. 系统按指定格式拼接所有选中消息的内容：
     ```
     --- 助手 14:23 ---
     [Thinking: ...]
     [Tool: read ✓ src/file.ts]
     消息正文...
     ```
  7. 写入剪贴板，Toast 反馈
  8. 自动退出选择模式（或用户点击「取消」）
- **Alternative Paths**:
  - A1: 用户再次点击已选消息 → 取消选中，浮动栏计数 -1
  - A2: 用户在 0 条选中时点击复制按钮 → 按钮 disabled
  - A3: 复制失败 → Toast 错误提示，保留选择状态
- **Postconditions**: 剪贴板包含拼接后的多消息内容
- **Module Boundaries**: 仅前端

## UC-3: 用户浏览分支并导航

- **Actor**: 终端用户
- **Preconditions**: 当前消息 entry 存在分支（`children > 1`）
- **Main Flow**:
  1. 用户在消息气泡底部看到分支 pill（实色，显示分支数 N）
  2. 用户点击 pill，展开分支列表 dropdown
  3. dropdown 列出所有分支，每项显示状态圆点 + 分支名
  4. 当前活跃分支高亮（accent 色 + active 标记）
  5. 用户点击非活跃分支
  6. 系统调用 `navigateToEntry(targetEntryId)`，触发 store 切换
  7. 视图更新为新分支，dropdown 关闭
- **Alternative Paths**:
  - A1: 当前消息无分支（children ≤ 1）→ 显示半透明 `1` pill，不可点击
  - A2: 用户点击 dropdown 外部 → dropdown 关闭
  - A3: 用户点击当前活跃分支 → 不发生导航，仅关闭 dropdown
- **Postconditions**: 当前 entry 切换到目标分支；UI 反映新分支的内容
- **Module Boundaries**: 前端 → 调用 `stores/tree.ts` 的 navigate 接口（已存在），无新后端交互

## UC-4: 用户使用 Utility Rail 滚动导航

- **Actor**: 终端用户
- **Preconditions**: panel 处于聊天视图（不是 empty panel）
- **Main Flow**:
  1. 用户看到 panel 右侧 36px 的 utility rail（默认不可见，panel hover 时显现）
  2. 当 panel 滚动超过 40px 时，「↓ 回到底部」按钮变为可见
  3. 当距离底部超过 40px 时，「↑ 回到顶端」按钮变为可见
  4. 用户点击「↓ 回到底部」→ 平滑滚动到消息列表底部
  5. 用户点击「↑ 回到顶端」→ 平滑滚动到顶端
- **Alternative Paths**:
  - A1: 在顶端位置 → 「↑ 回到顶端」隐藏
  - A2: 在底端位置 → 「↓ 回到底部」隐藏
  - A3: 分屏模式下每个 panel 有独立的 rail
- **Postconditions**: 消息列表滚动到对应位置
- **Module Boundaries**: 仅前端，layout 结构调整（`PanelBody` 改为 flex row 包含 rail）

## UC-5: 用户折叠/展开侧边栏

- **Actor**: 终端用户
- **Preconditions**: 侧边栏当前可见或折叠
- **Main Flow**:
  1a. 侧边栏可见时，用户 hover 右边缘手柄 → 手柄高亮
  1b. 侧边栏可见时，用户点击 header 右上角 `◀` 按钮
  1c. 侧边栏折叠时，用户点击左边缘 `▸` 按钮
  2. 侧边栏 width 过渡到 0（`transition: width 0.2s ease`），border-right 消失
  3. 若是从展开 → 折叠，左边缘出现 `▸` 按钮
  4. 若是从折叠 → 展开，sidebar 恢复原始宽度
- **Alternative Paths**:
  - A1: 动画过程中用户再次点击 → 中断当前过渡，开始反向过渡
- **Postconditions**: sidebar 处于目标状态（折叠/展开），动画流畅
- **Module Boundaries**: 仅前端，store 中可能新增 `sidebarCollapsed` 状态

## UC-6: 用户在 macOS 全屏模式使用应用

- **Actor**: 终端用户（macOS）
- **Preconditions**: Electron 窗口可全屏
- **Main Flow**:
  1. 用户触发 macOS 全屏（绿色按钮 / 快捷键）
  2. Electron 主进程发出 `enter-full-screen` 事件
  3. 前端通过 IPC/preload 接收事件，给 `body` 或 root 元素加 `isFullscreen` class
  4. 布局切换为全屏模式：
     - 品牌标识从 Row2 上移到 Row1
     - `+ New Session` 按钮变为 `width: 100%` 通栏
     - Row1 移除 `padding-left: 68px`
  5. 退出全屏时反向切换
- **Alternative Paths**:
  - A1: 非 macOS 平台 → 不响应 fullscreen 变化（仅 macOS 触发）
  - A2: Windows/Linux 全屏时 `isFullscreen` class 不生效（不影响功能，layout 兼容即可）
- **Postconditions**: 全屏状态切换流畅，无布局抖动
- **Module Boundaries**: 前端 + Electron 主进程 IPC（preload 暴露 fullscreen 状态）

## UC-7: 用户在 AI 流式输出时插入新消息（Steer 模式）

- **Actor**: 终端用户
- **Preconditions**: AI 正在流式输出（`isGenerating === true`）
- **Main Flow**:
  1. 用户在 textarea 中输入新消息
  2. 输入框上方 20px 状态栏显示 `Steer · 将中断当前 AI 处理`（accent 色）
  3. 用户按 Enter
  4. 前端发送 `message.steer` RPC（sessionId + content）
  5. sidecar/server 接收后中断当前 AI 处理流程，发送新消息
  6. 发送按钮变红色 ■（stop 图标）
- **Alternative Paths**:
  - A1: 用户按住 Alt 键 → 状态栏切换为 `Queue · Alt+Enter 排队`（warning 色）
  - A2: 用户按 Alt+Enter → 发送 `message.follow_up` 排队
  - A3: AI 不在生成中 → 状态栏为 `Send · Enter 发送`（灰色），发送 `message.send`
- **Postconditions**: 新消息按当前模式正确发送（中断或排队）
- **Module Boundaries**: 前端 + WS 协议扩展（新增 `message.steer` 和 `message.follow_up`）+ sidecar/server 处理

## UC-8: 用户从某 entry Fork 出新会话

- **Actor**: 终端用户
- **Preconditions**: 当前 panel 至少有 1 条消息
- **Main Flow**:
  1. 用户 hover 消息，点击 `⋯` → 操作菜单
  2. 用户点击「Fork」
  3. 前端调用后端 `tree-service.forkFromEntry(sessionId, entryId)`
  4. 后端创建新 session，新 session label = `${原名称}-fork`
  5. 前端接收新 sessionId，跳转到新 session 视图
- **Alternative Paths**:
  - A1: 用户点击「Clone」→ 后端调用 `tree-service.cloneSession(sessionId)`，label = `${原名称}-clone`
- **Postconditions**: 新 session 在 session 列表中显示，名为 `原名称-fork` 或 `原名称-clone`
- **Module Boundaries**: 前端 → runtime `tree-service.ts`（已存在，需修改）→ `session-service.ts`（已存在，需修改 `rebindAfterFork` 接收 label 参数）

## 覆盖映射表

| UC | 覆盖的 spec AC |
|----|----------------|
| UC-1 | AC1, AC2 |
| UC-2 | AC3, AC4 |
| UC-3 | AC5 |
| UC-4 | AC6, AC7, AC12 |
| UC-5 | AC8 |
| UC-6 | AC9 |
| UC-7 | AC11 |
| UC-8 | AC10 |
