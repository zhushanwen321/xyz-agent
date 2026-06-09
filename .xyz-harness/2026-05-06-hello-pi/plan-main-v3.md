# Phase 1: Hello pi — Implementation Plan v3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Tauri v2 + Vue 3 + Node.js Sidecar three-layer architecture for a single-agent conversational desktop app. This is the minimum viable product — a pi coding agent GUI shell.

**Architecture:** Tauri v2 desktop shell (Rust) → Vue 3 frontend (via WebSocket) → Node.js Sidecar (manages pi subprocesses). Sidecar communicates with pi via subprocess RPC mode, with frontend via WS. Protocol types shared through `shared/` npm workspace package.

**Tech Stack:** Tauri v2, Vue 3.5, Pinia, Radix Vue, Tailwind CSS **v3** (JS config, not v4), vue-i18n, markdown-it, dompurify, vue-sonner, @tanstack/vue-virtual, WebSocket (ws), pi CLI (RPC mode)

**Spec:** `.superpowers/2026-05-06-hello-pi/spec-v2.md`

---

## Key Architecture Decisions (v3)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tailwind CSS | **v3** with JS config | v4 CSS-first approach not adopted; `tailwind.config.ts` references CSS variables |
| State management | Pinia + persistedstate | Settings persisted to localStorage; `currentView`/`focusMode` not persisted |
| Chat rendering | **Stable list + streaming split** | `completedMessages[]` (frozen) + `streamingMessage` (reactive). Eliminates jank. |
| Stream batching | **rAF batching** via `useRafBatch` | Buffers text deltas, flushes once per animation frame. ~60% fewer re-renders. |
| Tool rendering | **Registry pattern** via `tool-renderer-registry.ts` | `Map<string, Component>` — ToolCallCard dispatches to registered renderer. |
| Slash commands | **Registry pattern** via `useSlashCommands` | Commands registered during init. SlashMenu reads from registry. |
| View switching | **State-driven** (no vue-router) | `settingsStore.currentView` + `focusMode` drive v-if rendering. |
| Connection status | **3-state** (`connected`/`disconnected`/`reconnecting`) | useConnection composable with exponential backoff reconnect. |
| Context tracking | **useContext composable** | Reads `chatStore.contextUsagePercent`, provides color + compact trigger. |
| Tool approval | **Inline ApprovalCard** | WS protocol: `tool.approve` / `tool.deny` / `tool.always_allow`. |
| Shared types | **@xyz-agent/shared npm workspace** | Frontend + sidecar import from same package. No manual type sync. |

---

## Task Dependency Graph

```
Task 0: Clean old code
  ↓
Task 1: Project scaffold (Tauri + Vue + Sidecar + shared workspace skeleton)
  ↓
Task 2: Foundation layer (Tokens + Tailwind v3 + Theme + i18n + lint + hooks + Markdown + Toast + Virtual Scroll + rAF Batch + Tool Renderer Registry + Slash Command Registry)
  ↓
Task 3: Design System components (12 components)
  ↓
Task 4: WS protocol types + Client + Sidecar core (subprocess RPC manager)
  ↓
Task 5: Pinia Stores (stable list + streaming) + Composables (useChat w/ rAF, useConnection, useContext) + App Shell (Header + Sidebar + Statusbar + state-driven view switching + keyboard shortcuts + Tauri shortcut infra)
  ↓
Task 6: Chat features (MessageList + StreamingMessage + MessageBubble + ToolCallCard + ToolRenderers + ApprovalCard + ThinkingBlock + ChatInput + ModelPicker + ContextBar + SlashMenu)
  ↓
Task 7: Session management (Sidebar full functionality + Session CRUD + search)
  ↓
Task 8: Settings (Provider configuration + default model + language/theme)
  ↓
Task 9: End-to-end integration (Sidecar pi subprocess hookup + Rust sidecar management + connection lifecycle)
```

---

## Task Index

| Task | Name | Plan Document | Key Deliverables |
|------|------|--------------|------------------|
| 0 | Clean old code | [plan-00-cleanup.md](./plan-00-cleanup.md) | Blank project, preserve .git |
| 1 | Project scaffold | [plan-01-scaffold-v2.md](./plan-01-scaffold-v2.md) | Tauri + Vue + Sidecar + shared workspace compiles and runs |
| 2 | Foundation layer | **[plan-02-foundation-v3.md](./plan-02-foundation-v3.md)** | Tokens + Tailwind v3 + Theme + i18n + lint + hooks + Markdown + Toast + Virtual Scroll + rAF Batch + Tool Renderer Registry + Slash Commands |
| 3 | Design System | [plan-03-design-system.md](./plan-03-design-system.md) | 12 base UI components |
| 4 | Communication layer | [plan-04-communication-v2.md](./plan-04-communication-v2.md) | WS protocol + client + Sidecar WS server + RPC process manager |
| 5 | State + Shell | **[plan-05-state-shell-v3.md](./plan-05-state-shell-v3.md)** | Stores (stable list + streaming) + Composables (rAF chat, connection, context) + App Shell + view switching + shortcuts |
| 6 | Chat features | **[plan-07-chat-v3.md](./plan-07-chat-v3.md)** | MessageList + StreamingMessage + ToolCallCard (registry dispatch) + ToolRenderers + ApprovalCard + ChatInput + ModelPicker + ContextBar + SlashMenu |
| 7 | Session management | [plan-08-09-10-v2.md](./plan-08-09-10-v2.md) (Task 8) | Sidebar full functionality + Session CRUD + search |
| 8 | Settings | [plan-08-09-10-v2.md](./plan-08-09-10-v2.md) (Task 9) | Provider config + default model + language/theme |
| 9 | E2E integration | [plan-08-09-10-v2.md](./plan-08-09-10-v2.md) (Task 10) | pi subprocess RPC + Rust sidecar + connection lifecycle |

---

## Reference Document Index

### Spec & Corrections
| Document | Purpose |
|----------|---------|
| [spec-v2.md](./spec-v2.md) | Complete design specification (corrected) |
| [spec-corrections.md](./spec-corrections.md) | Spec correction list |
| [review-report.md](./review-report.md) | Comprehensive review report |

### Architecture Analysis
| Document | Purpose |
|----------|---------|
| [arch-frontend.md](./arch-frontend.md) | Frontend architecture: component tree, dependency graph, data flow |
| [arch-backend.md](./arch-backend.md) | Backend architecture: Sidecar file graph, pi SDK integration |
| [arch-optimization.md](./arch-optimization.md) | Original optimization proposals (v1) |
| **[arch-optimization-v2.md](./arch-optimization-v2.md)** | **Five-project analysis → 10 design borrowings + priority matrix** |
| [integration-investigation.md](./integration-investigation.md) | Sidecar integration research (Path A vs B) |

### Research References
| Document | Purpose |
|----------|---------|
| [ref-claude-code.md](./ref-claude-code.md) | Claude Code source analysis: sub-agents, agent loop, context management |
| [ref-codex-opencode.md](./ref-codex-opencode.md) | Codex CLI + OpenCode analysis: thread management, provider abstraction, permissions |
| [ref-aider-crush.md](./ref-aider-crush.md) | Aider + Crush analysis: edit formats, repo map, LSP integration |

### Superseded Documents (replaced by v3 plans)
| Document | Replaced By |
|----------|-------------|
| plan-02-foundation.md + plan-patches.md §1 | **plan-02-foundation-v3.md** |
| plan-05-state-shell.md + plan-patches.md §2 | **plan-05-state-shell-v3.md** |
| plan-07-chat.md | **plan-07-chat-v3.md** |
| plan.md | **This document (plan-main-v3.md)** |

### External References
| Reference | Path | Content |
|-----------|------|---------|
| llm-simple-router | `/Users/zhushanwen/Code/llm-simple-router` | taste-lint enhanced, vue_rules_checker.py, .githooks, composables patterns |
| pi-mono | `~/GitApp/pi-mono` | pi RPC protocol, coding-agent structure, AgentSession API |

---

## Deliverables Checklist

Phase 1 结束后，用户可以：

- [ ] 在桌面应用中与 AI Agent 正常对话（流式输出）
- [ ] 看到 Agent 的工具调用（bash/edit/read/write），可折叠查看详情，每个工具有专用渲染器
- [ ] 看到工具审批请求（ApprovalCard），可以允许/拒绝/始终允许
- [ ] 看到 Agent 的思考过程（thinking），默认折叠
- [ ] 流式文本平滑显示，无 jank（rAF batching + stable list split）
- [ ] 在输入框切换模型（分组下拉：常用 / 按 Provider）
- [ ] 在设置页配置 Provider（添加/编辑/删除 API Key）
- [ ] 在左侧 Sidebar 查看按工作目录分组的 Session 列表
- [ ] 新建 Session（选择工作目录）/ 删除 Session / 切换 Session
- [ ] 中断当前生成
- [ ] 切换明/暗主题
- [ ] 切换标准/专注两种视图模式
- [ ] 在底部状态栏看到连接状态（3色圆点）、cwd、模型、token 用量
- [ ] 通过键盘快捷键切换视图模式（⌘1 / ⌘3）和打开设置（⌘,）
- [ ] 使用 `/` 命令（`/clear`, `/compact`, `/help`）
- [ ] 看到上下文用量进度条，超过 80% 可触发手动压缩
- [ ] Toast 通知提示操作结果和错误信息

---

## Key Milestones

| Milestone | After Task | What's Ready |
|-----------|-----------|-------------|
| Foundation ready | Task 3 | Tokens, theme, i18n, lint, all utilities installed |
| Communication ready | Task 4 | WS client, event bus, Sidecar core, protocol types |
| Shell visible | Task 5 | Full layout (header + sidebar + statusbar), view switching, shortcuts |
| Chat functional | Task 6 | Message rendering, streaming, tools, input area, model picker |
| Full P1 MVP | Task 9 | End-to-end working with pi subprocess |

---

## Checkpoint Strategy

One commit per task. Commit message format: `feat(pN): <description>`

**Pre-commit checks** (via .githooks):
1. ESLint (`--fix --max-warnings=0`) with taste-lint rules
2. `vue-tsc --noEmit` type checking
3. `vue_rules_checker.py` structural checks

**Skip flags:** `SKIP_ALL_CHECKS=1` / `SKIP_LINT=1` / `SKIP_TYPE_CHECK=1` / `SKIP_CODE_RULES_CHECK=1`
