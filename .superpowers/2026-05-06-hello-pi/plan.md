# Phase 1: Hello pi — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 Tauri + Vue 3 + Node.js Sidecar 三层架构，实现单 Agent 对话的完整桌面应用。

**Architecture:** Tauri v2 桌面壳（Rust）→ Vue 3 前端（通过 WebSocket 连接）→ Node.js Sidecar（封装 pi SDK）。前端通过 WS 协议与 Sidecar 通信，Sidecar 通过 pi SDK 管理 Agent Session。

**Tech Stack:** Tauri v2, Vue 3.5, Pinia, Radix Vue, Tailwind CSS v4, vue-i18n, markdown-it, dompurify, vue-sonner, WebSocket (ws), @mariozechner/pi-coding-agent

**Spec:** `.superpowers/2026-05-06-hello-pi/spec.md`

---

## 任务依赖图

```
Task 0: 清理旧代码
  ↓
Task 1: 项目脚手架（Tauri + Vue + Sidecar 骨架）
  ↓
Task 2: 地基层（Design Tokens + 主题 + i18n + taste-lint + Git Hooks）
  ↓
Task 3: Design System 组件库（12 个组件）
  ↓
Task 4: WS 协议类型 + 客户端 + Sidecar 核心
  ↓
Task 5: Pinia Stores + Composables + App Shell（Header + Sidebar + ChatView 壳 + Statusbar）
  ↓
Task 6: Chat 功能（消息渲染 + 流式 + 工具调用 + 输入区）
  ↓
Task 8: Session 管理（Sidebar 完整功能 + 会话 CRUD）
  ↓
Task 9: Settings（Provider 配置 + 模型管理）
  ↓
Task 10: 端到端集成 + Sidecar pi SDK 对接
```

---

## 任务索引

| Task | 名称 | 子文档 | 关键交付物 |
|------|------|--------|-----------|
| 0 | 清理旧代码 | [plan-00-cleanup.md](./plan-00-cleanup.md) | 空白项目，保留 .git |
| 1 | 项目脚手架 | [plan-01-scaffold.md](./plan-01-scaffold.md) | Tauri + Vue + Vite + Sidecar 骨架可编译运行 |
| 2 | 地基层 | [plan-02-foundation.md](./plan-02-foundation.md) | Tokens + Theme + i18n + taste-lint + Git Hooks |
| 3 | Design System | [plan-03-design-system.md](./plan-03-design-system.md) | 12 个基础 UI 组件 |
| 4 | 通信层 | [plan-04-communication.md](./plan-04-communication.md) | WS 协议类型 + 客户端 + Sidecar WS 服务 + pi-bridge |
| 5 | 状态层 + Shell | [plan-05-state-shell.md](./plan-05-state-shell.md) | 3 个 Pinia Store + 5 个 Composable + App Shell |
| 6 | App Shell | [plan-06-shell.md](./plan-06-shell.md) | Header + Sidebar 壳 + ChatView 壳 + Statusbar |
| 7 | Chat 功能 | [plan-07-chat.md](./plan-07-chat.md) | 消息列表 + 流式渲染 + 工具调用 + 输入区 + 模型选择 |
| 8 | Session 管理 | [plan-08-session.md](./plan-08-session.md) | Sidebar 完整功能 + 会话 CRUD + 搜索 |
| 9 | Settings | [plan-09-settings.md](./plan-09-settings.md) | Provider 配置 + 默认模型 + 语言/主题设置 |
| 10 | 端到端集成 | [plan-10-integration.md](./plan-10-integration.md) | Sidecar + pi SDK 对接 + 真实对话 + 错误处理 |

---

## 参考项目

实现过程中参考以下已有项目的代码模式：

| 项目 | 路径 | 参考内容 |
|------|------|---------|
| 当前 xyz-agent | `/Users/zhushanwen/Code/xyz-agent` | taste-lint 规则、.githooks 脚本、Vue + Radix Vue 组件写法 |
| llm-simple-router | `/Users/zhushanwen/Code/llm-simple-router` | taste-lint 增强版、vue_rules_checker.py、.githooks/install-hooks.sh、前端 composables 模式 |
| pi-mono | `~/GitApp/pi-mono` | pi SDK API 用法、coding-agent 结构 |

---

## 检查点

每完成一个 Task 提交一次，commit message 格式：`feat(pN): <description>`

**关键里程碑：**
- **Task 3 完成** → 地基层就绪，可以开始 UI 开发
- **Task 4 完成** → 通信层就绪，前端可以和 Sidecar 对话
- **Task 6 完成** → App Shell 可见，能看到完整布局
- **Task 10 完成** → P1 交付，完整可用
