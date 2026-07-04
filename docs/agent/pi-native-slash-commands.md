# pi 原生 Slash 命令集成方案

> 创建日期: 2026-05-24
> 状态: 方案讨论中，待决策点确认后进入实现

## 1. 背景

xyz-agent 的 SlashMenu 已有 builtin/skill/agent/extension 四种命令来源。
pi 有 21 个内置 slash 命令，定义在 `BUILTIN_SLASH_COMMANDS`（纯元数据：name + description），
但**这些命令仅在 TUI interactive-mode 中生效**，RPC 模式下不处理。

pi RPC 为部分功能提供了专用的结构化命令（如 `set_model`、`compact`、`export_html`），
但命令发现接口 `get_commands` 不返回内置命令列表。

## 2. 命令全表（21 个）

| # | 命令 | pi RPC 等价 | xyz-agent GUI 现状 | 决策 | 理由 |
|---|---|---|---|---|---|
| 1 | `/compact` | `compact` | 已有 builtin | **保留** | 核心功能 |
| 2 | `/fork` | `fork` + `get_fork_messages` | 无 | **保留，需 RPC 映射** | 高频核心功能 |
| 3 | `/clone` | `clone` | 无 | **保留，需 RPC 映射** | 简单直接 |
| 4 | `/new` | `new_session` | sidebar 有创建按钮 | **保留，需 GUI 适配** | 需要 get_state 二次获取 + sidebar 同步 |
| 5 | `/name` | `set_session_name` | sidebar 双击重命名 | **保留，需 GUI 适配** | 调用后 sidebar 同步 |
| 6 | `/resume` | `switch_session` | sidebar 切换 | **待定** | 精准筛选当前项目，但实现成本高 |
| 7 | `/tree` | 无直接 RPC | 无 | **降级为 fork 替代** | 完整 tree 需 pi 改造 |
| 8 | `/model` | `set_model` / `cycle_model` | 已有 ModelPicker | **不需要** | GUI 已有更好替代 |
| 9 | `/export` | `export_html` | 无 | **不走 slash，加按钮** | 适合作为聊天气泡/工具栏按钮 |
| 10 | `/copy` | `get_last_assistant_text` | 无 | **不走 slash，加按钮** | 适合作为聊天气泡按钮 |
| 11 | `/session` | `get_session_stats` | 无 | **不走 slash，底部 bar** | 展示在状态栏 hover 详情 |
| 12 | `/scoped-models` | 无 | 无 | **不需要** | TUI 的 Ctrl+P 机制 |
| 13 | `/import` | 无 | 无 | **不需要** | 开发者工具，JSONL 导入 |
| 14 | `/share` | 无 | 无 | **不需要** | GitHub Gist，需 OAuth |
| 15 | `/settings` | 无 | 已有设置页 | **不需要** | GUI 有独立 Settings 视图 |
| 16 | `/changelog` | 无 | 无 | **不需要** | 终端文本查看 |
| 17 | `/hotkeys` | 无 | 无 | **不需要** | TUI 快捷键体系 |
| 18 | `/login` | 无 | 已有 Provider 配置 | **不需要** | GUI 已有 |
| 19 | `/logout` | 无 | 已有 Provider 配置 | **不需要** | GUI 已有 |
| 20 | `/reload` | 无 | 无 | **不需要** | 开发者调试用 |
| 21 | `/quit` | 无 | 无 | **不适用** | GUI 关窗口 |

## 3. 需实现的命令详细设计

### 3.1 `/compact` — 已完成

当前实现：builtin 命令，走 `session.compact` protocol → runtime → pi `compact` RPC。

### 3.2 `/fork` — 需 RPC 映射

**行为**：从指定历史用户消息处创建分支，在新 session 中继续对话。

**pi RPC**：
- `get_fork_messages` → 返回 `{ messages: Array<{ entryId, text }> }`
- `fork(entryId)` → 创建新 session 并切换，返回 `{ text, cancelled }`
- `fork` 后需要 `get_state` 获取新 session ID

**实现路径**：
1. runtime 新增 `session.fork-messages` 路由 → 调 `get_fork_messages` RPC
2. 前端展示历史用户消息列表供选择
3. 用户选择后 runtime 调 `fork(entryId)` RPC
4. `get_state` 获取新 sessionId → sidebar 新增 → 切换 panel

**待讨论**：fork 后的 GUI 交互——是否自动切换到新 session？旧 session 在 sidebar 如何标记？

### 3.3 `/clone` — 需 RPC 映射

**行为**：在当前位置复制当前 session，创建新 session 文件。

**pi RPC**：
- `clone` → 无参数，在当前 leaf 位置 fork
- 返回 `{ cancelled }`
- 需要后续 `get_state` 获取新 session ID

**实现路径**：
1. runtime 新增 `session.clone` 路由 → 调 `clone` RPC
2. `get_state` 获取新 sessionId → sidebar 新增 → 可选切换 panel

### 3.4 `/new` — 需 GUI 适配

**行为**：创建全新 session，旧 session 保留磁盘。

**pi RPC**：
- `new_session` → 返回 `{ cancelled }`，**不返回新 sessionId**
- 需要后续 `get_state` 获取新 sessionId 和 sessionFile

**GUI 适配流程**：
1. 前端发 `session.new` protocol（或复用 `session.create`）
2. pi 返回 `{ cancelled: false }`
3. 前端发 `get_state` 获取新 sessionId
4. sidebar 在相同目录下新增 session 条目
5. 自动切换当前 panel 到新 session

**与 `/clear` 的关系**：
pi 中**不存在 `/clear` 命令**。TUI 中 `/new` 才是"新建 session"。
xyz-agent 当前的 builtin `clear` 是本地清空聊天 UI（不调 pi），和 pi 的 `/new` 不同。

### 3.5 `/name` — 需 GUI 适配

**行为**：设置当前 session 的显示名称。

**pi RPC**：
- `set_session_name(name)` → 直接修改 session 元数据

**GUI 适配**：
1. 用户输入 `/name 新名称`
2. runtime 调 `set_session_name` RPC
3. 前端同步更新 sidebar 中该 session 的名称

### 3.6 `/tree` — 降级为 fork 替代

**TUI 行为**：
- `SessionManager.getTree()` 返回树形结构（entry + children + label）
- 用户选择节点后 `navigateTree(entryId, { summarize })` 移动 leaf 指针
- **不创建新 session**，在当前 session 内切换分支
- 支持 summarize（LLM 生成分支摘要）

**为什么降级**：
1. pi 没有暴露 `get_tree` / `navigate_tree` RPC
2. `navigateTree` 强依赖 TUI 交互（ink TreeSelectorComponent）
3. 完整实现需要 pi 侧新增 2 个 RPC 命令

**替代方案**：用 `get_fork_messages` + `fork` 组合：
1. `get_fork_messages` 获取用户消息列表（等价于树的叶子节点）
2. GUI 展示列表
3. 用户选择 → `fork(entryId)` 创建新 session

**差异**：
- TUI tree：当前 session 内移动指针（原地分支切换）
- fork 替代：创建新 session（行为更重但效果类似）

### 3.7 `/resume` — 待定

**行为**：恢复当前项目目录下的其他 session。

**pi RPC**：
- `switch_session(sessionPath)` — 需要**文件路径**，不是 sessionId
- pi 没有暴露 `list_sessions` RPC

**实现难点**：
1. 获取 session 列表：sidecar 可直接读取 sessionDir 磁盘文件
2. 按当前项目 cwd 筛选
3. switch_session 需要 sessionPath（需要 sidecar 建立 id→path 映射）
4. 目标 session 的 cwd 可能已不存在（`MissingSessionCwdError`），GUI 需处理

**和 sidebar 的区别**：
- sidebar 展示所有项目 session（目录多了不好管理）
- `/resume` 固定筛选当前项目目录（更精准）

**待决策**：是改进 sidebar（加搜索/筛选）替代 `/resume`，还是单独实现？

## 4. 不走 slash 的功能（其他交互方式）

### 4.1 `/export` → 按钮

- pi RPC：`export_html` → 生成 HTML 文件
- 实现方式：聊天界面工具栏或菜单添加"导出"按钮
- 点击后调 `export_html` RPC，下载 HTML 文件

### 4.2 `/copy` → 按钮

- pi RPC：`get_last_assistant_text` → 获取最后一条 assistant 消息文本
- 实现方式：assistant 消息气泡添加"复制"按钮
- 也可以用 `navigator.clipboard` 直接从前端复制渲染后文本（不走 RPC）

### 4.3 `/session` → 底部 bar

- pi RPC：`get_session_stats` → token 数、消息数等统计
- 实现方式：底部状态栏展示基本信息，hover 显示详情面板

## 5. 待决策点

| # | 问题 | 选项 |
|---|---|---|
| D1 | `/tree` 降级为 fork 替代可以接受吗？还是等 pi 新增 RPC？ | A: fork 替代 / B: 等 pi 改造 |
| D2 | `/clear` 要改名成 `/new`（和 pi 一致）还是保持本地行为？ | A: 保持本地 / B: 改为调 pi new_session |
| D3 | `/resume` 值得单独实现吗？还是改进 sidebar 替代？ | A: 单独实现 / B: 改进 sidebar / C: 暂不做 |
| D4 | `/fork` 后是否自动切换到新 session？ | A: 自动切换 / B: 手动切换 |
| D5 | 实现优先级？ | — |

## 6. 实现工作量估算

| 命令 | runtime 层 | 前端层 | 工作量 |
|---|---|---|---|
| `/fork` | 新增 2 个路由（fork-messages + fork） | 消息选择 UI + panel 切换 | 中 |
| `/clone` | 新增 1 个路由 | sidebar 同步 | 小 |
| `/new` | 可能复用 session.create | sidebar 同步 + panel 切换 | 小 |
| `/name` | 可能复用 session.rename | sidebar 同步 | 小 |
| `/tree`(降级) | 复用 fork 的路由 | 复用 fork 的 UI | 极小（fork 的子集） |
| `/resume` | 新增 session 列表读取 + switch | session 列表选择 UI | 中-大 |
