# P1-ContextManager 设计规格

**版本**: v1 | **日期**: 2026-04-09 | **状态**: 已确认

---

## 目标

为 Agent 引擎添加上下文窗口管理：自动裁剪旧工具结果 + LLM 摘要压缩，防止长对话超出模型上下文限制。

## 不包含

- Session Memory 系统（P2，免 API 调用的后台记忆提取）
- Cached Microcompact（P2，通过 API cache_edits 删除，不破坏 prompt cache）
- 前端压缩状态 UI（另文档）
- PromptManager（静态/动态分层，另文档）
- DataContext（数据追踪，另文档）

## 参考

- Claude Code `src/services/compact/autoCompact.ts`：auto-compact 流程、阈值、熔断器
- Claude Code `src/services/compact/compact.ts`：Full Compact、PTL 重试
- Claude Code `src/services/compact/microCompact.ts`：Cached / Time-based Microcompact
- Claude Code `src/services/compact/sessionMemoryCompact.ts`：SM Compact（首选免 API 路径）
- Claude Code `src/utils/tokens.ts`：Token 计数策略
- Claude Code `src/utils/context.ts`：模型上下文窗口、maxOutputTokens 配置

---

## 核心类型

### TokenBudget

```rust
pub struct TokenBudget {
    pub context_window: u32,          // 模型上下文窗口（如 200_000）
    pub max_output_tokens: u32,       // 输出预留（默认 8_192，至少 20_000）
    pub last_input_tokens: Option<u32>, // 上次 API 返回的精确值
}

impl TokenBudget {
    /// 有效上下文 = 模型窗口 - min(max_output_tokens, 20_000)
    /// 与 Claude Code 一致：getEffectiveContextWindowSize()
    pub fn effective_window(&self) -> u32 {
        self.context_window - self.max_output_tokens.max(20_000)
    }

    /// 粗估 token：假设混合内容 3 字符/token
    pub fn estimate_text(text: &str) -> u32 {
        (text.len() as u32) / 3
    }

    /// 粗估一组 entries 的 token 数
    pub fn estimate_entries(entries: &[TranscriptEntry]) -> u32 {
        let json = serde_json::to_string(entries).unwrap_or_default();
        Self::estimate_text(&json)
    }
}
```

### ContextConfig

```rust
pub struct ContextConfig {
    // 固定缓冲区（与 Claude Code 一致）
    pub auto_compact_buffer: u32,     // 13_000，触发第二层
    pub warning_buffer: u32,          // 20_000，前端警告
    pub hard_limit_buffer: u32,       // 3_000，阻塞请求

    // 第一层配置
    pub keep_tool_results: usize,     // 10，保留最近 K 个 tool_result 完整内容

    // 第二层配置
    pub compact_max_output_tokens: u32, // 20_000，摘要请求的输出上限

    // 熔断器
    pub max_consecutive_failures: u32, // 3，连续失败后停止
}
```

### ContextManager

```rust
pub struct ContextManager {
    config: ContextConfig,
    token_budget: TokenBudget,
    consecutive_failures: u32,
}

impl ContextManager {
    /// 第一层：裁剪旧工具结果（始终执行，不依赖阈值）
    pub fn trim_old_tool_results(&self, messages: Vec<Value>) -> Vec<Value>;

    /// 估算当前总 token 数
    /// base=last_input_tokens + delta=new_entries[counted..] 的粗估
    pub fn estimate_total(
        &self,
        new_entries: &[TranscriptEntry],
        counted_entries: usize,
    ) -> u32;

    /// 第二层：LLM 摘要压缩（超阈值时触发）
    /// 返回 (compressed_messages, Option<TranscriptEntry::Summary>)
    pub async fn compact_with_llm(
        &mut self,
        messages: Vec<Value>,
        provider: &dyn LlmProvider,
        model: &str,
    ) -> Result<(Vec<Value>, Option<TranscriptEntry>), AppError>;

    /// 更新精确 token 计数（从 API 响应）
    pub fn update_usage(&mut self, input_tokens: u32);
}
```

---

## 阈值体系

以 200K 上下文窗口为例：

| 缓冲区 | 大小 | 触发阈值 | 动作 |
|--------|------|---------|------|
| Auto-compact | 13,000 | 187K (200K-13K) | 触发第二层 LLM 摘要 |
| Warning | 20,000 | 167K (187K-20K) | 前端状态栏警告 |
| Hard limit | 3,000 | 197K (200K-3K) | 阻塞，返回错误 |

**有效上下文**: 200K - 20K = 180K。Auto-compact 在 187K 触发，看似超过有效上下文，但第一层裁剪通常已释放大量空间。

> **vs Claude Code**：Claude Code 的 auto-compact 在 effectiveWindow - 13K 触发，即 180K - 13K = 167K。但 Claude Code 的 auto-compact 是总触发口（包含 SM Compact 和 Full Compact），而我们的 187K 是第二层的触发点。实际效果：第一层持续裁剪 + 第二层在 187K 时介入。如果裁剪后仍超阈值，则触发 LLM 摘要。

---

## 第一层：自动裁剪

### 触发条件

**始终执行**，不依赖 token 预算。在每次 API 调用前对 messages 进行裁剪。

### 裁剪策略

1. **扫描**：遍历所有 user message 中的 `UserContentBlock::ToolResult`，收集位置信息
2. **截断**：保留最近 K 个（默认 10）tool_result 的完整内容，更早的替换为引用标记
3. **去重**：相同工具名 + 相同参数的连续调用，只保留最后一次的完整结果

### 引用标记格式

```
[tool_result:{tool_name}({args_summary}) - {original_size} chars, trimmed]
```

示例：`[tool_result:Read(src/main.rs) - 2400 chars, trimmed]`

LLM 能看到工具执行了什么、结果大概多大，但看不到具体内容。

### 幂等读取优化

相同工具 + 相同参数的连续调用（如连续 `Read("file.rs")`），只保留最后一次的完整结果。早期结果替换为：
```
[duplicate: see latest Read(file.rs) result]
```

前提：Read 工具是幂等的（文件未修改时结果相同）。对于 Bash 等非幂等工具，不做去重。

### 特点

- **仅内存**：不修改 JSONL，每次加载重新计算
- **无 API 调用**：纯字符串操作
- **可逆**：原始数据完整保留在 JSONL 中

---

## 第二层：LLM 摘要

### 触发条件

估算总 token > `effective_window - auto_compact_buffer`（187K for 200K window）。

### 执行流程

```
1. 分组：将 messages 按 API round 分组
   （每个 assistant 消息开始新 group）

2. 保留近期：保留最近 M 个 group（覆盖 ~20K tokens）
   M = 需要回溯保留的 token 预算 / 平均每组 token 数

3. 摘要旧组：将早期 groups 拼接，发给 LLM 生成结构化摘要
   摘要 prompt 要求输出：
   - 任务目标和进度
   - 关键决策和原因
   - 当前文件状态
   - 未解决的问题

4. 构造压缩后 messages：
   [System: 摘要文本] + [保留的近期 groups]
```

### 摘要 Prompt 设计

```
Summarize the following conversation between a user and an AI coding assistant.
Focus on:
1. Task goals and current progress
2. Key decisions made and why
3. Current state of modified files
4. Unresolved issues or open questions

Output a concise summary in markdown format.
The summary should contain enough context for the assistant to continue the task.
```

> **TODO (P2)**：Claude Code 使用两阶段 summary prompt（`<analysis>` 起草 + `<summary>` 最终输出），analysis 部分被丢弃不浪费 context。P1 使用简单 prompt。

### 摘要请求参数

- `max_tokens`: 20,000（`compact_max_output_tokens`）
- `model`: 与主对话相同
- 不传 tools（摘要请求不需要工具调用）

### 持久化：写入 JSONL

生成摘要后，创建 `TranscriptEntry::Summary` 写入 JSONL：

```rust
TranscriptEntry::Summary {
    session_id: session_id.clone(),
    leaf_uuid: last_summarized_entry_uuid,  // 摘要覆盖的最后一条 entry
    summary: llm_generated_summary,
}
```

### JSONL 加载逻辑

`load_history` 返回值改为 `LoadHistoryResult`，将 entries 和摘要分离：

```rust
pub struct LoadHistoryResult {
    pub entries: Vec<TranscriptEntry>,   // leaf_uuid 之后的 entries（或全部）
    pub conversation_summary: Option<String>,  // 摘要文本（如果有 Summary entry）
}
```

加载流程：

```
1. 读取全部 entries
2. 查找最新 Summary entry
3. 如果找到：
   a. 提取 summary 文本到 conversation_summary
   b. entries = leaf_uuid 之后的 entries
4. 如果没有：
   a. entries = 全部 entries
   b. conversation_summary = None
```

**不构造合成 System entry**。摘要通过 `DynamicContext.conversation_summary` 注入 PromptManager 的 system prompt。这样 `history_to_api_messages` 和 `TranscriptEntry::System` 的处理逻辑不需要修改。

### 熔断器

连续 3 次压缩失败后停止重试，返回错误。防止 API 异常时无限循环。

> **vs Claude Code**：Claude Code 曾有 session 连续失败 3,272 次的案例（BQ 数据），熔断器是必要的防护。

---

## Token 计数：混合策略

### 原理

利用 API 返回的精确 `input_tokens` 作为基线，只粗估增量部分。

```
首次 API 调用：全部粗估
  estimated = estimate_messages(&all_messages)

后续 API 调用：
  estimated = last_input_tokens + estimate_entries(&new_entries[counted..])
```

### 增量跟踪

在 AgentLoop 的 while-true 循环中维护 `counted_entries: usize`：

```rust
// API 调用后更新
last_input_tokens = Some(response.usage.input_tokens);
counted_entries = new_entries.len();
```

这样增量 = `new_entries[counted_entries..]` — 只有工具执行后新增的 entries。

**压缩后的计数一致性**：压缩会改变 messages 内容，但 `last_input_tokens` 始终反映**最后一次 API 调用实际发送的 token 数**。压缩后下一次 API 返回的 `input_tokens` 自动反映新状态。

---

## AgentLoop 集成

```
run_turn loop {
    let all_messages = history_to_api_messages(&history)
        + entries_to_api_messages(&new_entries);

    // 第一层：始终裁剪
    let trimmed = context_manager.trim_old_tool_results(all_messages);

    // Token 估算
    let estimated = context_manager.estimate_total(&new_entries, counted_entries);

    // 第二层：按需压缩
    let (final_messages, summary_entry) = if estimated > compact_threshold {
        context_manager.compact_with_llm(trimmed, provider, model).await?
    } else {
        (trimmed, None)
    };

    // 调用 LLM
    let response = provider.chat_stream(final_messages, model, tools).await;

    // 更新精确计数
    context_manager.update_usage(response.usage.input_tokens);
    counted_entries = new_entries.len();

    // ... tool_use 处理 ...
}
```

`chat.rs` 变更：如果 `summary_entry` 存在，追加到返回的 entries 中一起写入 JSONL。

---

## AppState 变更

```rust
pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub tool_registry: Arc<ToolRegistry>,
    pub global_perms: PermissionContext,
    pub context_config: ContextConfig,         // NEW
}
```

`ContextConfig` 在 `lib.rs` 初始化时从 `config.toml` 读取（或使用默认值）。`ContextManager` 在每次 `send_message` 时从 `ContextConfig` + `TokenBudget` 创建。

---

## 新增文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/services/context_manager.rs` | ContextManager, TokenBudget, ContextConfig, 裁剪/压缩逻辑 |

## 修改文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/services/agent_loop.rs` | 集成 ContextManager（裁剪、估算、压缩、计数更新） |
| `src-tauri/src/db/jsonl.rs` | `load_history` 返回 `LoadHistoryResult`，增加 Summary 识别逻辑 |
| `src-tauri/src/commands/chat.rs` | 传递 ContextConfig，处理 Summary entry |
| `src-tauri/src/lib.rs` | AppState 增加 ContextConfig |
| `src/types/index.ts` | 新增 ContextEvent 类型（warning 等） |

## 约束

- `services/context_manager.rs` 不 import tauri
- 摘要请求不传 tools（减少 token 消耗）
- 摘要输出上限 20,000 tokens
- 第一层裁剪不修改 JSONL（仅内存）
- 第二层压缩写入 JSONL（Summary entry，append-only）
- 固定缓冲区阈值（非百分比）

## 已知限制

- **Prompt cache 破坏**：两层压缩都修改 messages 内容，破坏上一轮 API 建立的 prompt cache。
  TODO (P2)：Cached Microcompact 通过 API cache_edits 避免。
- **摘要 API 成本**：每次 LLM 摘要消耗一次 API 调用。
  TODO (P2)：Session Memory Compaction（免 API 调用）。
- **摘要请求 PTL**：对话接近上限时，摘要请求本身也可能 prompt_too_long。
  TODO：PTL 重试（从最旧 group 开始丢弃，最多 3 次）。
- **压缩粒度**：不能拆散 tool_use + tool_result 配对。
  当前设计按 API round group 整体处理，已满足。
- **首次调用精度低**：首次 API 调用前全部粗估，精度约 80%。
  可接受：首次调用时对话较短，粗估误差在安全范围内。

---

## 与 agent-benchmark 维度对照

### 2. Context 工程

| 设计点 | Claude Code | 本 spec P1 | 差距 |
|--------|------------|-----------|------|
| 多层压缩 | 5 层梯度响应 | 2 层（裁剪 + 摘要） | P2 加 Session Memory |
| Token 计数 | API usage + 粗估 | 混合策略（一致） | 基本对齐 |
| 触发阈值 | 固定缓冲区 13K | 固定缓冲区 13K（一致） | 对齐 |
| 工具结果预算 | applyToolResultBudget | K=10 tool_result + 引用标记 | 基本对齐 |
| 熔断器 | 3 次失败 | 3 次失败（一致） | 对齐 |
| Prompt cache 保护 | Cached Microcompact | 不保护 | TODO (P2) |
| Session Memory | 后台持续提取 9 section | 不涉及 | TODO (P2) |
| 摘要两阶段 prompt | analysis + summary | 简单 prompt | TODO (P2) |
| 压缩后重注入 | 重新注入最近 5 个文件 | 不涉及 | TODO (需 DataContext) |

### 其他维度

Context 工程外的维度不受本模块影响，已在 AgentLoop spec 中评估。
