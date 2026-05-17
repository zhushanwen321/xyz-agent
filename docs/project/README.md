# 项目功能全览

本目录包含 xyz-agent 项目的完整功能规划文档。

| 文件 | 说明 |
|------|------|
| [features-top-priority.md](./features-top-priority.md) | **最高优先级** — 用户反馈的四项核心需求 |
| [features-completed.md](./features-completed.md) | 已实现的功能清单及实现状态 |
| [features-planned.md](./features-planned.md) | 其余未实现功能（P1-P3 优先级） |

## 定位

xyz-agent 是一个 AI Agent 桌面工作台。核心差异在于 **coding agent 的可视化审查与交互体验**，而非 agent 引擎本身（引擎由 pi 提供）。

GUI 侧的核心职责：**让用户高效地给 agent 上下文、审查 agent 的产出、管理 agent 的行为**。

## 文档历史

- 最早规划：`.superpowers/2026-05-06-hello-pi/` （P1-P6 六阶段，基于 Tauri）
- 架构变更：Tauri → Electron 迁移（`src-electron/MIGRATION-PLAN.md`）
- 本文档：基于 2026-05-17 项目实际状态，从"日常使用的编码工具"视角重新梳理
- 最高优先级更新：基于用户反馈确认的四项核心需求（生产构建 / Markdown 渲染 / 文件变更总览 / Session Tree）
