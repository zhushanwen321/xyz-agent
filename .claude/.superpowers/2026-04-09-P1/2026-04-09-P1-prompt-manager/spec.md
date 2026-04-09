# P1-PromptManager 设计规格

**版本**: v1 | **日期**: 2026-04-09 | **状态**: 已确认

---

## 目标

为 Agent 引擎添加系统提示词管理：静态/动态分层，支持 Anthropic API prompt cache 优化。

## 不包含

- Tool prompt() 动态函数（P2，每个工具的 prompt 按上下文动态生成）
- Anti-rationalization prompt（P2，预判模型合理化借口并要求做相反的事）
- Skill 注入（P3，通过 system-reminder 按需注入）
- CLAUDE.md / 项目配置注入（P2，读取项目目录下的配置文件注入动态层）
- Memory 注入（P2，跨会话记忆注入动态层）
- MCP instructions 注入（P3，MCP 服务器使用说明注入动态层）

## 参考

- Claude Code `src/constants/prompts.ts:getSystemPrompt()` — 静态/动态分层，DYNAMIC_BOUNDARY 分隔
- Claude Code `src/constants/systemPromptSections.ts` — 动态 section 管理、memoization
- Claude Code `src/Tool.ts:518` — Tool.prompt() 动态 prompt 函数
- Claude Code `src/tools/BashTool/prompt.ts` — 最长工具 prompt（~370 行），含工具交叉引用网络

---

## 核心类型

### PromptManager

```rust
pub struct PromptManager {
    static_prompt: String,  // 初始化时构建，不变
}

pub struct DynamicContext {
    pub cwd: String,
    pub os: String,
    pub model: String,
    pub git_branch: Option<String>,
    pub tool_names: Vec<String>,            // 可用工具名列表
    pub data_context_summary: Option<String>,  // DataContext 填充（已读取文件摘要）
    pub conversation_summary: Option<String>,  // ContextManager 填充（历史对话摘要）
}

impl PromptManager {
    pub fn new() -> Self {
        Self {
            static_prompt: include_str!("../prompts/system_static.md").to_string(),
        }
    }

    /// 构建完整 system prompt（带 cache breakpoint）
    /// 返回 Anthropic API system 参数格式
    pub fn build_system_prompt(&self, dynamic: &DynamicContext) -> Vec<serde_json::Value> {
        vec![
            json!({
                "type": "text",
                "text": self.static_prompt,
                "cache_control": {"type": "ephemeral"}
            }),
            json!({
                "type": "text",
                "text": self.render_dynamic(dynamic)
            }),
        ]
    }

    fn render_dynamic(&self, ctx: &DynamicContext) -> String {
        let mut parts = vec![
            format!("# Environment\n- OS: {}\n- CWD: {}", ctx.os, ctx.cwd),
            format!("- Model: {}", ctx.model),
        ];
        if let Some(branch) = &ctx.git_branch {
            parts.push(format!("- Git branch: {}", branch));
        }
        parts.push(format!("\n# Available Tools\n{}", ctx.tool_names.join(", ")));
        if let Some(summary) = &ctx.data_context_summary {
            parts.push(format!("\n# Data Context\n{}", summary));
        }
        if let Some(summary) = &ctx.conversation_summary {
            parts.push(format!("\n# Conversation Summary\n{}", summary));
        }
        parts.join("\n")
    }
}
```

### LlmProvider trait 变更

```rust
// Before（AgentLoop spec）
async fn chat_stream(
    &self,
    messages: Vec<serde_json::Value>,
    model: &str,
    tools: Option<Vec<serde_json::Value>>,
) -> Result<Pin<Box<dyn Stream<...>>>, AppError>;

// After
async fn chat_stream(
    &self,
    system: Vec<serde_json::Value>,          // NEW
    messages: Vec<serde_json::Value>,
    model: &str,
    tools: Option<Vec<serde_json::Value>>,
) -> Result<Pin<Box<dyn Stream<...>>>, AppError>;
```

`system` 为 Anthropic API 的 `system` 参数格式（content blocks 数组）。

### AnthropicProvider 请求体变更

```rust
// Before
let body = json!({
    "model": model,
    "messages": messages,
    "stream": true,
    // ...
});

// After
let mut body = json!({
    "model": model,
    "system": system,      // NEW
    "messages": messages,
    "stream": true,
    // ...
});
```

---

## 静态层

### 内容（P1 初始版）

存储在 `src-tauri/src/prompts/system_static.md`，通过 `include_str!` 编译时嵌入。

覆盖：
- **身份定义**：xyz-agent 是什么
- **行为准则**：自主完成任务、先读后改、精简响应
- **工具使用指南**：推荐/不推荐的使用方式（交叉引用网络）
- **输出格式**：Markdown、直接回答

### 设计要点

- 编译时嵌入（`include_str!`），零运行时开销
- 修改内容只需改 .md 文件 + 重新编译
- **不依赖**运行时状态（cwd、model、tools），保证缓存友好

> **TODO (P2)**：支持从 `~/.xyz-agent/prompts/` 加载用户自定义覆盖。

---

## 动态层

### 内容

每轮 API 调用时重新生成，包含：
- **环境信息**：OS、CWD、Model、Git branch
- **工具列表**：可用工具名称（注意：工具 schema 在 API `tools` 参数中，不重复）
- **DataContext 摘要**：已获取/计算的数据摘要（P1 为 None，预留接口）

### 缓存策略

动态层**不设 cache_control**。每次调用都会重新计算并发送。

由于静态层设了 `cache_control: ephemeral` 断点，Anthropic API 会：
1. 缓存静态层内容
2. 动态层变化不影响静态层缓存命中

> **vs Claude Code**：Claude Code 的动态层包含 Memory、MCP instructions、CLAUDE.md 等更多内容。P1 只包含基础环境信息。Claude Code 还使用 memoization（`/clear` 或 `/compact` 时重置）避免不必要的重算。

---

## history_to_api_messages 变更

```rust
// Before：System entry 被过滤
fn history_to_api_messages(history: &[TranscriptEntry]) -> Vec<serde_json::Value> {
    history.iter().filter_map(|entry| match entry {
        TranscriptEntry::User { .. } => Some(...),
        TranscriptEntry::Assistant { .. } => Some(...),
        _ => None,  // System 被过滤
    }).collect()
}

// After：System entry 仍然过滤，因为 system prompt 由 PromptManager 管理
// 不变。System entry 仅用于 JSONL 存储（如 ContextManager 的 Summary），
// 不作为 API system prompt 的一部分。
```

**不变**。System prompt 通过 `PromptManager.build_system_prompt()` 独立构建，不依赖 TranscriptEntry::System。TranscriptEntry::System 只在 ContextManager 摘要加载时用于构造合成消息。

---

## AgentLoop 集成

```rust
// AgentLoop::run_turn 中
let system = prompt_manager.build_system_prompt(&dynamic_context);
let final_messages = /* ... ContextManager 处理后的 messages ... */;
let stream = provider.chat_stream(system, final_messages, model, Some(tool_schemas)).await;
```

`PromptManager` 和 `DynamicContext` 在 `run_turn` 开始时创建一次，循环内不变。

---

## AppState 变更

```rust
pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub tool_registry: Arc<ToolRegistry>,
    pub global_perms: PermissionContext,
    pub context_config: ContextConfig,
    pub prompt_manager: PromptManager,       // NEW
}
```

`PromptManager` 不可变（静态内容编译时嵌入），用 `Arc` 或直接 clone 均可。

---

## 新增文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/services/prompt_manager.rs` | PromptManager, DynamicContext |
| `src-tauri/src/prompts/system_static.md` | 静态层 prompt 内容 |

## 修改文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/services/llm.rs` | LlmProvider trait 加 `system` 参数，AnthropicProvider 请求体加 `system` 字段 |
| `src-tauri/src/services/agent_loop.rs` | 集成 PromptManager，传递 system 给 provider |
| `src-tauri/src/commands/chat.rs` | 构建 DynamicContext |
| `src-tauri/src/lib.rs` | AppState 增加 PromptManager |

## 约束

- 静态层通过 `include_str!` 编译时嵌入，不运行时读取文件
- 动态层不设 cache_control
- System prompt 与 TranscriptEntry::System 解耦
- PromptManager 不 import tauri

## 已知限制

- **静态 prompt 不可热更新**：修改需要重新编译。
  TODO (P2)：支持从配置目录加载覆盖。
- **无 Tool prompt() 动态函数**：工具使用指南是静态文本，不根据权限/上下文变化。
  TODO (P2)：每个工具有 `prompt()` 方法，返回基于当前上下文的使用说明。
- **无 CLAUDE.md 注入**：项目级配置不会注入动态层。
  TODO (P2)：读取项目目录下 CLAUDE.md 注入。
- **工具引导网络简陋**：只有基本的"推荐/不推荐"，没有 Claude Code 级别的交叉引用。
  TODO (后续)：随工具增加逐步完善。
- **无 Skill 注入**：不通过 system-reminder 注入可用 skills。
  TODO (P3)：Skill 系统。

---

## 与 agent-benchmark 维度对照

### 1. Prompt 工程

| 设计点 | Claude Code | 本 spec P1 | 差距 |
|--------|------------|-----------|------|
| System Prompt 分层 | 静态 + 动态，DYNAMIC_BOUNDARY 分隔 | 静态 + 动态，cache_control 分隔 | 基本对齐 |
| Tool prompt | `prompt()` 动态函数，按权限/上下文组装 | 静态文本 | TODO (P2) |
| Prompt Cache | 全链路保护（排序、分层、fork identical） | 静态层 cache breakpoint | 基础对齐 |
| 工具引导网络 | 大量交叉引用（Bash 引用 Read/Grep/Glob） | 基本推荐/不推荐 | TODO (后续) |
| Few-shot | `<example>` + `<commentary>` 教思考模式 | 不涉及 | TODO (P2) |
| Anti-rationalization | 预判合理化借口并要求做相反的事 | 不涉及 | TODO (P2) |
| Skill 注入 | system-reminder 列表（1% 预算） | 不涉及 | TODO (P3) |
