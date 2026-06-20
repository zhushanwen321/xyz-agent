# 未实现功能规划

> ⚠️ **已过时（2026-06-20）**：本清单基于 2026-05-17 状态。v3 重建后部分项已落地或调整，路径中的 `sidecar/` 已重命名为 `runtime/`。最新规划见 [feature-map/2026-06-20.md §四](../feature-map/2026-06-20.md)。保留作历史参考。


基于 2026-05-17 项目实际状态，从"日常使用的 coding agent 工具"视角重新梳理。

> **最高优先级的 4 项功能已移至 [features-top-priority.md](./features-top-priority.md)**：
> 生产构建、Markdown 渲染优化、文件变更总览 + Diff、Session Tree 对接

不沿用原始 P1-P6 分期。按"用户为什么选择用 GUI 而不是直接跑 CLI"这个问题重新排列优先级。

GUI 侧的核心职责：**让用户高效地给 agent 上下文、审查 agent 的产出、管理 agent 的行为**。

---

## 优先级定义

| 级别 | 含义 |
|------|------|
| **P1** | 没有这些功能，用一周后会明显感到"还差一点" |
| **P2** | 做到后体验显著提升 |
| **P3** | 锦上添花，差异化竞争力 |

---

## P1 — 从"能用"到"好用"

### 1. @-mention 文件引用

**问题**：开发者最常见的操作是"你看看这个文件"。当前只能文字描述路径，agent 自己去找。Claude Code 的 `@file` 功能可能是使用频率最高的交互之一。

**功能描述**：

- `@` 触发文件搜索浮层，模糊匹配项目文件
- 选择后插入文件路径（带特殊标记），agent 收到消息时自动将文件内容加入上下文
- 支持引用目录（`@src/auth/` → 将目录结构和所有文件摘要加入上下文）
- 支持引用 URL（`@https://...` → 抓取网页内容加入上下文）
- 拖拽文件/文件夹到输入区，自动转为路径引用

**设计要点**：

- 文件搜索由 Sidecar 提供（`file.search` WS 命令，基于项目 cwd 的文件索引）
- 前端只负责 UI 交互和路径插入
- 消息格式扩展：`message.send` 的 payload 中增加 `attachments: [{ type: 'file', path: '...' }]`
- 输入区需要支持 inline decoration（类似 VS Code 的 inline suggestion）

**涉及文件**：
- 新增：`renderer/src/components/chat/FileMention.vue` — 文件搜索浮层
- 修改：`renderer/src/components/chat/ChatInput.vue` — @ 触发 + 拖拽处理
- 新增：`sidecar/src/file-search.ts` — 项目文件索引与搜索
- 修改：`sidecar/src/server.ts` — 新增 `file.search` 路由
- 修改：`shared/src/protocol.ts` — 新增 `file.search` / `file.searchResult` 类型

### 2. Command Palette（Cmd+K / Cmd+P）

**问题**：开发者是键盘驱动的。当前只有少数快捷键（Cmd+1/3/,），大量操作需要鼠标。需要所有功能都能通过键盘两三步触达。

**功能描述**：

- `Cmd+K` 打开全局 Command Palette
- 模糊搜索执行：切换 session、搜索历史对话、执行 slash 命令、切换模型、切换主题、打开设置
- 最近使用记录（MRU）
- 支持嵌套命令（`>session.new` 创建新 session）

**设计要点**：

- 参考 VS Code 的 Command Palette 交互模式
- 命令注册表可以复用 SlashCommand 的模式
- 搜索项包含：命令、session、最近文件、设置项

**涉及文件**：
- 新增：`renderer/src/components/layout/CommandPalette.vue`
- 新增：`renderer/src/composables/useCommandPalette.ts`
- 修改：`renderer/src/main.ts` — 注册全局快捷键

### 3. 交互式终端输出

**问题**：BashToolRenderer 是纯 `<pre>` 文本展示。`npm run dev`、`npm test` 等命令的输出包含 ANSI 颜色、进度条、实时更新，当前全部丢失。

**功能描述**：

- **ANSI 颜色渲染**：将 ANSI escape sequence 转为 HTML 颜色（或集成 xterm.js）
- **长输出折叠**：超过 N 行的输出默认折叠，只显示前几行 + 最后几行 + 退出码
- **运行中进程指示**：`npm run dev` 等持续运行的进程，明确显示"仍在运行"，提供终止按钮
- **错误高亮**：退出码非 0 时，错误行用 danger 色高亮

**设计要点**：

- 轻量方案：`ansi-to-html` 库转换 ANSI 序列，不需要完整的 xterm.js
- 输出量控制：Sidecar 侧限制单次 tool call 输出的最大行数（如 500 行），超出截断并提示
- 运行中状态：`message.tool_call_start` 到 `message.tool_call_end` 之间的时间如果超过 5s，显示"运行中"指示器

**涉及文件**：
- 修改：`renderer/src/components/chat/ToolRenderers/BashToolRenderer.vue`
- 新增：`renderer/src/lib/ansi-render.ts` — ANSI 转换工具
- 修改：`sidecar/src/event-adapter.ts` — 限制输出长度

### 4. 系统通知

**问题**：长任务（如"重构 auth 模块"）可能跑 5-10 分钟。用户切换到其他窗口后，不知道任务何时完成。

**功能描述**：

- **macOS 系统通知**：Agent 任务完成、遇到错误、需要审批时发送系统通知
- **Dock 图标角标**：有未读消息时显示数字角标
- **声音提示**：任务完成时播放短提示音（可配置开关）
- **通知偏好**：在 SystemPane 中配置哪些事件触发通知

**设计要点**：

- Electron 主进程通过 `Notification` API 发送系统通知
- 渲染进程通过 IPC 通知主进程发送通知
- 审批请求（tool_call_pending）的通知优先级最高

**涉及文件**：
- 新增：`main/notifications.ts` — 通知管理
- 修改：`preload/preload.ts` — 暴露通知 API
- 修改：`renderer/src/composables/useChat.ts` — 关键事件触发通知
- 修改：`renderer/src/components/settings/SystemPane.vue` — 通知偏好

### 5. 项目级上下文自动注入

**问题**：原始 P1 规划中的 `project-context.ts` 未实现。Session 创建时不会自动读取项目根目录的 CLAUDE.md / xyz-agent.md，agent 对项目规范一无所知。

**功能描述**：

- Session 创建时（`session.create`），Sidecar 自动读取项目根目录下的 `CLAUDE.md` → `xyz-agent.md` → `.claude/CLAUDE.md`
- 将内容注入到 pi 进程的系统上下文中
- 内容截断到 10K 字符
- 如果文件更新，下次发消息时重新读取

**设计要点**：

- pi RPC 模式下，可以通过 `prompt` 命令发送系统消息，或通过 `--system-context` 参数注入
- 读取时机：session 创建时 + 每次发消息前检测文件是否变更

**涉及文件**：
- 新增：`sidecar/src/project-context.ts`
- 修改：`sidecar/src/session-pool.ts` — 创建 session 后注入项目上下文
- 修改：`sidecar/src/config-store.ts` — 项目上下文缓存

---

## P2 — 体验显著提升

### 6. Context 可视化与管理

**问题**：有 ContextBar 显示百分比，但用户看不到 agent 实际"知道"什么。高级用户最关心的是控制 agent 的视野。

**功能描述**：

- **Context 组成列表**：显示当前上下文窗口的组成（系统 prompt、CLAUDE.md、对话历史、已读文件列表）及各部分的 token 占比
- **手动管理**：用户可以主动从 context 中移除不相关的历史消息
- **Token 预算可视化**：饼图或条形图展示系统 prompt / 项目上下文 / 对话历史 / 工具输出各占多少

**设计要点**：

- 需要 pi 侧提供 context 组成的详细信息（当前只有 usagePercent）
- 可以在 DrawerRight 中展示

**涉及文件**：
- 新增：`renderer/src/components/drawer/ContextBreakdown.vue`
- 修改：`sidecar/src/event-adapter.ts` — 扩展 `context.update` 的 payload

### 7. 项目文件树 + Git 状态

**问题**：在编码场景下，用户需要同时看到项目文件结构和 git 状态。

**功能描述**：

- **文件树视图**：在 DrawerRight 或独立面板中展示项目目录结构
- **Git 状态**：已修改/未跟踪/已暂存的文件用不同颜色标记
- **文件点击操作**：点击文件 → 引用到对话中（与 @-mention 联动）
- **变更文件高亮**：当前 agent 任务修改的文件在文件树中高亮

**设计要点**：

- 文件树数据由 Sidecar 提供（`file.tree` WS 命令）
- Git 状态由 Sidecar 执行 `git status --porcelain` 获取
- 与 @-mention 的 FileMention 共享文件索引

**涉及文件**：
- 新增：`renderer/src/components/drawer/ProjectTree.vue`
- 新增：`sidecar/src/file-tree.ts`
- 修改：`shared/src/protocol.ts` — 新增 `file.tree` / `file.treeData` / `git.status` 类型

### 8. 对话分支（Conversation Branching）

**问题**：探索方案时，用户经常想"如果从这个点换一种方式会怎样"。当前对话是线性的，无法回溯和分叉。

**功能描述**：

- 在任意消息处创建分支，分支从该消息的上下文状态开始
- 分支之间可以快速切换（Tab 或时间线视图）
- 每个分支独立维护上下文和消息历史
- 分支可以合并回主线（可选）

**设计要点**：

- 这是 Claude Code 目前也没有的功能，是真正的差异化
- 实现复杂度较高：需要 pi 侧支持 session 快照/恢复
- 可以先用简化方案：分支 = 克隆 session，在克隆上继续对话

**涉及文件**：
- 新增：`renderer/src/components/chat/BranchIndicator.vue`
- 修改：`renderer/src/stores/chat.ts` — 分支数据结构
- 修改：`sidecar/src/session-pool.ts` — session 快照
- 修改：`shared/src/protocol.ts` — 新增 `session.branch` 类型

### 9. 工具权限配置完善

**问题**：ApprovalCard 前端组件存在，但 rpc-client.ts 中 `approveTool/denyTool/alwaysAllowTool` 是 no-op。Settings 中缺少 ToolPermissions 标签页。三级权限模型（allow/ask/deny）未持久化。

**功能描述**：

- Settings 中新增"工具权限"标签页
- 每个工具可配置为 allow（自动批准）/ ask（需确认）/ deny（禁止）
- 默认配置：read/grep/find/ls = allow, bash/edit/write = ask
- 权限配置持久化到 `~/.xyz-agent/config.toml`
- rpc-client.ts 中的审批方法实际对接 pi 的 extension_ui_response 协议

**涉及文件**：
- 新增：`renderer/src/components/settings/ToolPermissionsPane.vue`
- 修改：`sidecar/src/rpc-client.ts` — 审批方法对接 pi 协议
- 修改：`sidecar/src/config-store.ts` — 工具权限持久化
- 修改：`renderer/src/components/layout/SettingsView.vue` — 新增 Tab

## P3 — 差异化竞争力

### 10. MCP Server 管理 UI

**问题**：MCP（Model Context Protocol）正在成为 coding agent 的标准扩展机制。pi 已经支持 MCP，但 GUI 中没有管理界面。

**功能描述**：

- Settings 中新增 MCP Server 标签页
- 配置 MCP server 的启停和参数
- 查看 MCP server 提供的工具和资源列表
- 一键安装社区 MCP server 配置

**设计要点**：

- MCP 配置格式跟随 pi 的配置规范（`~/.pi/config.toml` 中的 mcp_servers 段）
- 先做配置管理，市场/发现功能后续再加

### 11. Session 模板

**问题**：常见工作流重复配置（审查模式、修复模式、重构模式）。

**功能描述**：

- 预置模板：代码审查、Bug 修复、重构、文档生成
- 自定义模板：保存当前 session 的 system prompt + 配置为模板
- 新建 session 时可选择模板

### 12. 对话导出与分享

**功能描述**：

- 导出为 Markdown 文件
- 导出为 JSON（完整消息数据）
- 分享给团队成员（文件导出方式）
- 从历史对话中提取操作步骤摘要

### 13. 多会话并行 + 状态聚合

**问题**：用户可能同时在多个项目/任务上并行工作。

**功能描述**：

- 同时运行多个 agent session，各自独立
- Overview 中聚合所有 session 的状态（运行中/等待审批/已完成/出错）
- 需要审批的 session 在 Overview 中高亮提示
- 点击跳转到对应 session 的面板

**设计要点**：

- Panel 系统已支持多面板，此功能主要是 Overview 聚合视图的增强

### 14. 输入增强

**功能描述**：

- **多行编辑模式**：Shift+Enter 换行时，输入区平滑扩展到多行（已部分实现）
- **Markdown 预览**：输入 Markdown 时实时预览渲染效果
- **历史消息搜索**：搜索所有 session 的历史消息内容
- **粘贴图片**：粘贴剪贴板图片，自动转为文件引用或 base64 内嵌

## 不建议在 GUI 侧重做的功能

以下功能是 **agent 引擎层面的优化**，应该在 pi 侧实现，GUI 只需展示结果：

| 功能 | 原始 Phase | 理由 |
|------|-----------|------|
| Anthropic Prompt Caching | P2 | pi 引擎内部的 token 优化 |
| Microcompact 层 | P2 | pi 引擎内部的压缩策略 |
| Post-Compact 恢复注入 | P2 | pi 引擎压缩后的上下文恢复 |
| Repo Map 代码图谱 | P3 | pi 引擎的代码理解能力（tree-sitter + PageRank） |
| LSP 集成 | P3 | pi 引擎的诊断能力 |
| 流式工具执行 | P2 | pi 引擎的执行模式 |
| JSONL + SQLite 双层持久化 | P3 | pi 引擎的存储层 |

GUI 侧应该做的是：**把这些引擎能力的状态和结果高效地展示给用户**，而不是在 GUI 层重新实现。

---

## 实施路线建议

```
Phase A（已提升为最高优先级）：生产构建 + Markdown 渲染 + 文件变更总览 + Session Tree
  → 见 features-top-priority.md
  ↓
Phase B（日常体验）：  #1 @-mention  +  #2 Command Palette  +  #3 交互式终端  +  #4 系统通知  +  #5 项目上下文
  ↓
Phase C（进阶能力）：  #6 Context 管理  +  #7 项目文件树  +  #9 工具权限完善
  ↓
Phase D（差异化）:   #8 对话分支  +  #10-14 P3 功能
```
