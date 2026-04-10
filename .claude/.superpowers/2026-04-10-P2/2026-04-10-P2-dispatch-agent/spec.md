# P2-dispatch_agent 设计规格

**版本**: v4 | **日期**: 2026-04-10 | **状态**: 设计中

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

现有工具实现接收 `ctx: Option<&ToolExecutionContext>`，P1 工具内部 `let _ = ctx;`。

---

## ToolExecutionContext

```rust
pub struct ToolExecutionContext {
    pub task_tree: Arc<Mutex<TaskTree>>,
    pub concurrency_manager: Arc<ConcurrencyManager>,  // 全局并发控制
    pub agent_templates: Arc<AgentTemplateRegistry>,
    pub provider: Arc<dyn LlmProvider>,
    pub config: Arc<AgentConfig>,
    pub prompt_manager: Arc<PromptManager>,
    pub data_dir: PathBuf,
    pub session_id: String,
    pub event_tx: UnboundedSender<AgentEvent>,
    // 由 run_turn 在 execute_batch 前填充
    pub api_messages: Vec<serde_json::Value>,
    pub current_assistant_content: Vec<AssistantContentBlock>,
    pub tool_registry: Arc<ToolRegistry>,
}
```

**构建时机**：`consume_stream` 返回后，将 `api_messages` 和 `current_assistant_content` 保存为 `run_turn` 局部变量；`execute_batch` 调用前填入 ctx。

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
2. 过滤工具（排除 dispatch_agent + orchestrate）
3. 创建 TaskNode(status=running, uuid=task_id, task_id 由 uuid 生成)
4. 发送 TaskCreated 事件
5. 创建独立 channel + 桥接 task
6. 创建 BudgetGuard
7. 创建子目录 {data_dir}/{session_id}/subagents/
8. AgentLoop::run_turn(prompt, [], None, sub_tx, filtered_registry, ..., Some(budget_guard))
9. 收集 entries → 写入独立 JSONL
10. 截断结果 ≤100K → 完整输出存文件
11. 更新 TaskNode → 写入主 JSONL（作为 TranscriptEntry 变体）
12. 发送 TaskCompleted 事件
13. 返回 XML ToolResult
```

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

用户发送新消息时，`history_to_api_messages` 检查已完成的异步任务，按创建时间排序，每个任务注入 assistant + user 对：

```json
[
  {"role": "assistant", "content": "[Background task completed: {desc}]\n{result}"},
  {"role": "user", "content": "[System: 以上是异步任务结果，请结合用户消息处理]"}
]
```

失败任务：`"[FAILED] {desc}: {error_message}"`，同样 assistant + user 对。

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

## 约束

- dispatch_agent 不 import tauri
- 禁止嵌套（SubAgent 内不能调用 dispatch_agent / orchestrate）
- Fork 强制继承父 model
- 结果截断 ≤100K 字符
- is_concurrent_safe = false
- TaskNode 的 uuid 使用 task_id（由 uuid 生成）
