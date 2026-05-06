# Codex CLI & OpenCode 架构分析 — xyz-agent 可借鉴模式

> 来源: Codex CLI (Rust, 62.8 万行) + OpenCode (Go, 4.2 万行)
> 目标: 提取 xyz-agent (Rust + Vue) 可直接采用或避免的模式

---

## 一、Codex CLI 多 Agent 编排

### 1.1 核心模型: Thread = Agent

Codex 将每个 Agent 映射为一个 Thread（独立会话），通过 ThreadManager 管理生命周期。这接近 OS 进程模型：

- 每个 Agent 拥有**独立的配置空间、状态和邮箱**
- ThreadManager 是"内核"，AgentControl 是"系统调用接口"
- 使用 `Weak<ThreadManagerState>` 避免循环引用（ThreadManager → CodexThread → Session → ThreadManager）

**xyz-agent 现状**: `task_tree.rs` 已有 TaskNode 树形结构 + `agent_spawner.rs` 支持子 Agent 生成。但缺少：
- Agent 间消息传递（当前只有 feedback.rs 的单向 Communication）
- Agent 树的持久化（spawn 边未持久化）

**应采用**:
1. **Mailbox 消息传递** — Agent 间通过 channel 异步通信，支持纯通知（不触发 turn）和请求（触发新 turn）两种语义
2. **AgentPath 树形寻址** — `/root/worker1` 风格的路径编码父子关系，支持前缀过滤列出子树
3. **Weak 引用模式** — AgentControl 用 Weak 回引 ThreadManager，避免嵌套 Agent 树中的循环引用

### 1.2 SpawnReservation 两阶段提交

```
1. reserve_spawn_slot() — 原子增加计数器，预留 path 和 nickname
2. commit() — 注册 AgentMetadata 到 tree
   Drop impl 自动回滚 — spawn 中途失败（包括 panic）释放 slot
```

**应采用**: xyz-agent 的 `agent_spawner.rs` 应引入类似的 RAII guard，确保 spawn 失败时资源自动回收。

### 1.3 分叉历史的"清洁化"

子 Agent 分叉时，`keep_forked_rollout_item()` 过滤历史：
- 保留: system/developer/user 消息 + assistant 的 FinalAnswer
- 丢弃: tool call、function call 等中间过程

**设计意图**: 减少 token 消耗和干扰，子 Agent 获得干净的上下文快照。

**xyz-agent 现状**: `dispatch_agent.rs` 的 fork 模式直接传递完整历史。应采用清洁化过滤。

### 1.4 并发控制

- **数量限制**: `config.agent_max_threads`，CAS 循环实现无锁并发计数
- **深度限制**: `config.agent_max_depth`，超深时禁用 SpawnCsv/Collab feature
- **路径唯一性**: `reserve_agent_path()` 防止命名冲突

**xyz-agent 现状**: `budget_guard.rs` 有 token/turn/tool_call 预算，但缺少 Agent 数量和深度限制。`concurrency.rs` 有 Semaphore 但未与 Agent 深度绑定。

---

## 二、Codex CLI 会话持久化

### 2.1 双层架构: JSONL 事件溯源 + SQLite 读模型

```
JSONL (Event Store)          SQLite (Projection)
├─ 追加写入，不可变          ├─ 从事件流提取元数据
├─ 完整事件序列              ├─ 高效列表查询（分页、筛选）
└─ 支持回放/恢复             └─ 可丢失，可重建（Backfill）
```

**为什么不用纯 SQLite**: 事件溯源的核心优势是**可回放性**。CLI 工具需要从任意中断点继续。JSONL 追加写入比 SQLite 事务更适合高频事件流。

**为什么需要 SQLite**: 多 Agent 架构需要高效状态查询（按来源、按父子关系查找并发线程），纯文件扫描无法满足。

**最终一致性**:
1. SQLite 可以不存在 — 所有核心功能降级到文件系统扫描
2. Read Repair 检测不一致时修复，而非阻止操作
3. SQLite 写入失败只记 warning，不影响 JSONL 写入

> **核心认知**: 对本地 CLI 工具，**可用性比一致性更重要**。

**xyz-agent 现状**: JSONL 持久化已有（`store/`），但缺少 SQLite 读模型。随着多 Agent 需求增长，需要引入 SQLite 做元数据查询。

**应采用**:
1. **JSONL + SQLite 双层** — 保持现有 JSONL，增加 SQLite 做投影
2. **最终一致性 + Read Repair** — SQLite 可丢失，不阻塞主流程
3. **Backfill 机制** — 首次创建或 schema 升级后，异步从 JSONL 重建 SQLite
4. **事件过滤策略** — 不持久化流式 Delta，只持久化核心事件（类似 Codex 的 Limited 模式）

### 2.2 RolloutRecorder 异步写入

```
调用线程 --[mpsc::channel(256)]--> 后台 Writer Task
                                  ├─ 延迟创建文件（首次 persist 才创建）
                                  ├─ 故障恢复（双重重试 + pending 保留）
                                  └─ 每行 flush
```

**xyz-agent 现状**: JSONL 写入是否异步需确认。应采用类似的异步写入 + 故障恢复模式。

---

## 三、Codex CLI 工具系统

### 3.1 定义与执行分离

```
codex-tools (定义层): 参数 schema、输出 schema，不涉及执行
codex-core/tools (核心层): 路由、编排、沙箱集成
codex-core/handlers (处理层): 各工具的具体实现
```

**xyz-agent 现状**: `engine/tools/` 混合了定义和执行。当前规模可接受，但如果要支持 MCP 工具或插件系统，需要分离。

### 3.2 FreeformTool — 减少 token 消耗

利用 OpenAI Custom Tools 的 Lark 语法，`apply_patch` 的输入是非 JSON 格式的结构化 diff 文本。模型生成 diff 而非 JSON，减少 token 消耗和序列化开销。

**xyz-agent 考量**: 如果主要用 Anthropic API，此模式不直接适用。但"减少工具参数的 token 开销"这个思路值得借鉴 — 可以优化工具参数 schema 的设计。

### 3.3 RwLock 并行控制

```rust
let _guard = if supports_parallel {
    Either::Left(lock.read().await)   // 读锁: 多个可并行持有
} else {
    Either::Right(lock.write().await) // 写锁: 互斥
};
```

**xyz-agent 现状**: `executor.rs` 已有 safe 并发 + unsafe 串行。RwLock 模式更优雅，考虑迁移。

### 3.4 工具审批编排: 渐进式安全

```
approval(skip/need/forbidden) → sandbox attempt → 沙箱拒绝?
    → wants_no_sandbox_approval? → 用户批准 → 无沙箱重试
```

**ApprovalStore 缓存**: 已批准的操作 session 内不重复询问。

**xyz-agent 现状**: `PermissionContext` 有白名单/黑名单，但没有:
- 审批缓存（同一会话中重复询问）
- "先尝试受限执行，失败后提权"的渐进模式

### 3.5 tool_search: 延迟加载

面向大规模 MCP 工具生态，`defer_loading=true` 的工具不在初始请求中暴露，模型按需通过 BM25 搜索发现。

**xyz-agent 考量**: 当前工具数量少，不需要。如果未来引入大量 MCP 工具，此模式必要。

---

## 四、OpenCode Agent 循环（Go 语言影响）

### 4.1 Go 对设计的影响

| Go 特性 | 设计影响 | Rust/xyz-agent 替代 |
|---------|---------|-------------------|
| goroutine + channel | 天然 CSP 模型，事件流用 channel 传递 | tokio mpsc 已有，等价 |
| sync.Map | 无锁并发读多写少场景 | Rust: DashMap 或 Arc<Mutex<HashMap>> |
| context.Context | 取消信号穿透所有层 | Rust: tokio::CancellationToken（已有） |
| 泛型 (1.18+) | `Broker[T]` 类型安全事件系统 | Rust: 泛型更自然 |
| struct embedding | 组合复用（Broker 嵌入 Service） | Rust: trait + 组合模式 |
| 接口隐式满足 | 最小接口（2 方法的 BaseTool） | Rust: trait 更显式，等价 |

**关键结论**: Go 的 channel + goroutine 与 Rust 的 tokio mpsc + async 在表达能力上等价。xyz-agent 的 Rust 实现不需要因语言差异做根本性设计妥协。

### 4.2 OpenCode 的简洁 ReAct 循环

```go
for {
    select { case <-ctx.Done(): return }  // 取消检查
    agentMessage, toolResults, err := streamAndHandleEvents(...)
    if finishReason == ToolUse {
        msgHistory += assistantMsg + toolResults
        continue
    }
    return // 正常结束
}
```

**对比 xyz-agent**: xyz-agent 的 `run_turn()` 循环更复杂（迭代预算、diminishing returns 检测），但核心结构一致。

### 4.3 OpenCode 缺失的重要特性（xyz-agent 已有）

| 特性 | OpenCode | xyz-agent |
|------|---------|-----------|
| 最大迭代次数 | 无（依赖 LLM 自停） | `budget_guard.rs` 有 |
| 工具并行执行 | 串行 | `executor.rs` safe 并发 |
| 自动摘要 | 配置存在但未实现 | `context/mod.rs` 有 trim + LLM 摘要 |
| 多 Provider 路由 | 有（但 12 Provider 平铺） | `registry.rs` 有 `provider/modelId` 路由 |

---

## 五、OpenCode Provider 适配层

### 5.1 核心设计: 泛型 baseProvider + 5 种 Client

```
Provider 接口 (3 方法: SendMessages/StreamResponse/Model)
    ↓
baseProvider[C ProviderClient] (泛型外壳: 消息清理 + 委托)
    ↓
5 种 Client 实现:
  - AnthropicClient (~470 行, 最丰富: caching + thinking)
  - OpenAIClient (~430 行, 基准, 被 4 厂商复用)
  - GeminiClient (~555 行, Chat 模式 + Schema 转换)
  - CopilotClient (~670 行, OAuth + monkey patch)
  - BedrockClient (~100 行, 委托 AnthropicClient)
```

**复用策略**:

| 模式 | 厂商数 | 行数 | 核心机制 |
|------|--------|------|---------|
| Base URL 替换 | 4 (Groq/OpenRouter/XAI/Local) | 0 | OpenAI SDK base URL |
| 后端切换 | 1 (VertexAI) | ~34 | SDK Backend 参数 |
| 嵌入 | 1 (Azure) | ~47 | Go embedding |
| 委托 | 1 (Bedrock) | ~100 | childProvider 字段 |

**xyz-agent 现状**: `llm/registry.rs` 按 `provider/modelId` 路由，`anthropic.rs` 实现了 Anthropic。应采用:

1. **OpenAI 兼容标准复用** — Groq/OpenRouter/Local 等只需改 base URL
2. **委托模式** — Bedrock/Azure 等托管服务委托给对应厂商 Client
3. **分层选项** — 外层通用配置 + 内层厂商专属 Option

### 5.2 Prompt Caching 自动注入

Anthropic: 自动为最近 3 条消息和最后一个工具添加 `CacheControl: ephemeral`。系统消息始终缓存。

**xyz-agent 应采用**: 当前可能未利用 Anthropic prompt caching。添加缓存标记是零成本性能优化。

### 5.3 Thinking 模式动态激活

```go
if shouldThink(messageContent) {
    thinkingBudget = maxTokens * 0.8
    temperature = 1  // Anthropic 强制要求
}
```

**xyz-agent 考量**: 如果使用 Claude 的 extended thinking，需注意 temperature 必须为 1。

### 5.4 流式增量持久化

每个 delta 事件都立即写入数据库。崩溃安全优先于性能。

**xyz-agent 应采用**: 当前 JSONL 是否在每个事件后 flush？如果不是，应改为增量持久化 + flush。

---

## 六、OpenCode 权限系统

### 6.1 三层模型: 工具请求 → 服务仲裁 → 用户裁决

仅 120 行代码实现完整权限系统，核心技巧：

```
工具 goroutine: Request() 同步阻塞 ←→ respCh ←→ TUI goroutine: Grant/Deny
                           ↑ pubsub 桥接 ↑
```

- `Request()` 在工具的 goroutine 中同步阻塞
- 用户响应在 TUI event loop 中产生
- 通过 `pendingRequests` sync.Map 中的 channel 关联

### 6.2 三种授权粒度

| 粒度 | 实现 | 效果 |
|------|------|------|
| 单次授权 | `Grant` | 只批准当前这一次 |
| 会话级持久 | `GrantPersistant` | 本次会话内同类操作自动批准 |
| 全会话自动 | `AutoApproveSession` | 非交互模式所有操作自动批准 |

**xyz-agent 现状**: `PermissionContext` 有白名单/黑名单，但缺少:
1. **会话级审批缓存** — 同一操作不应重复询问
2. **Auto-approve 模式** — 非交互模式需要自动批准
3. **同步阻塞的 Request 接口** — 工具只需调用一次就获得结果

### 6.3 权限拒绝的级联取消

用户拒绝一个工具调用 → 同一响应中所有后续工具调用也被取消 + `FinishReason=PermissionDenied`。

**xyz-agent 应采用**: 当前拒绝后是否级联取消？应实现此模式。

### 6.4 Bash 工具的三层安全

```
banned（绝对禁止: curl/wget/nc） → safe（自动放行: ls/git status） → 其他（需审批）
```

**xyz-agent 现状**: `bash/mod.rs` 有安全检查，但可能没有只读白名单自动放行。应增加 safe 白名单减少用户确认次数。

### 6.5 路径归一化

项目内文件操作统一归一化到项目根目录 → "允许编辑项目内所有文件"只需一次授权。

**xyz-agent 应采用**: 简化用户审批体验。

---

## 七、综合建议：xyz-agent 应采取的行动

### 高优先级（直接改进现有系统）

| # | 模式 | 来源 | 当前差距 | 行动 |
|---|------|------|---------|------|
| 1 | 会话级审批缓存 | OpenCode | PermissionContext 无缓存 | 在 PermissionContext 中添加已批准操作缓存 |
| 2 | 权限拒绝级联取消 | OpenCode | 可能只取消当前工具 | 拒绝后取消同批次所有后续工具 |
| 3 | Bash 只读白名单 | OpenCode | 黑名单有，白名单无 | 添加 safe commands 白名单自动放行 |
| 4 | Anthropic Prompt Caching | OpenCode | 可能未利用 | 为系统消息 + 最近 N 条消息加 cache_control |
| 5 | Agent 数量/深度限制 | Codex | budget_guard 有 token 限制但无 Agent 数量限制 | 添加 max_agents + max_depth 配置 |
| 6 | 增量持久化 + flush | OpenCode | 需确认 JSONL 写入时机 | 每个核心事件后 flush |

### 中优先级（架构改进）

| # | 模式 | 来源 | 行动 |
|---|------|------|------|
| 7 | Mailbox 消息传递 | Codex | Agent 间双向异步通信，支持通知 vs 请求语义 |
| 8 | JSONL + SQLite 双层 | Codex | JSONL 保持，增加 SQLite 做元数据查询 + Backfill |
| 9 | OpenAI 兼容 Provider 复用 | OpenCode | Groq/OpenRouter/Local 只需改 base URL |
| 10 | Agent 分叉历史清洁化 | Codex | fork 模式传递清洁上下文（只保留用户消息 + 最终回答） |
| 11 | Auto-approve 模式 | OpenCode | 非交互/CI 模式自动批准所有操作 |

### 低优先级（长期演进）

| # | 模式 | 来源 | 备注 |
|---|------|------|------|
| 12 | 工具定义/执行分离 | Codex | 为 MCP 插件系统准备 |
| 13 | tool_search 延迟加载 | Codex | 工具数量 >50 时引入 |
| 14 | FreeformTool 非 JSON 参数 | Codex | 取决于 API 支持 |
| 15 | 权限审计日志 | OpenCode | 企业需求时添加 |
| 16 | SQLite schema 版本化 | Codex | 版本号嵌入文件名，前向兼容 |

### 应避免的模式

| # | 模式 | 来源 | 为什么避免 |
|---|------|------|-----------|
| A | 无迭代上限的 ReAct 循环 | OpenCode | xyz-agent 已有 budget_guard，保持 |
| B | 工具串行执行 | OpenCode | xyz-agent 已有并行执行，保持 |
| C | Copilot 请求头伪装 | OpenCode | 法律风险 |
| D | Gemini 字符串匹配错误检测 | OpenCode | 脆弱，优先使用 HTTP 状态码 |
| E | Mock Provider 未实现 | OpenCode | xyz-agent 确保测试 Provider 可用 |
| F | MCP 工具缓存无热更新 | OpenCode | 设计 MCP 时考虑动态刷新 |

---

## 八、关键数据对比

| 维度 | Codex CLI | OpenCode | xyz-agent |
|------|-----------|----------|-----------|
| 语言 | Rust | Go | Rust + Vue |
| 代码量 | 628K 行 | 42K 行 | ~30K 行（估） |
| Agent 并发 | ThreadManager + 弱引用 | sync.Map + context | task_tree + Semaphore |
| 持久化 | JSONL + SQLite | SQLite (WASM) | JSONL |
| Provider 数量 | OpenAI + Ollama + LM Studio | 12 种 | Anthropic（主）+ 可扩展 |
| 工具并行 | RwLock 读写锁 | 串行 | safe 并发 + unsafe 串行 |
| 权限系统 | ApprovalStore + 沙箱 | 120 行 pubsub 桥接 | PermissionContext 白/黑名单 |
| 上下文管理 | Compact（LLM 摘要） | Auto-compact（未完成） | trim + LLM 摘要 + 熔断 |
| 事件系统 | SQ/EQ 双队列 | pubsub.Broker[T] | mpsc → Tauri Event |
| 多前端 | 5 种模式共享 Core | TUI (Bubbletea) | Tauri WebView |

---

*生成时间: 2026-05-06*
*基于: Codex CLI 源码分析 (5 篇) + OpenCode 源码分析 (5 篇)*
