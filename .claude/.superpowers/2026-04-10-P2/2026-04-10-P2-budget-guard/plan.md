# P2-A: BudgetGuard + ConcurrencyManager 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 实现 SubAgent 的预算守护（token/turns/tool_calls 三重限制）和全局并发控制。

**Spec:** [2026-04-10-P2-budget-guard/spec.md](spec.md)

---

## Task 1: BudgetGuard

**Files:**
- Create: `src-tauri/src/engine/budget_guard.rs`

- [ ] **Step 1: 写 BudgetGuard 测试**

```rust
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
        assert!(!guard.increment_turn()); // turn 3 → blocked
    }

    #[test]
    fn diminishing_detection() {
        let mut guard = BudgetGuard::new(TaskBudget {
            max_tokens: 1_000_000,
            max_turns: 100,
            max_tool_calls: 100,
        });
        // 3 consecutive turns consuming <500 tokens each
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
        assert!(guard.should_warn()); // 50%+ used
        assert!(!guard.should_warn()); // 只触发一次
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现 BudgetGuard**

```rust
// engine/budget_guard.rs
use crate::engine::task_tree::TaskBudget;

const DIMINISHING_THRESHOLD: u32 = 500;
const DIMINISHING_CONSECUTIVE: u32 = 3;
const WARNING_THRESHOLD_PERCENT: u32 = 90;

pub struct BudgetGuard {
    budget: TaskBudget,
    tokens_used: u32,
    turns_used: u32,
    tool_calls_used: u32,
    low_turn_tokens: u32,  // 连续低消耗计数
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

    pub fn check_and_deduct_tokens(&mut self, tokens: u32) -> bool {
        if self.tokens_used + tokens > self.budget.max_tokens {
            return false;
        }
        // 追踪低消耗
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

    pub fn is_diminishing(&self) -> bool {
        self.low_turn_tokens >= DIMINISHING_CONSECUTIVE
    }

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
```

- [ ] **Step 4: 运行测试**

Run: `cd src-tauri && cargo test budget_guard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/engine/budget_guard.rs src-tauri/src/engine/mod.rs
git commit -m "feat(P2-A): add BudgetGuard with token/turn/tool_call limits and diminishing detection"
```

---

## Task 2: ConcurrencyManager

**Files:**
- Create: `src-tauri/src/engine/concurrency.rs`

- [ ] **Step 1: 写并发控制测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn allows_up_to_max_concurrent() {
        let mgr = ConcurrencyManager::new(2);
        let p1 = mgr.acquire().await.unwrap();
        let p2 = mgr.acquire().await.unwrap();
        // 第三个需要等待
        let mgr_clone = mgr.clone();
        let handle = tokio::spawn(async move {
            mgr_clone.acquire().await
        });
        // 释放一个
        drop(p1);
        let p3 = handle.await.unwrap().unwrap();
        drop(p2);
        drop(p3);
    }

    #[test]
    fn reports_active_count() {
        let mgr = ConcurrencyManager::new(3);
        assert_eq!(mgr.active_count(), 0);
    }
}
```

- [ ] **Step 2: 实现 ConcurrencyManager**

```rust
// engine/concurrency.rs
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct ConcurrencyManager {
    semaphore: Arc<Semaphore>,
    active_count: Arc<AtomicUsize>,
}

impl ConcurrencyManager {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            active_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn acquire(&self) -> Result<ConcurrencyPermit, String> {
        let permit = self.semaphore.clone().acquire_owned().await
            .map_err(|_| "concurrency semaphore closed")?;
        self.active_count.fetch_add(1, Ordering::Relaxed);
        Ok(ConcurrencyPermit {
            _permit: permit,
            active_count: self.active_count.clone(),
        })
    }

    pub fn active_count(&self) -> usize {
        self.active_count.load(Ordering::Relaxed)
    }
}

pub struct ConcurrencyPermit {
    _permit: tokio::sync::OwnedSemaphorePermit,
    active_count: Arc<AtomicUsize>,
}

impl Drop for ConcurrencyPermit {
    fn drop(&mut self) {
        self.active_count.fetch_sub(1, Ordering::Relaxed);
    }
}
```

- [ ] **Step 3: 运行测试**

Run: `cd src-tauri && cargo test concurrency`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/engine/concurrency.rs src-tauri/src/engine/mod.rs
git commit -m "feat(P2-A): add ConcurrencyManager with Semaphore-based global concurrency control"
```

---

## Task 3: AgentTemplateRegistry

**Files:**
- Create: `src-tauri/src/engine/agent_template.rs`

- [ ] **Step 1: 写模板测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_builtin_template() {
        let registry = AgentTemplateRegistry::new();
        let explore = registry.get("Explore").unwrap();
        assert!(explore.tools.contains(&"read".to_string()));
        assert!(explore.read_only);
        assert_eq!(explore.default_budget.max_tokens, 50_000);
    }

    #[test]
    fn excludes_dispatch_tools() {
        let registry = AgentTemplateRegistry::new();
        let explore = registry.get("Explore").unwrap();
        assert!(!explore.tools.contains(&"dispatch_agent".to_string()));
        assert!(!explore.tools.contains(&"orchestrate".to_string()));
    }
}
```

- [ ] **Step 2: 实现 AgentTemplateRegistry**

```rust
// engine/agent_template.rs
use crate::engine::task_tree::TaskBudget;
use std::collections::HashMap;

pub struct AgentTemplate {
    pub name: String,
    pub tools: Vec<String>,
    pub read_only: bool,
    pub default_budget: TaskBudget,
    pub system_prompt_key: String,  // PromptManager 中的 key
}

pub struct AgentTemplateRegistry {
    templates: HashMap<String, AgentTemplate>,
}

impl AgentTemplateRegistry {
    pub fn new() -> Self {
        let mut templates = HashMap::new();
        templates.insert("Explore".into(), AgentTemplate {
            name: "Explore".into(),
            tools: vec!["read".into(), "bash".into()],
            read_only: true,
            default_budget: TaskBudget { max_tokens: 50_000, max_turns: 20, max_tool_calls: 50 },
            system_prompt_key: "explore".into(),
        });
        templates.insert("Plan".into(), AgentTemplate {
            name: "Plan".into(),
            tools: vec!["read".into(), "bash".into()],
            read_only: true,
            default_budget: TaskBudget { max_tokens: 80_000, max_turns: 15, max_tool_calls: 40 },
            system_prompt_key: "plan".into(),
        });
        templates.insert("general-purpose".into(), AgentTemplate {
            name: "general-purpose".into(),
            tools: vec!["read".into(), "write".into(), "bash".into(), "feedback".into()],
            read_only: false,
            default_budget: TaskBudget { max_tokens: 200_000, max_turns: 50, max_tool_calls: 200 },
            system_prompt_key: "general_purpose".into(),
        });
        Self { templates }
    }

    pub fn get(&self, name: &str) -> Option<&AgentTemplate> {
        self.templates.get(name)
    }
}
```

- [ ] **Step 3: 运行测试**

Run: `cd src-tauri && cargo test agent_template`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/engine/agent_template.rs src-tauri/src/engine/mod.rs
git commit -m "feat(P2-A): add AgentTemplateRegistry with Explore/Plan/general-purpose templates"
```
