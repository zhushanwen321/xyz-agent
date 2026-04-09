# P1 实现计划 — 总览

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 xyz-agent 添加工具调用、上下文压缩、系统提示词管理能力。

**Architecture:** 6 个模块按依赖顺序实现：ToolRouter → Builtins → AgentLoop 多轮循环 → PromptManager → ContextManager → DataContext。前端更新与后端并行。

**Tech Stack:** Rust + Tauri v2 + tokio + serde_json + reqwest + Vue 3 + TypeScript

---

## Spec 参考

| 模块 | Spec 文件 |
|------|----------|
| ToolRouter | `.claude/.superpowers/2026-04-09-P1-toolrouter/spec.md` |
| Builtins | `.claude/.superpowers/2026-04-09-P1-builtins/spec.md` |
| AgentLoop 集成 | `.claude/.superpowers/2026-04-09-P1-agentloop-tools/spec.md` |
| ContextManager | `.claude/.superpowers/2026-04-09-P1-context-manager/spec.md` |
| PromptManager | `.claude/.superpowers/2026-04-09-P1-prompt-manager/spec.md` |
| DataContext | `.claude/.superpowers/2026-04-09-P1-data-context/spec.md` |

## 执行顺序

```
Plan A: 类型基础 + ToolRouter + Builtins (无外部依赖)
  ↓
Plan B: LlmProvider 扩展 + AgentLoop 多轮循环 (依赖 Plan A)
  ↓
Plan C: PromptManager + ContextManager + DataContext (依赖 Plan B)
  ↓
Plan D: 前端更新 + AppState 集成 (依赖全部后端)
```

## 文件清单

### 新增 Rust 文件
- `src-tauri/src/services/tool_registry.rs` — Tool trait, ToolRegistry, PermissionContext
- `src-tauri/src/services/tool_executor.rs` — ToolExecutor, PendingToolCall, ToolExecutionResult
- `src-tauri/src/services/tools/read.rs` — Read 工具
- `src-tauri/src/services/tools/write.rs` — Write 工具
- `src-tauri/src/services/tools/bash.rs` — Bash 工具
- `src-tauri/src/services/tools/mod.rs` — tools 模块入口
- `src-tauri/src/services/prompt_manager.rs` — PromptManager, DynamicContext
- `src-tauri/src/services/context_manager.rs` — ContextManager, TokenBudget, ContextConfig
- `src-tauri/src/services/data_context.rs` — DataContext, FileInfo
- `src-tauri/src/prompts/system_static.md` — 静态系统提示词

### 修改 Rust 文件
- `src-tauri/src/models/transcript.rs` — content 改为 Vec<ContentBlock>
- `src-tauri/src/models/event.rs` — AgentEvent 新增 ToolCallStart/End
- `src-tauri/src/services/llm.rs` — LlmStreamEvent 新增变体, trait 加 system+tools
- `src-tauri/src/services/agent_loop.rs` — 多轮循环, 集成全部新模块
- `src-tauri/src/services/mod.rs` — 新增模块声明
- `src-tauri/src/commands/chat.rs` — 传递新依赖, 处理 Vec<TranscriptEntry>
- `src-tauri/src/commands/session.rs` — AppState 新字段, load_history 改返回类型
- `src-tauri/src/db/jsonl.rs` — LoadHistoryResult, Summary 识别
- `src-tauri/src/lib.rs` — AppState 初始化
- `src-tauri/Cargo.toml` — 新增 tokio-process 依赖（如需要）

### 修改前端文件
- `src/types/index.ts` — ContentBlock 类型, AgentEvent 新变体
- `src/composables/useChat.ts` — 工具调用事件处理, ContentBlock 渲染
- `src/components/MessageBubble.vue` — 工具调用卡片渲染
- `src/components/StatusBar.vue` — token 消耗, 上下文百分比
- `src/components/ChatView.vue` — 流式工具调用状态展示

---

## 子计划文件

- [Plan A: 类型基础 + ToolRouter + Builtins](./2026-04-09-P1-plan-a.md)
- [Plan B: LlmProvider + AgentLoop 多轮循环](./2026-04-09-P1-plan-b.md)
- [Plan C: PromptManager + ContextManager + DataContext](./2026-04-09-P1-plan-c.md)
- [Plan D: 前端 + AppState 集成](./2026-04-09-P1-plan-d.md)

每个子计划完成后可独立验证，不依赖后续计划的实现。
