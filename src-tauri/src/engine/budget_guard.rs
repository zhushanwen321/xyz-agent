use crate::engine::task_tree::TaskBudget;

const DIMINISHING_THRESHOLD: u32 = 500;
const DIMINISHING_CONSECUTIVE: u32 = 3;
const WARNING_THRESHOLD_PERCENT: u32 = 90;

pub struct BudgetGuard {
    budget: TaskBudget,
    tokens_used: u32,
    turns_used: u32,
    tool_calls_used: u32,
    low_turn_tokens: u32,
    warning_sent: bool,
}

impl BudgetGuard {
    pub fn new(budget: TaskBudget) -> Self {
        Self {
            budget,
            tokens_used: 0,
            turns_used: 0,
            tool_calls_used: 0,
            low_turn_tokens: 0,
            warning_sent: false,
        }
    }

    /// 检查 token 预算是否足够，足够则扣减并返回 true
    pub fn check_and_deduct_tokens(&mut self, tokens: u32) -> bool {
        if self.tokens_used + tokens > self.budget.max_tokens {
            return false;
        }
        // 追踪低产出轮次，用于 diminishing detection
        if tokens < DIMINISHING_THRESHOLD {
            self.low_turn_tokens += 1;
        } else {
            self.low_turn_tokens = 0;
        }
        self.tokens_used += tokens;
        true
    }

    pub fn increment_turn(&mut self) -> bool {
        if self.turns_used >= self.budget.max_turns {
            return false;
        }
        self.turns_used += 1;
        true
    }

    pub fn increment_tool_use(&mut self) -> bool {
        if self.tool_calls_used >= self.budget.max_tool_calls {
            return false;
        }
        self.tool_calls_used += 1;
        true
    }

    /// 连续 3 轮 token 消耗低于阈值时触发，提示子 agent 可能在空转
    pub fn is_diminishing(&self) -> bool {
        self.low_turn_tokens >= DIMINISHING_CONSECUTIVE
    }

    /// 首次达到 90% token 用量时触发，只触发一次
    pub fn should_warn(&mut self) -> bool {
        if self.warning_sent {
            return false;
        }
        let percent = self.tokens_used * 100 / self.budget.max_tokens.max(1);
        if percent >= WARNING_THRESHOLD_PERCENT {
            self.warning_sent = true;
            return true;
        }
        false
    }

    pub fn usage_percent(&self) -> u32 {
        self.tokens_used * 100 / self.budget.max_tokens.max(1)
    }

    pub fn is_exhausted(&self) -> bool {
        self.tokens_used >= self.budget.max_tokens
            || self.turns_used >= self.budget.max_turns
            || self.tool_calls_used >= self.budget.max_tool_calls
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_guard_allows_within_limit() {
        let mut guard = BudgetGuard::new(TaskBudget {
            max_tokens: 10_000,
            max_turns: 5,
            max_tool_calls: 10,
        });
        assert!(guard.check_and_deduct_tokens(1000));
        assert!(guard.increment_turn());
        assert!(guard.increment_tool_use());
    }

    #[test]
    fn budget_guard_blocks_over_token_limit() {
        let mut guard = BudgetGuard::new(TaskBudget {
            max_tokens: 1000,
            max_turns: 100,
            max_tool_calls: 100,
        });
        assert!(guard.check_and_deduct_tokens(800));
        assert!(!guard.check_and_deduct_tokens(300)); // 800+300 > 1000
    }

    #[test]
    fn budget_guard_blocks_over_turn_limit() {
        let mut guard = BudgetGuard::new(TaskBudget {
            max_tokens: 1_000_000,
            max_turns: 2,
            max_tool_calls: 100,
        });
        assert!(guard.increment_turn()); // turn 1
        assert!(guard.increment_turn()); // turn 2
        assert!(!guard.increment_turn()); // turn 3 blocked
    }

    #[test]
    fn diminishing_detection() {
        let mut guard = BudgetGuard::new(TaskBudget {
            max_tokens: 1_000_000,
            max_turns: 100,
            max_tool_calls: 100,
        });
        guard.check_and_deduct_tokens(200);
        guard.increment_turn();
        guard.check_and_deduct_tokens(300);
        guard.increment_turn();
        guard.check_and_deduct_tokens(100);
        guard.increment_turn();
        assert!(guard.is_diminishing());
    }

    #[test]
    fn warning_threshold() {
        let mut guard = BudgetGuard::new(TaskBudget {
            max_tokens: 1000,
            max_turns: 100,
            max_tool_calls: 100,
        });
        guard.check_and_deduct_tokens(500);
        assert!(!guard.should_warn()); // 50% — below 90%

        guard.check_and_deduct_tokens(400); // 90% total
        assert!(guard.should_warn());
        assert!(!guard.should_warn()); // only fires once
    }

    #[test]
    fn is_exhausted() {
        let mut guard = BudgetGuard::new(TaskBudget {
            max_tokens: 100,
            max_turns: 100,
            max_tool_calls: 100,
        });
        assert!(!guard.is_exhausted());
        guard.check_and_deduct_tokens(100);
        assert!(guard.is_exhausted());
    }
}
