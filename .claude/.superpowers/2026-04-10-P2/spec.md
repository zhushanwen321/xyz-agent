# P2 — 多 Agent 与任务树 设计规格（总览）

**版本**: v1 | **日期**: 2026-04-10 | **状态**: 设计中

---

## 目标

Agent 能通过 `dispatch_agent` 工具创建 SubAgent，支持普通模式（模板+参数）和 Fork 模式（共享 prompt cache），前端展示任务树。

## 不包含

- P1 增强项（Glob/Grep/Edit 工具、CLAUDE.md 注入、Session Memory 等）— 推迟到 P2.x
- MCP 集成 — P3
- Skill 系统 — P3
- 嵌套 SubAgent — P2 禁止，SubAgent 内不能再创建 SubAgent

## 参考

- Claude Code `src/tools/AgentTool/` — SubAgent 创建、Fork 模式、工具过滤
- Claude Code `src/tools/AgentTool/forkSubagent.ts` — byte-identical prompt cache 共享
- Claude Code `src/tools/AgentTool/built-in/` — 预定义 Agent 类型（Explore/Plan）
- Claude Code `src/query/tokenBudget.ts` — 收益递减检测

---

## 设计原则

1. **统一执行** — SubAgent 与主 Agent 使用同一个 `AgentLoop::run_turn`
2. **两种模式** — Preset（零上下文模板）和 Fork（byte-identical 前缀共享 cache）
3. **硬预算 + 收益递减** — 创建时分配预算，运行时检测连续低产出自动终止
4. **结果截断 + 文件存储** — 通知 ≤ 100K 字符，完整输出存文件
5. **禁止嵌套** — dispatch_agent 在 SubAgent 内不可用
6. **混合持久化** — TaskNode 作为 TranscriptEntry 变体存 JSONL
7. **结构化通知** — XML 格式回传结果，含 usage 统计

## Sub-spec 文件

| 模块 | Spec 文件 |
|------|----------|
| dispatch_agent + SubAgent 生命周期 | `2026-04-10-P2-dispatch-agent/spec.md` |
| TaskTree + TaskNode + 持久化 | `2026-04-10-P2-task-tree/spec.md` |
| BudgetGuard + 收益递减检测 | `2026-04-10-P2-budget-guard/spec.md` |
| 前端任务树 + 事件系统 | `2026-04-10-P2-frontend/spec.md` |

## 文件清单

### 新增 Rust 文件
- `src-tauri/src/engine/tools/dispatch_agent.rs` — dispatch_agent 工具
- `src-tauri/src/engine/task_tree.rs` — TaskTree, TaskNode
- `src-tauri/src/engine/agent_template.rs` — AgentTemplate, AgentTemplateRegistry

### 修改 Rust 文件
- `src-tauri/src/types/event.rs` — AgentEvent 新增 TaskCreated/Progress/Completed/BudgetWarning
- `src-tauri/src/types/transcript.rs` — TranscriptEntry 新增 TaskNode 变体
- `src-tauri/src/engine/tools/mod.rs` — 注册 dispatch_agent
- `src-tauri/src/engine/loop_/mod.rs` — run_turn 可选接收 BudgetGuard
- `src-tauri/src/lib.rs` — AppState 新增 task_tree, agent_templates

### 新增前端文件
- `src/components/TaskTreeView.vue` — 任务树面板
- `src/components/TaskTreeNode.vue` — 递归树节点
- `src/components/TaskDetail.vue` — 节点详情

### 修改前端文件
- `src/types/index.ts` — TaskNode 类型, AgentEvent 新增变体
- `src/composables/useChat.ts` — taskNodes 状态, 新事件处理
- `src/components/ToolCallCard.vue` — dispatch_agent 特殊渲染
- `src/components/StatusBar.vue` — 活跃任务数
- `src/components/ChatView.vue` — 集成 TaskTreeView

## 与 agent-benchmark 维度对照

### 5. 子 Agent 调度

| 设计点 | Claude Code | 本 spec P2 | 差距 |
|--------|------------|-----------|------|
| SubAgent 创建 | AgentTool (单工具) | dispatch_agent (单工具) | 对齐 |
| Fork 模式 | byte-identical + placeholder result | 同 | 对齐 |
| Agent 模板 | Explore/Plan/Verify/General | Explore/Plan/General | 基本对齐 |
| 工具过滤 | 多层(全局→Agent→异步) | 单层(模板白名单) | 简化 |
| 权限继承 | bubble-up + shouldAvoidPrompts | PermissionContext 子集 | 基本对齐 |
| 结果截断 | 100K + 文件存储 | 同 | 对齐 |
| 禁止嵌套 | disallowedTools | 工具过滤排除 dispatch_agent | 对齐 |

### 4. Agent Loop（补充）

| 设计点 | Claude Code | 本 spec P2 | 差距 |
|--------|------------|-----------|------|
| 收益递减检测 | 3 轮 <500 tokens | 同 | 对齐 |
| 预算管理 | token budget + 90% 警告 | 硬预算 + 收益递减 + 90% 警告 | 对齐 |
| 子 Agent 独立 budget | 独立追踪 | 同 | 对齐 |
