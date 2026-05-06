# Phase 1: Hello pi — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 Tauri + Vue 3 + Node.js Sidecar 三层架构，实现单 Agent 对话的完整桌面应用。

**Architecture:** Tauri v2 桌面壳（Rust）→ Vue 3 前端（通过 WebSocket 连接）→ Node.js Sidecar（管理 pi 子进程）。Sidecar 通过 spawn pi subprocess in RPC mode 与 pi 通信，通过 WS 与前端通信。协议类型通过 shared/ npm workspace 包共享。

**Tech Stack:** Tauri v2, Vue 3.5, Pinia, Radix Vue, Tailwind CSS v3, vue-i18n, markdown-it, dompurify, vue-sonner, WebSocket (ws), pi CLI (RPC mode)

**Spec:** `.superpowers/2026-05-06-hello-pi/spec-v2.md`

---

## 任务依赖图

```
Task 0: 清理旧代码
  ↓
Task 1: 项目脚手架（Tauri + Vue + Sidecar + shared workspace 骨架）
  ↓
Task 2: 地基层（Design Tokens + 主题 + i18n + taste-lint + Git Hooks + Markdown + Toast）
  ↓
Task 3: Design System 组件库（12 个组件）
  ↓
Task 4: WS 协议类型 + 客户端 + Sidecar 核心（subprocess RPC 管理器）
  ↓
Task 5: Pinia Stores + Composables + App Shell（Header + Sidebar + Statusbar + 视图切换 + 快捷键）
  ↓
Task 6: Chat 功能（消息渲染 + 流式 + 工具调用 + 输入区）
  ↓
Task 7: Session 管理（Sidebar 完整功能 + 会话 CRUD）
  ↓
Task 8: Settings（Provider 配置 + 模型管理）
  ↓
Task 9: 端到端集成（Sidecar pi 子进程对接 + Rust sidecar 管理 + 连接生命周期）
```

---

## 任务索引

| Task | 名称 | 主文档 | 补丁 | 关键交付物 |
|------|------|--------|------|-----------|
| 0 | 清理旧代码 | [plan-00-cleanup.md](./plan-00-cleanup.md) | — | 空白项目，保留 .git |
| 1 | 项目脚手架 | [plan-01-scaffold-v2.md](./plan-01-scaffold-v2.md) | — | Tauri + Vue + Sidecar + shared workspace 可编译运行 |
| 2 | 地基层 | [plan-02-foundation.md](./plan-02-foundation.md) | [plan-patches.md §1](./plan-patches.md) | Tokens + Theme + i18n + lint + hooks + Markdown + Toast |
| 3 | Design System | [plan-03-design-system.md](./plan-03-design-system.md) | — | 12 个基础 UI 组件 |
| 4 | 通信层 | [plan-04-communication-v2.md](./plan-04-communication-v2.md) | — | WS 协议 + 客户端 + Sidecar WS 服务 + RPC 进程管理 |
| 5 | 状态层 + Shell | [plan-05-state-shell.md](./plan-05-state-shell.md) | [plan-patches.md §2](./plan-patches.md) | Stores + Composables + App Shell + 视图切换 + 快捷键 |
| 6 | Chat 功能 | [plan-07-chat.md](./plan-07-chat.md) | — | 消息列表 + 流式渲染 + 工具调用 + 输入区 + 模型选择 |
| 7 | Session 管理 | (在 plan-08-09-10-v2.md Task 8) | — | Sidebar 完整功能 + 会话 CRUD + 搜索 |
| 8 | Settings | (在 plan-08-09-10-v2.md Task 9) | — | Provider 配置 + 默认模型 + 语言/主题 |
| 9 | 端到端集成 | [plan-08-09-10-v2.md](./plan-08-09-10-v2.md) | — | pi 子进程 RPC + Rust sidecar + 连接生命周期 |

---

## 参考文档

| 文档 | 用途 |
|------|------|
| [spec-v2.md](./spec-v2.md) | 修正后的完整设计规格 |
| [review-report.md](./review-report.md) | 全面审查报告 |
| [arch-frontend.md](./arch-frontend.md) | 前端架构：组件树、依赖图、数据流 |
| [arch-backend.md](./arch-backend.md) | 后端架构：Sidecar 文件图、pi SDK 集成 |
| [integration-investigation.md](./integration-investigation.md) | Sidecar 集成方式调研（Path A vs B） |
| [spec-corrections.md](./spec-corrections.md) | Spec 修正清单 |
| [plan-patches.md](./plan-patches.md) | plan-02/plan-05 补丁 |
| [pi-sdk-api-reference.md](../../docs/pi-sdk-api-reference.md) | pi SDK API 参考 |

## 参考项目

| 项目 | 路径 | 参考内容 |
|------|------|---------|
| llm-simple-router | `/Users/zhushanwen/Code/llm-simple-router` | taste-lint 增强版、vue_rules_checker.py、.githooks、composables 模式 |
| pi-mono | `~/GitApp/pi-mono` | pi RPC 协议、coding-agent 结构、AgentSession API |

---

## 检查点

每完成一个 Task 提交一次，commit message 格式：`feat(pN): <description>`

**关键里程碑：**
- **Task 3 完成** → 地基层就绪，可以开始 UI 开发
- **Task 4 完成** → 通信层就绪，前端可以和 Sidecar 对话
- **Task 5 完成** → App Shell 可见，完整布局 + 快捷键工作
- **Task 9 完成** → P1 交付，完整可用
