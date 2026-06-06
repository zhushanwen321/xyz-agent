---
verdict: pass
---

# Non-Functional Design — Chat Area 第一轮优化

> 覆盖五个非功能维度的设计决策。本 spec 主要涉及 UI/store/WS 协议扩展，深度有限。

## 1. 稳定性

**影响面**: 9 项功能中 8 项为纯前端 UI/状态管理改动，1 项涉及 WS 协议扩展（`message.steer` / `message.follow_up`），1 项涉及 `session-service.ts` 的 fork/clone 命名修改。

**风险缓解**:
- WS 协议扩展采用**新增类型**而非修改已有类型，旧客户端/旧 sidecar 仍能工作（`message.send` 路径不变）。新 client 与旧 sidecar 组合时，`message.steer` 会被静默忽略（需在协议版本协商时做警告日志）
- Fork/Clone 命名后端改动是**纯增量**——在 `rebindAfterFork` 内部追加 label 拼接逻辑，不影响 `forkFromEntry` / `cloneSession` 的返回值结构
- Utility rail 布局调整（`PanelBody` flex 结构）需要回归验证：分屏模式 / 不同窗口大小 / macOS 全屏三种场景
- macOS fullscreen 检测新增 IPC 通道，需验证主进程 preload 暴露的 API 与渲染进程的订阅路径

## 2. 数据一致性

**影响面**: 仅影响 session label 的命名（Fork/Clone 后缀），不涉及核心数据结构。

**并发控制**:
- Fork/Clone 是单 session 操作，pi 的 session 文件写入本身已有延迟写入机制（CLAUDE.md §6），无需额外锁
- 新 session 创建后立即写入 `rebindAfterFork` 修改后的 label；后续的 session 列表读取会一致
- 批量复制在前端一次性写入剪贴板，无并发问题
- 分支指示器的数据源是 `stores/tree.ts` 的 `getActivePath()`（只读快照），不引入新的状态写入

**YAML 字段安全性**: 本次不修改 YAML frontmatter 相关代码（属于 settings 模块，不在本 spec 范围）。

## 3. 性能

**影响面**: 主要在 UI 渲染层。

**评估**:
- 消息操作菜单 (`MessageActionMenu`)：单消息 hover 渲染，影响范围 < 1 message，O(1) 开销
- 批量选择浮动栏：sticky 定位，sticky bar 自身渲染开销可忽略；批量复制使用 `collectMessageContent` 遍历选中消息（O(n)，n = 选中数）
- 分支指示器 dropdown：仅在 children > 1 时渲染，O(1) per message
- Utility rail：panel 级单实例，3 个图标 + 2 个滚动按钮，O(1) 渲染
- 分支 pill 计算 children 数：基于 `stores/tree.ts` 的现有数据结构，O(1) per message（children 字段已存在）
- 滚动按钮可见性切换：依赖 `scrollHeight - scrollTop - clientHeight` 的 scroll 事件触发，需要节流（建议 16ms / 一帧）

**滚动事件节流**: rail 的 scroll 监听使用 `requestAnimationFrame` 节流，避免滚动卡顿。

## 4. 业务安全

**影响面**: 本 spec 不涉及 AI 行为指令（skill 文件）修改。

**说明**: 不适用。9 项功能均为 UI/交互/后端命名修改，不涉及 pi agent 的行为控制。

## 5. 数据安全

**影响面**: 复制消息写入剪贴板是一个**用户主动**的本地操作。

**权限控制**:
- 剪贴板写入由 `navigator.clipboard.writeText()` 完成，需要 HTTPS 或 localhost 环境（Electron dev/build 默认满足）
- 复制内容**仅本地**保存，不发送任何后端
- Fork/Clone 操作不涉及敏感信息外泄：新 session 是本地 session 文件复制
- macOS fullscreen 切换是**纯本地** UI 状态变化

**风险点**:
- 批量复制时如果选中 N 条长消息，剪贴板内容可能很大（KB-MB 级），需在 UI 上提示「即将复制大段内容」或限制最大选数（建议：选 ≤ 100 条时无提示，> 100 条时 Toast 警告）
- `collectMessageContent` 拼接时使用模板字符串（见 spec FR3 的输出格式），需注意 XSS 风险——但因为输出到剪贴板（纯文本），不进入 DOM，XSS 风险为 0

## 总结

本 spec 的非功能风险集中在 3 个点：
1. **WS 协议扩展的向后兼容**（通过新增类型而非修改缓解）
2. **PanelBody 布局变更的回归覆盖**（分屏/全屏/不同窗口尺寸）
3. **滚动事件性能**（节流处理）

其余维度（数据一致性、业务安全、数据安全）风险较低。
