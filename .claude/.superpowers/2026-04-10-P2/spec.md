# P2 — 多 Agent 与任务编排 设计规格（总览）

**版本**: v2 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

1. **dispatch_agent**：一次性 SubAgent 执行（同步/异步、Preset/Fork）
2. **orchestrate**：递归任务编排（Orchestrator/Executor、Agent 持久化、双向反馈）

两个工具共享基础设施（BudgetGuard、TaskTree、Sidechain JSONL），但职责独立。

## 不包含

- P1 增强项（Glob/Grep/Edit 工具、CLAUDE.md 注入、Session Memory）— P2.x
- MCP 集成 — P3
- Skill 系统 — P3
- 深层 Orchestrator 的 system_prompt 动态调整 — P2.x

---

## 设计原则

1. **双工具分离** — dispatch_agent（简单 SubAgent）和 orchestrate（递归编排）独立
2. **同步 + 异步** — 两个工具都支持 sync 参数
3. **独立 usage** — SubAgent/Orchestrator 的 token usage 不累加到父 Agent
4. **全局并发** — ConcurrencyManager 控制所有 SubAgent 并发数
5. **Sidechain 持久化** — 子 Agent 对话存独立 JSONL，主 session 只存元数据
6. **级联终止** — 编排树终止信号递归传播
7. **Agent 持久化** — 编排模式下的 Agent 可空闲复用，上下文保留

## Sub-spec 文件

| 模块 | Spec 文件 | 用例 |
|------|----------|------|
| dispatch_agent + SubAgent 生命周期 | `2026-04-10-P2-dispatch-agent/spec.md` | `use-cases.md` |
| orchestrate + 递归编排 | `2026-04-10-P2-orchestrate/spec.md` | `use-cases.md` |
| TaskTree + OrchestrateNode + 持久化 | `2026-04-10-P2-task-tree/spec.md` | — |
| BudgetGuard + 收益递减 | `2026-04-10-P2-budget-guard/spec.md` | — |
| 前端展示 + 交互 | `2026-04-10-P2-frontend/spec.md` | — |

## 文件清单

### 新增 Rust 文件
- `src-tauri/src/engine/tools/dispatch_agent.rs` — dispatch_agent 工具
- `src-tauri/src/engine/tools/orchestrate.rs` — orchestrate 工具
- `src-tauri/src/engine/task_tree.rs` — TaskTree, TaskNode, OrchestrateNode
- `src-tauri/src/engine/concurrency.rs` — ConcurrencyManager
- `src-tauri/src/engine/agent_template.rs` — AgentTemplate, AgentTemplateRegistry
- `src-tauri/src/engine/budget_guard.rs` — BudgetGuard

### 修改 Rust 文件
- `src-tauri/src/types/event.rs` — AgentEvent 新增变体
- `src-tauri/src/types/transcript.rs` — TranscriptEntry 新增 TaskNode + Feedback 变体
- `src-tauri/src/engine/tools/mod.rs` — Tool trait 增加 ctx + 注册新工具
- `src-tauri/src/engine/tools/*.rs` — call 签名增加 ctx
- `src-tauri/src/engine/loop_/mod.rs` — run_turn 增加 budget_guard + api_messages 捕获
- `src-tauri/src/engine/context/prompt.rs` — new_with_prompt()
- `src-tauri/src/lib.rs` — AppState 新增 TaskTree + ConcurrencyManager + background_tasks
- `src-tauri/src/store/jsonl.rs` — LoadHistoryResult 新增 task_nodes + orchestrate_nodes
- `src-tauri/src/api/session.rs` — get_history 返回扩展数据

### 新增前端文件
- `src/components/TaskTreeView.vue` — 编排树面板
- `src/components/TaskTreeNode.vue` — 递归树节点
- `src/components/TaskDetail.vue` — 节点详情
- `src/components/SubAgentSidebar.vue` — 活跃 SubAgent 侧边栏

### 修改前端文件
- `src/types/index.ts` — TaskNode, OrchestrateNode, AgentEvent 新增变体
- `src/composables/useChat.ts` — taskNodes, orchestrateNodes 状态, 新事件处理
- `src/components/ToolCallCard.vue` — dispatch_agent/orchestrate 特殊渲染
- `src/components/StatusBar.vue` — 活跃任务数
- `src/components/ChatView.vue` — 集成侧边栏
