# P2-dispatch_agent 设计规格

**版本**: v6 | **日期**: 2026-04-11 | **状态**: 设计中

---

## 目标

提供一次性 SubAgent 执行能力：同步/异步双模式、Preset/Fork 双模板、全局并发控制。SubAgent 执行完即释放，不保留上下文。

## 与 orchestrate 的边界

- dispatch_agent：一次性 SubAgent，无上下文持久化
- orchestrate：递归编排 + Agent 持久化（独立 spec）

---

## Tool trait 接口变更

```rust
// P2：增加 context 参数
async fn call(&self, input: serde_json::Value, ctx: Option<&ToolExecutionContext>) -> ToolResult;
```

**迁移策略**：
- `execute_batch` 和 `execute_single` 签名增加 `ctx: Option<&ToolExecutionContext>`
- 现有 P1 工具（Read/Write/Bash）内部 `let _ = ctx;`
- 仅在 `run_turn` 调用 `execute_batch` 时构建并传入 ctx

---

## AgentSpawner（分层架构解耦）

dispatch_agent 和 orchestrate 在工具 `call()` 内部需要创建并运行 AgentLoop，但 tools 层不应直接依赖 engine/loop_ 模块。通过 AgentSpawner trait 解耦：

```rust
// 定义在 engine 层，不在 tools 层
pub trait AgentSpawner: Send + Sync {
    fn spawn_agent(&self, config: SpawnConfig) -> Result<SpawnHandle, AppError>;
}

pub struct SpawnConfig {
    pub prompt: String,
    pub history: Vec<TranscriptEntry>,
    pub system_prompt_override: Option<String>,  // None = 用默认
    pub tool_filter: Option<Vec<String>>,         // 白名单
    pub budget: Option<TaskBudget>,
    pub event_tx: UnboundedSender<AgentEvent>,
    pub sync: bool,                               // true=阻塞等待, false=后台
    // Fork 专用
    pub fork_api_messages: Option<Vec<serde_json::Value>>,
    pub fork_assistant_content: Option<Vec<AssistantContentBlock>>,
    // 运行时依赖
    pub dynamic_context: DynamicContext,
    pub permission_context: PermissionContext,
}

pub struct SpawnHandle {
    pub task_id: String,
    pub join_handle: Option<JoinHandle<Result<AgentResult, AppError>>>,
    // sync=true 时 join_handle = None（已等待完成）
    // sync=false 时 join_handle = Some（后台执行中）
}

pub struct AgentResult {
    pub entries: Vec<TranscriptEntry>,
    pub usage: TaskUsage,
    pub status: String,  // completed / failed / budget_exhausted
    pub output_file: Option<PathBuf>,
}
```

ToolExecutionContext 持有 `Arc<dyn AgentSpawner>`，dispatch_agent/orchestrate 通过它委托 AgentLoop 创建。

---

## ToolExecutionContext

```rust
pub struct ToolExecutionContext {
    pub agent_spawner: Arc<dyn AgentSpawner>,      // AgentLoop 创建委托
    pub task_tree: Arc<Mutex<TaskTree>>,
    pub concurrency_manager: Arc<ConcurrencyManager>,
    pub agent_templates: Arc<AgentTemplateRegistry>,
    pub data_dir: PathBuf,
    pub session_id: String,
    pub event_tx: UnboundedSender<AgentEvent>,
    // 由 run_turn 在 execute_batch 前填充
    pub api_messages: Vec<serde_json::Value>,
    pub current_assistant_content: Vec<AssistantContentBlock>,
    pub tool_registry: Arc<ToolRegistry>,
}
```

**构建时机**：`consume_stream` 返回后，`api_messages` 和 `current_assistant_content` 作为循环局部变量保存；`execute_batch` 调用前填入 ctx 的对应字段。每次循环迭代重新计算 `api_messages`（经过 compact/trim 后的版本），Fork 模式拿到的就是当前迭代可见的历史。

---

## PromptManager 可配置化

```rust
impl PromptManager {
    pub fn new() -> Self { /* include_str! */ }
    pub fn new_with_prompt(static_prompt: &str) -> Self {
        Self { static_prompt: static_prompt.to_string() }
    }
}
```

---

## dispatch_agent 工具 Schema

```json
{
  "name": "dispatch_agent",
  "description": "启动子 Agent 处理任务。sync=true 阻塞等待结果，sync=false 后台执行（下回合注入结果）。",
  "input_schema": {
    "type": "object",
    "properties": {
      "description": { "type": "string", "description": "3-5 词任务摘要" },
      "prompt": { "type": "string", "description": "子 Agent 的任务指令" },
      "mode": { "enum": ["preset", "fork"], "default": "preset" },
      "subagent_type": { "type": "string", "description": "模板名（preset 必填）" },
      "sync": { "type": "boolean", "default": true },
      "token_budget": { "type": "integer" },
      "max_turns": { "type": "integer" }
    },
    "required": ["description", "prompt"]
  }
}
```

- `is_concurrent_safe() → false`
- `timeout_secs() → 600`

---

## 同步模式 (sync=true)

```
1. 查找模板（preset）或使用 fork 上下文
2. 构建 SpawnConfig（过滤工具、预算、event_tx 等）
3. ctx.agent_spawner.spawn_agent(config) → 同步等待完成
4. 创建 TaskNode → 发送事件 → 写入 JSONL
5. 返回 XML ToolResult
```

AgentSpawner 内部：创建独立 channel + 桥接 task、子目录、BudgetGuard、调用 run_turn、收集 entries、写入 JSONL。这些逻辑封装在 AgentSpawner 实现中，tools 层不感知。

### 异常处理
- 模板不存在 → ToolResult::Error
- 预算耗尽 → 使用部分结果（截断到 100K）
- AgentLoop 错误 → status=failed，已有 entry 为部分结果
- 用户 kill → kill_requested 检测 → break → status=killed

---

## 异步模式 (sync=false)

```
1-6. 与同步模式相同
7. 不等待 run_turn，立即返回：
   <task_notification>
     <task_id>{id}</task_id><status>pending</status>
     <message>Task started in background</message>
   </task_notification>
8. SubAgent 在后台 tokio task 执行
9. JoinHandle 存入 AppState.background_tasks
```

### 下一回合注入

用户发送新消息时，`history_to_api_messages` 检查已完成的异步任务（从 TaskTree 或 AppState 读取），按创建时间排序。

**注入规则（保证消息交替性）**：
1. 检查 history 最后一条消息的 role
2. 如果最后一条是 `user`：注入 assistant + user 对
3. 如果最后一条是 `assistant`：将异步结果作为 text block 追加到该 assistant 的 content 中（不新建 assistant 消息），然后插入 user 消息

```json
// 情况 A：最后一条是 user
[
  {"role": "assistant", "content": "[Background task completed: {desc}]\n{result}"},
  {"role": "user", "content": "[System: 以上是异步任务结果，请结合用户消息处理]"},
  {"role": "user", "content": "用户实际消息"}
]

// 情况 B：最后一条是 assistant（当前回合中的 assistant）
// 异步结果追加到已有 assistant content 末尾，不新建消息
[
  {"role": "user", "content": "[System: 异步任务 {desc} 已完成，结果已就绪]"},
  {"role": "user", "content": "用户实际消息"}
]
```

失败任务：`"[FAILED] {desc}: {error_message}"`，遵循同样的交替性规则。

### 切换 Session

后台任务继续运行（不暂停）。前端切换 session 时停止接收 Progress 事件。切换回来时 `loadHistory` 从 JSONL 重新加载 TaskNode，不遗漏已完成的结果。仍在运行的任务恢复接收 Progress 事件。

---

## Fork 模式

```
1. 从 ctx 获取 api_messages（原始 API JSON）和 current_assistant_content
2. build_fork_messages(api_messages, current_assistant_content, prompt)
3. 预算 = min(父剩余, 100K)。主 Agent 无 BudgetGuard 时用 100K
4. PromptManager = 克隆父 PromptManager（byte-identical system prompt）
5. tool_schemas = 父 tool_schemas（排除 dispatch_agent + orchestrate）
6. PermissionContext 继承父 Agent
7. 运行 AgentLoop(fork_messages 作为 history)
```

### Prompt Cache 优化

Fork 模式的核心设计目标是**最大化 Anthropic Prompt Cache 命中率**。API 缓存键由 system prompt、tools 定义、model、messages prefix 组成。

优化策略：
1. `system_prompt_override` 传递父级**已渲染的字节**（不重新调用 PromptManager.get_system_prompt()，因为运行时条件可能变化导致结果不同）
2. `build_fork_messages` 中所有 tool_use block 使用**统一的 placeholder tool_result**，只有最后的 directive 文本块因子进程而异
3. 工具定义保持与父级一致（仅排除 dispatch_agent/orchestrate），确保 tools 缓存键匹配

```
父请求:   [system][tools][msg1]...[msgN]                           → cache 写入
Fork子级: [system][tools][msg1]...[msgN][placeholder][directive]   → cache 命中
```

### 防递归双重防护

禁止 Fork 子级再次 fork（或调用 dispatch_agent/orchestrate），采用双层防护：

1. **工具过滤（主要）**：SpawnConfig.tool_filter 排除 `dispatch_agent` 和 `orchestrate`
2. **消息标记（兜底）**：`build_fork_messages` 在 directive 文本中注入隐藏标记（如 `<fork-context>` 标签），AgentLoop 启动时扫描 history 检测该标记，若存在则拒绝 dispatch_agent/orchestrate 调用

双层防护的原因：工具过滤是主要防线，但 autocompact 可能重写消息导致信息丢失，消息标记作为压缩安全的兜底。

---

## 全局并发控制

### ConcurrencyManager

```rust
pub struct ConcurrencyManager {
    max_concurrent: usize,                    // 配置项，默认 2
    active_count: AtomicUsize,                // 当前活跃数
    queue: tokio::sync::Semaphore,            // 信号量控制
}
```

- 全局限制，所有 session 共享
- 超出限制时 TaskNode status=pending，进入 FIFO 队列
- 排队期间不消耗预算
- 排队任务可被用户取消
- 同步模式下，排队阻塞 Main Agent 的 turn
- 某个活跃任务完成 → 从队列取出最早的 pending 任务 → 开始执行

配置：`AgentConfig.max_concurrent_subagents`，默认 2。

---

## 事件通道策略

SubAgent 创建独立 `mpsc::unbounded_channel()`。桥接 task 过滤：
- 转发：TaskProgress、TaskCompleted、BudgetWarning、TaskFeedback
- 丢弃：TextDelta、ThinkingDelta、ToolCallStart、ToolCallEnd

---

## Agent 模板

| 模板 | 工具 | 只读 | 默认预算 |
|------|------|------|---------|
| Explore | Read, Bash | 是 | 50K tokens, 20 turns |
| Plan | Read, Bash | 是 | 80K tokens, 15 turns |
| general-purpose | Read, Write, Bash | 否 | 200K tokens, 50 turns |

所有模板排除 `dispatch_agent` 和 `orchestrate`。

---

## Feedback 工具

```json
{
  "name": "feedback",
  "description": "向父 Agent 发送中间报告",
  "input_schema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" },
      "severity": { "enum": ["info", "warning", "error"], "default": "info" }
    },
    "required": ["message"]
  }
}
```

- 执行：通过主 event_tx 发送 TaskFeedback 事件
- 返回：ToolResult（确认已发送），SubAgent 继续执行
- 持久化：feedback 存入主 session JSONL 作为 TranscriptEntry
- 只有 general-purpose 模板包含此工具

---

## Token Usage 追踪

SubAgent usage **独立追踪**在 `TaskNode.usage`，不累加到 Main Agent 的 TokenUsage。前端 StatusBar 只显示 Main Agent 用量，TaskDetail 显示 SubAgent 独立用量。

---

## 权限冒泡策略

SubAgent 的权限交互根据执行模式不同：

- **sync=true（前台）**：SubAgent 的权限请求冒泡到前端，用户可以在 UI 中看到并批准/拒绝。PermissionContext 继承父 Agent 的审批状态。
- **sync=false（后台）**：SubAgent 使用 `should_avoid_permission_prompts = true`，遇到需要用户审批的操作直接拒绝（返回 ToolResult::Error）。后台 SubAgent 应只使用只读工具或已自动批准的工具。
- **Fork 模式**：权限模式为 `bubble`——权限请求冒泡到父级终端，但实际由父 Agent 当前的权限上下文决定（后台时等同于拒绝）。

---

## 前台超时转后台

sync=true 模式下，如果 SubAgent 执行时间超过 `AUTO_BACKGROUND_TIMEOUT_MS`（默认 120 秒），自动转为后台执行：

1. 检测超时后，返回部分 ToolResult 给父 Agent：`<task_notification><task_id>{id}</task_id><status>auto_backgrounded</status></task_notification>`
2. SubAgent 继续在后台执行
3. 结果通过异步注入机制在下回合注入
4. 前端同步卡片自动切换为后台样式（Sidebar 卡片）

此机制避免长时间运行的同步 SubAgent 阻塞主 Agent 的交互。

---

## 约束

- dispatch_agent 不 import tauri
- 禁止嵌套（SubAgent 内不能调用 dispatch_agent / orchestrate）
- Fork 强制继承父 model
- 结果截断 ≤100K 字符
- is_concurrent_safe = false
- TaskNode 的 uuid 使用 task_id（由 uuid 生成）
- Fork 子级 byte-identical system prompt（cache 优化）
- 防递归双重防护：工具过滤 + 消息标记
- 后台 SubAgent 不弹出权限请求
