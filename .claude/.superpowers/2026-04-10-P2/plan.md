# P2 多 Agent 系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 SubAgent 调度、递归任务编排和前端可视化，使 Agent 能分解复杂任务并协作完成。

**Architecture:** 双工具分离——dispatch_agent（一次性 SubAgent）和 orchestrate（递归编排），共享 TaskTree/BudgetGuard/Sidechain 基础设施。AgentSpawner trait 解耦 tools 层与 engine 层。前端通过 Chat Tab + Sidebar 双 Tab 展示。

**Tech Stack:** Rust (tokio, async-trait, serde, uuid) + Vue 3 (Composition API, Tailwind CSS) + Tauri v2

---

## 批次概览

| 批次 | 内容 | 前置依赖 | 子计划 |
|------|------|---------|--------|
| **P2-A** | TaskTree 类型 + BudgetGuard + ConcurrencyManager + dispatch_agent sync | P1 完成 | [task-tree](2026-04-10-P2-task-tree/plan.md) + [budget-guard](2026-04-10-P2-budget-guard/plan.md) + [dispatch-agent](2026-04-10-P2-dispatch-agent/plan.md) Part 1 |
| **P2-B** | dispatch_agent async + 事件通道桥接 + 异步注入 | P2-A | [dispatch-agent](2026-04-10-P2-dispatch-agent/plan.md) Part 2 |
| **P2-C** | Fork 模式 + AgentSpawner trait + prompt cache 优化 | P2-B | [dispatch-agent](2026-04-10-P2-dispatch-agent/plan.md) Part 3 |
| **P2-D** | orchestrate + 递归编排 + feedback + Agent 持久化复用 | P2-C | [orchestrate](2026-04-10-P2-orchestrate/plan.md) |
| **P2-E** | 前端完整 UI（Sidebar + Chat Tab + 树形视图 + 操作按钮） | P2-D 事件系统 | [frontend](2026-04-10-P2-frontend/plan.md) |

### 依赖图

```
P2-A ──→ P2-B ──→ P2-C ──→ P2-D ──→ P2-E
  │                              │
  └── TaskTree 类型定义 ◄─────────┘ (OrchestrateNode 复用)
  └── BudgetGuard ◄──────────────┘ (所有 Agent 共享)
  └── AgentEvent 扩展 ◄──────────┘ (前端消费)
```

### 验收标准

- P2-A: 单个同步 dispatch_agent 能执行并返回结果，TaskNode 写入 JSONL
- P2-B: 异步 dispatch_agent 完成后结果注入下一回合
- P2-C: Fork 模式共享父 Agent 上下文，prompt cache 命中
- P2-D: 3 层深度的编排树能正常创建/执行/终止
- P2-E: 前端实时展示 SubAgent 卡片和编排树，支持暂停/终止

---

## 文件清单

### 新增 Rust 文件

| 文件 | 职责 | 批次 |
|------|------|------|
| `engine/task_tree.rs` | TaskTree, TaskNode, OrchestrateNode, 共享类型 | P2-A |
| `engine/budget_guard.rs` | BudgetGuard, TaskBudget, TaskUsage | P2-A |
| `engine/concurrency.rs` | ConcurrencyManager (Semaphore) | P2-A |
| `engine/agent_template.rs` | AgentTemplate, AgentTemplateRegistry | P2-A |
| `engine/agent_spawner.rs` | AgentSpawner trait, SpawnConfig, SpawnHandle | P2-C |
| `engine/tools/dispatch_agent.rs` | dispatch_agent 工具实现 | P2-A |
| `engine/tools/feedback.rs` | feedback 工具实现 | P2-A |
| `engine/tools/orchestrate.rs` | orchestrate 工具实现 | P2-D |

### 修改 Rust 文件

| 文件 | 变更 | 批次 |
|------|------|------|
| `types/event.rs` | AgentEvent 新增 ~10 个变体 | P2-A |
| `types/transcript.rs` | 新增 TaskNode/OrchestrateNode/Feedback 变体 | P2-A |
| `engine/tools/mod.rs` | Tool trait 增加 ctx 参数 | P2-A |
| `engine/tools/{read,write,bash}/mod.rs` | call 签名增加 ctx, `let _ = ctx` | P2-A |
| `engine/loop_/mod.rs` | run_turn 增加 budget_guard + api_messages | P2-A |
| `engine/loop_/stream.rs` | consume_stream 返回 api_messages | P2-A |
| `engine/context/prompt.rs` | new_with_prompt() 方法 | P2-A |
| `api/mod.rs` | AppState 新增 TaskTree/ConcurrencyManager | P2-A |
| `store/jsonl.rs` | LoadHistoryResult 扩展 + sidechain 读写 | P2-A |
| `api/commands.rs` | get_history 返回扩展数据 | P2-E |

### 新增前端文件

| 文件 | 职责 | 批次 |
|------|------|------|
| `components/SubAgentCard.vue` | 内嵌/侧边栏 SubAgent 卡片 | P2-E |
| `components/SubAgentSidebar.vue` | 右侧 Sidebar 双 Tab 面板 | P2-E |
| `components/TaskTreeView.vue` | 编排树形视图 | P2-E |
| `components/TaskTreeNode.vue` | 递归树节点 | P2-E |
| `components/NodeInfoBar.vue` | 编排节点信息栏 | P2-E |

### 修改前端文件

| 文件 | 变更 | 批次 |
|------|------|------|
| `types/index.ts` | 新增 TaskNode, OrchestrateNode, 事件类型 | P2-E |
| `composables/useChat.ts` | taskNodes/orchestrateNodes 状态 + 新事件 | P2-E |
| `components/ToolCallCard.vue` | dispatch_agent 特殊渲染 | P2-E |
| `components/StatusBar.vue` | 活跃任务数指示 | P2-E |
| `components/ChatView.vue` | Tab 系统 + Sidebar 集成 | P2-E |
| `lib/tauri.ts` | 新增 Tauri commands（kill/pause/resume） | P2-E |

---

## 关键设计决策（实施时参考）

1. **Tool trait 迁移**：`call()` 增加 `ctx: Option<&ToolExecutionContext>`，现有 P1 工具用 `let _ = ctx` 忽略
2. **ID 前缀**：TaskNode 用 `da_` 前缀，OrchestrateNode 用 `or_` 前缀，后接 8 字符 base36
3. **AgentSpawner**：P2-C 阶段才引入，P2-A 的 dispatch_agent 直接调用 AgentLoop
4. **事件通道**：SubAgent 创建独立 mpsc channel，桥接 task 只转发 Task*/Budget*/Feedback 事件
5. **JSONL Sidechain**：子 Agent 对话存 `{data_dir}/{session_id}/subagents/{task_id}.jsonl`

---

## Spec 参考

| 模块 | Spec |
|------|------|
| dispatch_agent | [2026-04-10-P2-dispatch-agent/spec.md](2026-04-10-P2-dispatch-agent/spec.md) |
| orchestrate | [2026-04-10-P2-orchestrate/spec.md](2026-04-10-P2-orchestrate/spec.md) |
| task-tree | [2026-04-10-P2-task-tree/spec.md](2026-04-10-P2-task-tree/spec.md) |
| budget-guard | [2026-04-10-P2-budget-guard/spec.md](2026-04-10-P2-budget-guard/spec.md) |
| frontend | [2026-04-10-P2-frontend/spec.md](2026-04-10-P2-frontend/spec.md) |
