# P2-dispatch_agent + SubAgent 生命周期 设计规格

**版本**: v1 | **日期**: 2026-04-10 | **状态**: 设计中

---

## dispatch_agent 工具

### 输入 Schema

```json
{
  "name": "dispatch_agent",
  "description": "启动子 Agent 处理复杂任务。可用模板：Explore(只读搜索)、Plan(只读规划)、general-purpose(全能)。Fork 模式继承父 Agent 上下文。",
  "input_schema": {
    "type": "object",
    "properties": {
      "description": { "type": "string", "description": "3-5 词任务摘要" },
      "prompt": { "type": "string", "description": "子 Agent 要执行的任务指令" },
      "mode": { "enum": ["preset", "fork"], "default": "preset", "description": "preset=模板+参数，fork=继承父上下文" },
      "subagent_type": { "type": "string", "description": "Agent 模板名（preset 模式必填）" },
      "run_in_background": { "type": "boolean", "default": false },
      "token_budget": { "type": "integer", "description": "token 预算，不填用模板默认值" },
      "max_turns": { "type": "integer", "description": "最大轮次，不填用模板默认值" }
    },
    "required": ["description", "prompt"]
  }
}
```

### ToolExecutionContext

dispatch_agent 需要额外上下文，通过 `ToolExecutionContext` 注入：

```rust
pub struct ToolExecutionContext {
    pub task_tree: Arc<TaskTree>,
    pub agent_templates: Arc<AgentTemplateRegistry>,
    pub provider: Arc<dyn LlmProvider>,
    pub config: Arc<AgentConfig>,
    pub data_dir: PathBuf,
    pub session_id: String,
    pub event_tx: UnboundedSender<AgentEvent>,
    // 以下用于 Fork 模式
    pub parent_messages: Vec<serde_json::Value>,
    pub last_assistant_content: Vec<AssistantContentBlock>,
}
```

其他工具的 context 为 None，dispatch_agent 的 context 在 ToolExecutor 层注入。

---

## Agent 模板

```rust
pub struct AgentTemplate {
    pub name: &'static str,
    pub system_prompt: &'static str,
    pub tool_filter: ToolFilter,
    pub default_model: Option<&'static str>,  // None = 继承父 model
    pub is_read_only: bool,
    pub default_budget: TaskBudget,
}

pub enum ToolFilter {
    All,                                   // 所有工具（排除 dispatch_agent）
    AllowList(&'static [&'static str]),    // 白名单
}
```

### 内置模板

| 模板 | 工具 | 只读 | 默认预算 |
|------|------|------|---------|
| Explore | Read, Bash | 是 | 50K tokens, 20 turns |
| Plan | Read, Bash | 是 | 80K tokens, 15 turns |
| general-purpose | Read, Write, Bash | 否 | 200K tokens, 50 turns |

所有模板的 tool_filter 始终排除 `dispatch_agent`（禁止嵌套）。

---

## SubAgent 执行流程

### Preset 模式

```
1. 查找 AgentTemplate → 获取 system_prompt + tool_filter + default_budget
2. 过滤 ToolRegistry → 生成子 Agent 的 tool_schemas
3. 构建 DynamicContext → cwd=os=model=继承, git_branch=None, tool_names=过滤后列表
4. 创建 BudgetGuard（显式参数 > 模板默认值）
5. 注册 TaskNode 到 TaskTree
6. 发送 TaskCreated 事件
7. 调用 AgentLoop::run_turn(prompt, [], None, event_tx, ...)
   - history 为空（零上下文）
   - prompt_manager 用模板的 system_prompt
   - tool_registry 为过滤后的子集
8. 等待完成 → 收集结果 → 截断 → 存文件
9. 更新 TaskNode → 发送 TaskCompleted 事件
10. 返回 tool_result（XML 通知）
```

### Fork 模式

```
1. 构建 byte-identical API 请求前缀
2. 复制父 Agent 的 parent_messages（完整历史）
3. 复制最后一条 assistant_content（含所有 ToolUse blocks）
4. 构造 user 消息：占位符 tool_result + Fork 指令
5. 创建 BudgetGuard（预算 = 父剩余预算或默认值）
6. 注册 TaskNode → 发送事件 → 执行 AgentLoop
7. AgentLoop.run_turn 使用 fork_messages 作为 history
   - system_prompt = 父 PromptManager 生成（相同前缀）
   - tools = 父工具集（相同前缀）
   → Anthropic API 命中父 Agent 的 prompt cache
```

### Fork 消息构建

```rust
const FORK_PLACEHOLDER: &str = "Forked subagent placeholder";

fn build_fork_messages(
    parent_messages: &[serde_json::Value],
    last_assistant_content: &[AssistantContentBlock],
    directive: &str,
) -> Vec<serde_json::Value> {
    let mut msgs = parent_messages.to_vec();
    // 复制 assistant 消息（byte-identical）
    msgs.push(json!({"role": "assistant", "content": last_assistant_content}));
    // 占位符 tool_result + 子指令
    let mut user_content: Vec<UserContentBlock> = last_assistant_content.iter()
        .filter_map(|b| match b {
            AssistantContentBlock::ToolUse { id, .. } => Some(UserContentBlock::ToolResult {
                tool_use_id: id.clone(),
                content: FORK_PLACEHOLDER.to_string(),
                is_error: false,
            }),
            _ => None,
        }).collect();
    user_content.push(UserContentBlock::Text { text: format_fork_directive(directive) });
    msgs.push(json!({"role": "user", "content": user_content}));
    msgs
}
```

### Fork 行为约束

注入到 Fork 子 Agent 的 system prompt 尾部：

```
你是 Fork 子 Agent。严格规则：
1. 禁止调用 dispatch_agent
2. 只执行指令范围内的任务
3. 不要提问或建议后续步骤
4. 直接使用工具执行
5. 报告 ≤500 字，以 "范围:" 开头
```

---

## 结果回传

### 截断策略

- 结果截断到 100,000 字符（与 P1 工具输出上限一致）
- 完整输出保存到 `{data_dir}/tasks/output/{task_id}.txt`

### XML 通知格式

```xml
<task_notification>
  <task_id>{id}</task_id>
  <status>completed|failed|budget_exhausted</status>
  <result>{截断后的结果}</result>
  <output_file>{data_dir}/tasks/output/{id}.txt</output_file>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task_notification>
```

作为 `is_error: false`（成功）或 `is_error: true`（失败）的 tool_result 回传给父 Agent。父 Agent LLM 自然将其视为工具返回值。

### 错误结果

SubAgent 失败时返回：
```xml
<task_notification>
  <task_id>{id}</task_id>
  <status>failed</status>
  <result>Agent 执行失败: {error_message}</result>
  <usage>...</usage>
</task_notification>
```

预算耗尽时 status 为 `budget_exhausted`，result 包含已执行的部分结果。

---

## 同步 vs 异步

```rust
if run_in_background {
    // 异步：tokio::spawn 执行，立即返回 task_id
    let handle = tokio::spawn(async move { run_subagent(...) });
    // tool_result = "SubAgent 已启动，task_id: {id}"
} else {
    // 同步：在当前 task 中执行，阻塞等待结果
    let result = run_subagent(...).await;
    // tool_result = XML 通知
}
```

P2 优先实现同步模式（简单可靠）。异步模式预留接口，标记为 TODO。

---

## 约束

- dispatch_agent 不 import tauri
- 禁止嵌套（SubAgent 内 dispatch_agent 不可用）
- Fork 模式强制继承父 model（不同 model 无法共享 cache）
- 结果截断 ≤ 100K 字符
- 每个模板的 system_prompt 不 import tauri

## 已知限制

- **异步模式未实现** — P2 先做同步，异步标记 TODO
- **无 Agent 记忆** — SubAgent 无跨 session 记忆持久化
- **无 MCP 按需加载** — SubAgent 共享父 Agent 的 MCP 服务器
- **工具过滤简单** — 只有白名单，无 Claude Code 的多层过滤
