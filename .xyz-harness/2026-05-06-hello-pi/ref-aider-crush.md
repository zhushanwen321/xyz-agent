# Aider & Crush 架构模式分析 — xyz-agent 参考报告

> **日期**: 2026-05-06
> **目的**: 从 Aider 和 Crush 两个开源 AI 编码助手中提取对 xyz-agent 有参考价值的架构模式，并给出采纳/规避建议。

---

## 一、Aider 关键模式

### 1.1 Edit Format（编辑策略系统）

Aider 的核心创新之一是**将"LLM 如何输出代码修改"抽象为可插拔的 Edit Format**。根据 README 和入门指南的描述，它有 4 种 Coder 变体：

| Edit Format | 原理 | 适用场景 |
|------------|------|---------|
| **editblock** | LLM 输出 `>>>>>>> SEARCH / ======= / <<<<<<< REPLACE` 标记对 | 强模型（Claude/GPT-4），精确 diff |
| **wholefile** | LLM 输出完整文件内容 | 弱模型，无法精确控制 diff |
| **udiff** | LLM 输出 unified diff 格式 | 支持 diff 格式的模型 |
| **patch** | LLM 输出标准 patch 格式 | 兼容工具链 |

**设计要点**：
- 每个 EditFormat 对应一个 `Coder` 子类（策略模式），共享基类 `base_coder` 的 ChatChunks 系统
- EditFormat 选择与**模型能力挂钩**：强模型用 editblock，弱模型用 wholefile
- ChatChunks 系统将上下文分为 `system` / `context` / `chat` / `tool` 等独立块，按需组装给 LLM
- 自动 Git 提交是核心差异化：每次编辑自动 commit，生成 commit message，用户可随时回滚

**对 xyz-agent 的启示**：
- xyz-agent 目前只有 WriteTool（全量写入）和 EditTool（old/new 替换），可考虑引入更丰富的编辑策略
- 但 xyz-agent 的 Tauri GUI 场景不需要终端 diff 展示，editblock 格式可能不是最优选择
- **采纳建议**：保持当前的 old_string/new_string 替换模式（与 Crush 的 edit 工具一致），这是最实用、最跨模型的格式

### 1.2 Repo Map（仓库代码图谱）

Repo Map 是 Aider 最精巧的设计之一，用于解决"如何在不把全部代码塞给 LLM 的前提下让 LLM 理解项目结构"：

- **底层技术**：tree-sitter AST 解析 + networkx 图构建 + scipy 排名算法
- **输出格式**：只包含"类名、函数签名、方法签名、变量声明"的精简代码地图（不含函数体）
- **排名算法**：基于 PageRank 思想，按"被引用次数"排序，优先展示核心模块
- **缓存**：解析结果缓存，只在文件变更时重新计算受影响的部分
- **Token 预算**：根据模型的 context window 动态调整 repo map 的大小

**对 xyz-agent 的启示**：
- xyz-agent 目前没有类似 repo map 的代码结构感知能力，上下文构建依赖用户手动指定文件
- **采纳建议**（高优先级）：
  - 引入轻量级的 AST 索引层，在 `context/` 模块中实现
  - 可以用 tree-sitter（Rust 绑定成熟）或基于 grep-ast 的简化版
  - 与 ContextManager 的上下文压缩结合，在 token 预算内智能选择最相关的代码结构
  - 作为 PromptManager 的自动上下文注入源

### 1.3 配置优先级链

Aider 使用三级配置覆盖链：

```
环境变量 (AIDER_*) → .env 文件 → YAML 配置文件 → 命令行参数
```

xyz-agent 的 `config/` 模块已实现 TOML + 环境变量回退，但缺少项目级配置文件和命令行参数覆盖。

---

## 二、Crush 关键模式

### 2.1 Agent 循环架构与状态机

Crush 的 Agent 循环采用**三层架构**：

```
Coordinator（全局编排） → SessionAgent（会话级循环） → Fantasy SDK（LLM 抽象 + ReAct 循环）
```

**核心设计决策**：

1. **循环逻辑封装在 SDK 内**：Fantasy SDK 内部实现 ReAct 循环（LLM → 工具调用 → 结果反馈 → 循环），Crush 的 SessionAgent 只注册回调
2. **SessionAgent 是外层状态管理器**：不直接控制循环，而是管理消息队列、上下文压缩、错误恢复
3. **PrepareStep 是最强扩展点**：每轮 LLM 调用前的 hook，可以动态更新工具列表、注入 system prompt、处理排队消息

**状态机**：
```
Idle → Queued (session busy) → Running → Streaming → ToolExecuting → StepFinished → Done
                                                                                         ↓
                                                                              ProcessingQueue → Running (队列有消息)
```

**与 xyz-agent 的对比**：

| 维度 | xyz-agent (AgentLoop) | Crush (SessionAgent) |
|------|----------------------|---------------------|
| 循环位置 | `loop_/mod.rs` 显式 while 循环 | Fantasy SDK 内部封装 |
| 状态管理 | 隐式（通过 loop_iterations） | 显式状态机 |
| 工具执行 | `execute_batch()` 显式调用 | Fantasy 回调驱动 |
| 上下文压缩 | ContextManager（trim + 摘要 + 熔断） | Summarize（小模型压缩历史） |
| 循环检测 | BudgetGuard（diminishing returns） | SHA-256 签名 + 滑动窗口 |

**采纳建议**：
- xyz-agent 的显式循环设计更透明、更易调试，**保持不变**
- 借鉴 Crush 的 **PrepareStep hook 模式**：在每轮 LLM 调用前增加一个扩展点，允许动态注入上下文（当前 PromptManager 已部分实现）
- 借鉴 Crush 的**循环检测签名算法**：SHA-256(工具名 + 输入 + 输出)，比 diminishing returns 更精确

### 2.2 会话管理与持久化模式

Crush 选择 **SQLite** 作为持久化后端，而非文件系统 JSONL：

| 维度 | Crush (SQLite) | xyz-agent (JSONL) |
|------|---------------|-------------------|
| 查询能力 | SQL JOIN / 聚合 / 索引 | 线性扫描文件 |
| 事务安全 | BEGIN / COMMIT / ROLLBACK | 无事务保证 |
| 触发器 | 自动维护 message_count、updated_at | 应用层维护 |
| 并发安全 | SQLite WAL 模式 | 文件锁（无） |
| 关系查询 | sessions → messages → files 外键级联 | 文件系统目录结构 |
| 数据量 | 10 万+ 消息无压力 | 大文件需分片 |

**Crush 的关键设计**：
- **三种会话创建模式**：`Create`（用户主动）、`CreateTitleSession`（标题生成子会话）、`CreateTaskSession`（Agent 工具子会话）
- **子会话隔离**：`parent_session_id` 关联父会话，`ListSessions` 过滤子会话
- **原子更新**：`UpdateTitleAndUsage` 使用 SQL 累加（`prompt_tokens = prompt_tokens + ?`）
- **XXH3 HashID**：UUID 存储 + XXH3 哈希展示，支持前缀匹配查找
- **自动摘要**：上下文接近上限时触发，摘要消息角色改为 User（让 LLM 视为用户提供的摘要）

**采纳建议**（中长期）：
- **当前 JSONL 方案足够**，但随会话量增长，考虑迁移到 SQLite（`rusqlite` / `diesel`）
- 借鉴**子会话设计**：xyz-agent 的 Orchestrate/DispatchAgent 已有父子关系，可参考 `parent_session_id` 模式规范化
- 借鉴**自动摘要触发策略**：大窗口保留固定 buffer（20K），小窗口保留比例 buffer（20%）
- **HashID 展示**可用于前端 Tab 标签的短 ID

### 2.3 工具系统设计

**Crush vs xyz-agent 工具系统对比**：

| 维度 | Crush | xyz-agent |
|------|-------|-----------|
| 工具接口 | `fantasy.AgentTool`（name + description + handler） | `Tool` trait（name + description + call + danger_level） |
| 参数定义 | Go struct + JSON/description tag → JSON Schema | Rust struct + serde + schemars |
| 执行模式 | Fantasy SDK 回调驱动 | `execute_batch()` 显式调度 |
| 并行工具 | `NewParallelAgentTool`（独立 goroutine） | `safe 并发 + unsafe 串行` |
| MCP 集成 | 原生（动态发现 + 白名单） | 无 |
| LSP 集成 | 编辑后自动获取诊断 | 无 |
| 文件追踪 | `filetracker.Service`（read-before-edit） | `DataContext`（已读文件追踪） |
| 安全命令 | 白名单跳过权限（ls, cat, git status 等） | `danger: safe/caution/unsafe` 三级 |

**Crush 的独特设计**：

1. **mvdan.cc/sh 纯 Go shell 解释器**：不调用系统 shell，跨平台一致，支持 BlockFunc 命令拦截（三层：完全禁止 / 参数限制 / 特殊危险操作）
2. **read-before-edit 强制检查**：编辑前验证 `LastReadTime`，文件被外部修改则拒绝
3. **自动后台化**：长时间命令超过 `auto_background_after` 秒自动切后台，返回 `shell_id`
4. **FirstLineDescription**：环境变量控制是否只用描述第一行，减少 token 消耗
5. **文件历史版本**：每次编辑创建版本记录，支持撤销

**采纳建议**：
- **read-before-edit**：xyz-agent 的 `DataContext` 已有 `read_files` 追踪，可以在 WriteTool/EditTool 中增加 `last_read_time` 检查
- **命令拦截分层**：xyz-agent 的 BashTool 目前只有安全检查提示，可借鉴三层拦截（完全禁止 / 参数限制 / 特殊处理）
- **FirstLineDescription**：可引入类似的工具描述压缩机制，在上下文紧张时自动精简
- **自动后台化**：xyz-agent 作为 GUI 应用可考虑对长时间命令增加超时/后台化选项
- **暂不需要** MCP 和 LSP 集成（当前阶段优先级较低）

### 2.4 权限系统设计

Crush 的权限系统采用 **"先请求、后执行"** 模式，核心架构：

```
Request() → 快速路径检查（skip → allowed_tools → session_permissions）→ 完整请求流程（pubsub → TUI 对话框 → channel 响应）
```

**五层审批链**（按速度从快到慢）：

| 层级 | 检查内容 | 时间复杂度 |
|------|---------|-----------|
| 1. skip | YOLO 模式全局 bypass | O(1) |
| 2. allowed_tools | `工具名` 或 `工具:动作` 匹配 | O(n), n < 20 |
| 3. autoApproveSessions | 会话级自动批准 | O(1) |
| 4. sessionPermissions | 持久化授予记录（ToolName + Action + SessionID + Path） | O(m), m < 100 |
| 5. 完整请求 | pubsub → UI 对话框 → 用户选择 | 用户响应时间 |

**与 xyz-agent 的对比**：

| 维度 | Crush | xyz-agent |
|------|-------|-----------|
| 权限模型 | 请求-确认（工具执行前阻塞等待） | 白名单/黑名单（PermissionContext） |
| 用户交互 | TUI 对话框 + "Allow for Session" | 无 UI 交互权限确认 |
| 全局 bypass | `--yolo` flag | 无 |
| 细粒度控制 | 工具:动作 + 路径 | 文件路径白名单/黑名单 |
| 串行化 | `requestMu` 保证一次一个请求 | 无 |
| 桌面通知 | beeep 跨平台通知 | 无 |

**采纳建议**：
- xyz-agent 当前已有 `PermissionContext`（白名单/黑名单），但**缺少用户交互确认环节**
- **短期**：可在前端增加权限请求对话框（类似 Crush 的 Allow/Deny/AllowForSession）
- **中期**：引入 `allowed_tools` 配置和会话级持久化授权
- **YOLO 模式**：可通过 Tauri command 实现全局 bypass 切换
- **串行化**：Tauri 的单线程事件循环天然保证一次一个权限请求

### 2.5 LSP 集成系统

Crush 的 LSP 集成是其**最大的架构亮点之一**，实现了 Agent → LSP 的闭环反馈：

```
编辑文件 → 通知 LSP (didChange) → 等待诊断 → 获取反馈 → 附加到工具响应
```

**核心架构**：
- **懒启动**：不会预加载所有 LSP，按文件类型按需启动
- **一个语言一个客户端**：每个语言服务器对应一个 Client 实例
- **VersionedMap 诊断缓存**：写入时自增版本号，读取时只比较版本号
- **混合引用查找**：grep 粗筛 + LSP 精确定位
- **超时分级**：view 300ms / edit 5s / FindReferences 5s

**工具与 LSP 的集成点**：
- `view` 工具：读取后附加当前诊断
- `edit/write` 工具：编辑后通知 LSP，等待 5s 获取诊断反馈
- `diagnostics` 工具：主动查询文件/项目级诊断
- `references` 工具：grep + LSP 混合查找符号引用
- `lsp_restart` 工具：Agent 可主动重启卡住的 LSP

**对 xyz-agent 的启示**：
- LSP 集成是实现"编辑 → 验证 → 修复"闭环的关键，但目前优先级较低
- **长期建议**：在 `engine/tools/` 中增加 LSP 集成模块
  - 利用 Rust 生态的 `lsp-server` / `tower-lsp` crate
  - 懒启动 + 文件类型路由
  - 诊断结果通过 `AgentEvent::ToolCallEnd` 返回前端展示
- **短期替代**：在 BashTool 中利用 `cargo check`/`npm run build` 等命令实现轻量级验证

---

## 三、综合建议：xyz-agent 应采纳的模式

### 高优先级（短期可实现）

| 模式 | 来源 | 实现位置 | 预期收益 |
|------|------|---------|---------|
| **read-before-edit 检查** | Crush | `tools/write/mod.rs`, `tools/bash/mod.rs` | 防止覆盖外部修改 |
| **命令拦截分层** | Crush | `tools/bash/mod.rs` | 安全性提升 |
| **循环检测签名算法** | Crush | `budget_guard.rs` | 精确检测重复工具调用循环 |
| **工具描述压缩** | Crush | `context/prompt.rs` | 减少 token 消耗 |

### 中优先级（中期规划）

| 模式 | 来源 | 实现位置 | 预期收益 |
|------|------|---------|---------|
| **用户交互权限确认** | Crush | 新增 `permission/` 模块 + 前端对话框 | 安全性 + 用户体验 |
| **allowed_tools 配置** | Crush | `config/mod.rs` | 细粒度权限控制 |
| **子会话 ID 规范化** | Crush | `task_tree.rs` | 会话层级清晰化 |
| **自动摘要触发策略** | Crush | `context/mod.rs` | 自适应上下文压缩 |
| **YOLO 模式** | Crush | 前端设置 + Tauri command | 快速工作流 |

### 低优先级（长期可选）

| 模式 | 来源 | 实现位置 | 预期收益 |
|------|------|---------|---------|
| **Repo Map 代码图谱** | Aider | `context/` 新增 AST 索引模块 | 自动上下文感知 |
| **LSP 集成** | Crush | 新增 `lsp/` 模块 | 编辑验证闭环 |
| **SQLite 持久化** | Crush | `store/` 重构 | 查询性能 + 事务安全 |
| **MCP 工具集成** | Crush | 新增 `mcp/` 模块 | 外部工具生态扩展 |

### 应规避的模式

| 模式 | 来源 | 原因 |
|------|------|------|
| **Edit Format 策略模式** | Aider | xyz-agent 是 GUI 应用，不需要终端 diff 展示；当前 edit 模式足够 |
| **循环封装在 SDK 内** | Crush | xyz-agent 的显式循环更透明、更易调试，Rust 不适合回调地狱 |
| **纯 Go shell 解释器** | Crush | xyz-agent 的 Rust 后端可直接用 `std::process::Command` + 沙盒 |
| **C/S 双模式** | Crush | xyz-agent 是桌面应用（Tauri），不需要远程服务器模式 |

---

## 四、架构差异根源总结

| 根源 | Aider | Crush | xyz-agent |
|------|-------|-------|-----------|
| **语言** | Python | Go | Rust + TypeScript |
| **运行环境** | 终端 CLI | 终端 TUI + 可选 C/S | 桌面 GUI (Tauri) |
| **模型支持** | LiteLLM（所有模型） | Fantasy SDK（7+ Provider） | 自研 ProviderRegistry |
| **持久化** | 文件系统 | SQLite | JSONL 文件 |
| **核心差异** | 模型无关的编辑工具 | 事件驱动的 Agent 运行时 | 多轮工具调用 + 子 Agent 编排 |

xyz-agent 的独特优势在于**Rust 的性能和安全性** + **Tauri 的桌面 GUI 能力** + **已有的子 Agent 编排架构（Orchestrate/DispatchAgent）**。在借鉴 Aider/Crush 的模式时，应优先选择能强化这些优势的模式，而非简单复制他们的架构决策。
