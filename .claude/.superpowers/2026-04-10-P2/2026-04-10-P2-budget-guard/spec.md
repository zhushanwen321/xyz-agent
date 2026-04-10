# P2-BudgetGuard 设计规格

**版本**: v1 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

控制 SubAgent 的资源消耗：硬预算上限 + 收益递减检测，防止空转浪费。

## 参考

- Claude Code `src/query/tokenBudget.ts` — DIMINISHING_THRESHOLD=500, 连续 3 轮检测
- Claude Code 90% 预算警告

---

## BudgetGuard

```rust
pub struct BudgetGuard {
    budget: TaskBudget,
    usage: TaskUsage,
    diminishing_count: u32,       // 连续低产出轮次
    started_at: std::time::Instant,
    warned_90: bool,              // 是否已发 90% 警告
}
```

### 检查逻辑

```rust
impl BudgetGuard {
    const DIMINISHING_THRESHOLD: u32 = 500;  // tokens
    const DIMINISHING_MAX_COUNT: u32 = 3;

    pub fn check(&mut self, turn_output_tokens: u32) -> BudgetDecision {
        // 硬预算
        if self.usage.total_tokens >= self.budget.max_tokens {
            return BudgetDecision::Stop(StopReason::TokenBudgetExhausted);
        }
        if self.usage.tool_uses >= self.budget.max_tool_calls {
            return BudgetDecision::Stop(StopReason::ToolCallLimit);
        }

        // 收益递减：连续 3 轮 output < 500 tokens
        if turn_output_tokens < Self::DIMINISHING_THRESHOLD {
            self.diminishing_count += 1;
        } else {
            self.diminishing_count = 0;
        }
        if self.diminishing_count >= Self::DIMINISHING_MAX_COUNT {
            return BudgetDecision::Stop(StopReason::DiminishingReturns);
        }

        self.usage.total_tokens += turn_output_tokens;
        BudgetDecision::Continue
    }

    /// 90% 警告（只触发一次）
    pub fn should_warn_90(&mut self) -> bool {
        let threshold = (self.budget.max_tokens as f64 * 0.9) as u32;
        if !self.warned_90 && self.usage.total_tokens >= threshold {
            self.warned_90 = true;
            return true;
        }
        false
    }
}
```

### 决策类型

```rust
pub enum BudgetDecision {
    Continue,
    Stop(StopReason),
}

pub enum StopReason {
    TokenBudgetExhausted,    // token 用完
    ToolCallLimit,           // 工具调用次数用完
    DiminishingReturns,      // 连续 3 轮 < 500 tokens
    MaxTurnsReached,         // 由 AgentLoop.max_turns 控制
}
```

---

## 预算默认值

```rust
impl TaskBudget {
    pub fn for_explore() -> Self {
        Self { max_tokens: 50_000, max_turns: 20, max_tool_calls: 30 }
    }
    pub fn for_plan() -> Self {
        Self { max_tokens: 80_000, max_turns: 15, max_tool_calls: 20 }
    }
    pub fn for_general() -> Self {
        Self { max_tokens: 200_000, max_turns: 50, max_tool_calls: 100 }
    }
    pub fn for_fork(parent_remaining: u32) -> Self {
        Self { max_tokens: parent_remaining, max_turns: 30, max_tool_calls: 50 }
    }
}
```

主 Agent 通过 dispatch_agent 参数显式指定预算。不传则使用模板默认值。Fork 模式预算 = 父剩余预算或 100K 取较小值。

---

## AgentLoop 集成

BudgetGuard 作为 `Option<BudgetGuard>` 传入 run_turn。主 Agent 运行时为 None，SubAgent 运行时为 Some。

```rust
// run_turn 签名新增
pub async fn run_turn(
    &self,
    ...
    budget_guard: Option<BudgetGuard>,  // NEW
) -> Result<Vec<TranscriptEntry>, AppError>
```

循环内每轮迭代后：

```rust
if let Some(guard) = &mut budget_guard {
    // 90% 警告
    if guard.should_warn_90() {
        event_tx.send(AgentEvent::BudgetWarning {
            session_id: session_id.clone(),
            task_id: task_id.clone(),
            usage_percent: 90,
        });
    }
    // 预算检查
    match guard.check(output_tokens) {
        BudgetDecision::Continue => {},
        BudgetDecision::Stop(reason) => {
            // 终止循环，设置终止原因
            break;
        }
    }
}
```

---

## 约束

- BudgetGuard 不 import tauri
- 收益递减阈值 500 tokens 来自 Claude Code 经验值
- 90% 警告只触发一次
- 硬预算不区分 input/output tokens（简化）

## 已知限制

- **不区分 input/output** — 预算按总 token 计算，无法单独限制
- **粗估 token** — SubAgent 内部没有精确的 API usage，用粗估
- **无预算协商** — 不支持 SubAgent 请求追加预算（Claude Code 也无此功能）
