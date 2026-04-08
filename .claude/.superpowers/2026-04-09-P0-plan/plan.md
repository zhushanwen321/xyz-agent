# P0 骨架与基础对话 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 跑通"用户输入 → Agent 调用 LLM → 流式输出到前端"的完整链路。

**Architecture:** Rust + Tauri v2 单进程架构。后端 services 层不依赖 Tauri，通过 Command 适配层桥接。存储采用 JSONL + parentUuid 链式。前端通过 Tauri Event 接收流式事件。

**Tech Stack:** Rust, Tauri v2, Vue 3, Tailwind CSS, shadcn-vue, reqwest, tokio, futures

**Spec:** [P0-骨架与基础对话.md](../2026-04-08-初步设计/P0-骨架与基础对话.md)

---

## 任务总览

| Task | 名称 | 子文档 |
|------|------|--------|
| 1 | 项目脚手架搭建 | [plan-A-基础设施.md](./plan-A-基础设施.md) |
| 2 | 数据模型与错误类型 | [plan-A-基础设施.md](./plan-A-基础设施.md) |
| 3 | JSONL 存储层 | [plan-A-基础设施.md](./plan-A-基础设施.md) |
| 4 | LLM Gateway | [plan-B-后端服务.md](./plan-B-后端服务.md) |
| 5 | AgentLoop 主循环 | [plan-B-后端服务.md](./plan-B-后端服务.md) |
| 6 | EventBus + Tauri Command 层 | [plan-B-后端服务.md](./plan-B-后端服务.md) |
| 7 | lib.rs 入口集成 | [plan-B-后端服务.md](./plan-B-后端服务.md) |
| 8 | 前端脚手架与类型定义 | [plan-C1-前端脚手架与类型.md](./plan-C1-前端脚手架与类型.md) |
| 9 | 前端组件 + Composables | [plan-C2-前端组件与联调.md](./plan-C2-前端组件与联调.md) |
| 10 | 端到端联调 | [plan-C2-前端组件与联调.md](./plan-C2-前端组件与联调.md) |

## P0 明确排除的功能（延后到 P1+）

以下功能在 spec 中提及，但 P0 阶段不实现：

- **auto-continue**（`AgentLoop` 中 `stop_reason != "end_turn"` 时自动继续）：P0 仅处理单轮请求-响应，不处理 `max_tokens` 用尽后的自动续写
- **read_head_and_tail**（大文件只读首尾 64KB 优化）：P0 使用 `read_all_entries` 全量读取，文件大小在 P0 阶段可控
- **上下文压缩**（三层压缩 50%/75%/90%）：P1 实现
- **thinking_delta 实际展示**：P0 后端解析 `ThinkingDelta` 事件但前端不单独展示思考过程

## 依赖关系

```
Task 1 (脚手架)
  ├── Task 2 (数据模型)
  │     ├── Task 3 (JSONL 存储)
  │     └── Task 4 (LLM Gateway) ← 只依赖 Task 2
  │           └── Task 5 (AgentLoop)
  │                 └── Task 6 (EventBus + Commands)
  │                       └── Task 7 (lib.rs 集成)
  └── Task 8 (前端脚手架) ← 只依赖 Task 1，可与 Task 2-7 并行
        └── Task 9 (前端组件)
              └── Task 10 (端到端联调) ← 需要 Task 7 完成
```

## 执行建议

- Task 1 必须先完成（所有后续任务依赖它）
- Task 2 完成后，Task 3 和 Task 4 可以并行
- Task 8 可以在 Task 2 之后与 Task 3-7 并行
- Task 10 是最终集成点，需要后端（Task 7）和前端（Task 9）都完成

## 文件清单

### Rust 后端（src-tauri/src/）

| 文件 | 职责 | Task |
|------|------|------|
| `main.rs` | 入口，调用 lib::run | 1 |
| `lib.rs` | Tauri Builder + setup | 1→7 |
| `error.rs` | AppError 统一错误类型 | 2 |
| `models/transcript.rs` | TranscriptEntry + TokenUsage | 2 |
| `models/event.rs` | AgentEvent 流式事件枚举 | 2 |
| `db/jsonl.rs` | JSONL 读写 + 链式回溯 | 3 |
| `db/session_index.rs` | Session 索引扫描 | 3 |
| `services/llm.rs` | LlmProvider trait + Anthropic | 4 |
| `services/agent_loop.rs` | AgentLoop 主循环 | 5 |
| `services/event_bus.rs` | mpsc → Tauri Event 桥接 | 6 |
| `commands/session.rs` | new/list/get_history | 6 |
| `commands/chat.rs` | send_message | 6 |

### Vue 前端（src/）

| 文件 | 职责 | Task |
|------|------|------|
| `types/index.ts` | TS 类型定义 | 8 |
| `lib/tauri.ts` | invoke/listen 封装 | 8 |
| `composables/useSession.ts` | Session 管理 | 9 |
| `composables/useChat.ts` | 对话+流式事件 | 9 |
| `components/Sidebar.vue` | Session 列表 | 9 |
| `components/ChatView.vue` | 消息列表主视图 | 9 |
| `components/MessageBubble.vue` | 单条消息气泡 | 9 |
| `components/MessageInput.vue` | 输入框 | 9 |
| `components/StatusBar.vue` | 状态栏 | 9 |
| `App.vue` | 主布局 | 9 |
