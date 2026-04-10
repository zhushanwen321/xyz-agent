# P2-orchestrate 设计规格

**版本**: v1 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

提供递归任务编排能力。Agent 可自主拆分任务，创建 Orchestrator（可递归）或 Executor（叶节点），支持双向反馈和 Agent 持久化复用。

## 与 dispatch_agent 的边界

- dispatch_agent：一次性 SubAgent，无上下文持久化
- orchestrate：递归编排 + Agent 持久化 + 双向反馈

---

## orchestrate 工具 Schema

```json
{
  "name": "orchestrate",
  "description": "创建编排节点。Orchestrator 可递归调用本工具，Executor 为叶节点执行者。支持 Agent 复用。",
  "input_schema": {
    "type": "object",
    "properties": {
      "task_description": { "type": "string", "description": "任务描述" },
      "agent_type": { "enum": ["orchestrator", "executor"], "description": "节点类型" },
      "target_agent_id": { "type": "string", "description": "复用已有空闲 Agent（可选）" },
      "directive": { "type": "string", "description": "给子 Agent 的执行指令" },
      "sync": { "type": "boolean", "default": true, "description": "true=阻塞等待，false=后台执行" },
      "token_budget": { "type": "integer", "description": "token 预算覆盖（可选）" },
      "max_turns": { "type": "integer", "description": "最大轮次覆盖（可选）" }
    },
    "required": ["task_description", "agent_type", "directive"]
  }
}
```

- `is_concurrent_safe() → false`
- `timeout_secs() → 600`

---

## 核心类型

### NodeRole

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NodeRole {
    #[serde(rename = "orchestrator")]
    Orchestrator,  // 可调用 orchestrate，可管理子节点
    #[serde(rename = "executor")]
    Executor,      // 不能调用 orchestrate，叶节点执行者
}
```

### OrchestrateNode

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename = "orchestrate_node")]
pub struct OrchestrateNode {
    pub node_id: String,               // uuid 生成
    pub parent_id: Option<String>,     // 父节点 ID
    pub session_id: String,
    pub role: NodeRole,
    pub depth: u32,                     // 当前深度（root=0）
    pub description: String,
    pub status: OrchestrateStatus,
    pub directive: String,              // 当前执行指令
    pub agent_id: String,              // 持久化 Agent ID
    pub conversation_path: PathBuf,    // 对应的 JSONL 路径
    pub output_file: Option<PathBuf>,
    // 预算
    pub budget: TaskBudget,
    pub usage: TaskUsage,
    // 子节点
    pub children_ids: Vec<String>,
    // 反馈
    pub feedback_history: Vec<FeedbackMessage>,
    // 复用
    pub reuse_count: u32,              // 被复用次数
    pub last_active_at: String,        // 最后活跃时间
    // 控制
    pub kill_requested: bool,
}
```

### OrchestrateStatus 状态机

```
pending → running → completed
                 → failed
                 → budget_exhausted
running → idle            ← run_turn 结束，等待复用
idle → running            ← 被复用，追加新任务
running ⇄ paused          ← 用户干预
running/paused/idle → killed  ← 级联终止
idle → completed          ← 10分钟超时
```

### FeedbackMessage

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackMessage {
    pub timestamp: String,
    pub direction: FeedbackDirection,
    pub message: String,
    pub severity: FeedbackSeverity,
}

pub enum FeedbackDirection {
    ChildToParent,
    ParentToChild,
}

pub enum FeedbackSeverity {
    Info,     // 继续执行
    Warning,  // 继续执行
    Error,    // 暂停等待父节点响应
}
```

---

## 执行模型

### 同步 + 异步混合

与 dispatch_agent 相同模式：
- `orchestrate(sync=true)`：阻塞等待子节点完成，结果通过 tool_result 返回
- `orchestrate(sync=false)`：立即返回 node_id，结果在 Orchestrator 下一次 LLM 调用时注入

### Orchestrator 的工作方式

Orchestrator 运行独立 AgentLoop，其工具集包含：
- `orchestrate`（创建子节点）
- `feedback`（双向通信）
- `Read`（只读观察）
- `Bash`（受限执行，如 ls、find）

Orchestrator 在 AgentLoop 中可以：
1. 思考任务分解策略
2. 调用 `orchestrate` 创建子节点（同步或异步）
3. 等待结果（同步阻塞或异步注入）
4. 综合结果，决定是否需要调整
5. 可选：复用空闲 Agent 或创建新 Agent

---

## 深度控制

- 深度存储在 `OrchestrateNode.depth`，子节点 depth = 父 depth + 1
- MAX_DEPTH = 5
- 达到限制时**自动降级**：`agent_type=orchestrator` 被强制改为 `executor`
- Executor 不能调用 `orchestrate`（类型限制）
- 降级行为对 LLM 透明（工具仍可用，但创建的是 Executor）

---

## 预算分配

- Orchestrator 在 `orchestrate` 参数中**显式指定**子节点预算
- 不传时用模板默认值：
  - Orchestrator：80K tokens, 15 turns
  - Executor：50K tokens, 20 turns
- 主 Agent 调用 `orchestrate` 时预算由 `token_budget` 参数控制，不传用 Orchestrator 默认值

---

## Feedback 机制（编排专用）

### 分级反馈

- `severity=info/warning`：通知性质，Executor 继续执行，feedback 存入 `feedback_history`
- `severity=error`：Executor 暂停执行，feedback 工具阻塞等待 Orchestrator 的响应作为 tool_result 返回

### 反馈频率限制

每个 Executor 每分钟最多 10 次 feedback 调用（info+warning+error 合计）。超出后 feedback 工具返回错误提示。

### 反馈持久化

feedback 消息存入：
1. `OrchestrateNode.feedback_history`（内存 + TaskTree）
2. 主 session JSONL（作为 TranscriptEntry）

---

## Agent 持久化与复用

### 空闲判定

Executor 的 `run_turn` 结束后自动标记为 `idle`（非 completed）。Orchestrator 的 run_turn 结束后也标记为 idle。

### 复用流程

```
1. Orchestrator 调用 orchestrate(target_agent_id="A", directive="新任务")
2. 系统检查：Agent A 存在、status=idle、所有权匹配
3. 将 directive 作为 user message 追加到 Agent A 的 JSONL
4. 从 JSONL 重新构建 api_messages（含完整历史）
5. 分配新预算（从 0 开始），之前 usage 保留在 OrchestrateNode 中
6. 恢复 AgentLoop（新建 run_turn，history 从 JSONL 加载）
```

### 上下文窗口管理

复用时检查 api_messages 是否超过 context_window。超过则触发 compact：
- 使用已有的 compact 逻辑压缩历史
- compact 后继续执行

### 空闲超时

Agent 空闲 10 分钟后自动清理：status 改为 completed，JSONL 保留在磁盘，内存引用释放。

### 所有权

Agent 只能被**创建者**复用。跨父节点复用禁止。

---

## 级联终止

### 终止信号传播

```rust
impl TaskTree {
    pub async fn request_kill_tree(&self, node_id: &str) {
        // 递归遍历所有子节点
        // 设置 kill_requested = true
        // 子节点 AgentLoop 下一轮检查到 kill → break
    }
}
```

### 触发条件

- 用户在前端点击终止节点
- 父节点预算耗尽（BudgetGuard → Stop）
- 父节点被终止（递归传播）

### 部分结果

终止时收集已有结果，标记 `status=partial`，沿树向上回传。

---

## 事件系统

### 新增 AgentEvent 变体

```rust
OrchestrateNodeCreated { session_id, node_id, parent_id, role, depth, description, budget }
OrchestrateNodeProgress { session_id, node_id, usage }
OrchestrateNodeCompleted { session_id, node_id, status, result_summary, usage }
OrchestrateNodeIdle { session_id, node_id }  // Agent 进入空闲
OrchestrateFeedback { session_id, node_id, direction, message, severity }
BudgetWarning { session_id, task_id: String, usage_percent }
```

节流：Progress ≤1次/2s，BudgetWarning 只发一次。

---

## 约束

- orchestrate 不 import tauri
- 禁止 Executor 调用 orchestrate
- MAX_DEPTH = 5，超限自动降级
- Agent 所有权：只有创建者可复用
- 空闲超时 10 分钟
- 级联终止
- feedback 频率限制：10次/分钟/Executor
