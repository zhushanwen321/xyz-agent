# P2-BudgetGuard 设计规格

**版本**: v2 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

控制 SubAgent 资源消耗：硬预算上限 + 收益递减检测。

## 参考

- Claude Code `src/query/tokenBudget.ts` — DIMINISHING_THRESHOLD=500, 连续 3 轮

---

## BudgetGuard

```rust
pub struct BudgetGuard {
    budget: TaskBudget,
    usage: TaskUsage,
    turn_count: u32,               // 当前轮次计数
    diminishing_count: u32,        // 连续低产出轮次
    started_at: std::time::Instant,
    warned_90: bool,
}
```

### 检查逻辑

```rust
impl BudgetGuard {
    const DIMINISHING_THRESHOLD: u32 = 500;  // tokens
    const DIMINISHING_MAX_COUNT: u32 = 3;

    /// 每轮 AgentLoop 迭代后调用
    /// turn_total_tokens = input_tokens + output_tokens（来自 consume_stream 的 TokenUsage）
    pub fn check(&mut self, turn_total_tokens: u32) -> BudgetDecision {
        self.turn_count += 1;

        // 硬预算：token
        if self.usage.total_tokens + turn_total_tokens > self.budget.max_tokens {
            return BudgetDecision::Stop(StopReason::TokenBudgetExhausted);
        }
        // 硬预算：轮次
        if self.turn_count >= self.budget.max_turns {
            return BudgetDecision::Stop(StopReason::MaxTurnsReached);
        }
        // 硬预算：工具调用
        if self.usage.tool_uses >= self.budget.max_tool_calls {
            return BudgetDecision::Stop(StopReason::ToolCallLimit);
        }

        // 收益递减：连续 3 轮 total < 500 tokens
        if turn_total_tokens < Self::DIMINISHING_THRESHOLD {
            self.diminishing_count += 1;
        } else {
            self.diminishing_count = 0;
        }
        if self.diminishing_count >= Self::DIMINISHING_MAX_COUNT {
            return BudgetDecision::Stop(StopReason::DiminishingReturns);
        }

        // 更新 usage
        self.usage.total_tokens += turn_total_tokens;
        BudgetDecision::Continue
    }

    /// 工具调用后调用
    pub fn record_tool_use(&mut self) {
        self.usage.tool_uses += 1;
    }

    /// 更新 duration
    pub fn update_duration(&mut self) {
        self.usage.duration_ms = self.started_at.elapsed().as_millis() as u64;
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
    TokenBudgetExhausted,
    MaxTurnsReached,
    ToolCallLimit,
    DiminishingReturns,
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
    /// Fork 预算 = min(父剩余预算, 100K)
    pub fn for_fork(parent_remaining: u32) -> Self {
        Self { max_tokens: parent_remaining.min(100_000), max_turns: 30, max_tool_calls: 50 }
    }
}
```

主 Agent 通过 dispatch_agent 参数显式指定预算。不传则用模板默认值。

---

## AgentLoop 集成

```rust
// run_turn 新增参数
pub async fn run_turn(
    &self,
    ...
    budget_guard: Option<&mut BudgetGuard>,  // 可选
) -> Result<Vec<TranscriptEntry>, AppError>
```

主 Agent 运行时为 None，SubAgent 运行时为 Some。循环内：

```rust
// 每轮迭代后
if let Some(guard) = &mut budget_guard {
    guard.update_duration();
    if guard.should_warn_90() {
        event_tx.send(AgentEvent::BudgetWarning { ... });
    }
    let turn_total = result.usage.input_tokens + result.usage.output_tokens;
    match guard.check(turn_total) {
        BudgetDecision::Continue => {},
        BudgetDecision::Stop(reason) => break,
    }
}

// 工具执行后
if let Some(guard) = &mut budget_guard {
    guard.record_tool_use();
}
```

---

## 约束

- BudgetGuard 不 import tauri
- 收益递减阈值 500 tokens
- 90% 警告只触发一次
- check 接收 input+output 总和

## 已知限制

- **粗估 token** — 无精确 API usage 时用粗估
- **无预算协商** — SubAgent 无法请求追加
