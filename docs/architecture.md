# xyz-agent 架构

> 本文件是**当前架构的唯一入口**，只做索引。详细设计、决策、迁移记录都在 [`architecture/`](architecture/) 目录内。
>
> 改架构时改 `architecture/` 内的具体文档，本文件的链接跟随更新；**不要在此重复内容**。

## 一句话定位

基于 Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。引擎由 pi 提供，GUI 核心职责是「让用户高效给 agent 上下文、审查 agent 产出、介入 agent 行为」。完整定位见 [PROJECT.md](../PRODUCT.md) 与领域术语表 [context.md](architecture/context.md)。

## 当前架构设计

- [完整架构设计](architecture/design.md) — 逐点决策 D1–D9 + 统一架构视图 + 分层规则 + 迁移路线
  - [全局架构图](architecture/design.md#21-全局架构图)
  - [分层规则与依赖矩阵](architecture/design.md#22-分层规则与依赖矩阵)
  - [双维度模型（水平层 × 纵向上下文）](architecture/design.md#23-双维度模型水平层--纵向上下文)
- [Runtime 三层架构设计](architecture/runtime-three-layer-design.md) — 取代 D4 的 Runtime 四层（adapters 合并入 infra + ports 依赖倒置）
- [架构评审问题记录](architecture/review-issues.md) — 9 个盲点 D1–D9 的来源与验证
- [领域术语表](architecture/context.md) — Session / Panel / Runtime 等核心概念定义

## 架构决策（ADR）

[ADR 目录](architecture/adr/) — 共 18 条。重要的几条：

- [ADR-0005 Bun 编译二进制 vs npm 包](architecture/adr/0005-bun-binary-over-npm-package.md)
- [ADR-0009 xyz-agent 数据目录与 pi 完全隔离](architecture/adr/0009-xyz-agent-data-dir-isolation-from-pi.md)
- [ADR-0011 内置 extension 直接复制（supersede ADR-0007）](architecture/adr/0011-bundled-extensions-direct-copy.md)
- [ADR-0015 Event-bus 类型加固](architecture/adr/0015-event-bus-typed-severmessagetype.md)
- [ADR-0016 macOS Traffic Light Safe Zone](architecture/adr/0016-macos-traffic-light-safe-zone.md)

## 子系统架构

- [Plugin 子系统](architecture/subsystems/plugin/README.md) — Worker Thread 隔离 + Hook 链 + Tool RPC 路由

## 进行中的演进

- [重构迁移计划](architecture/migration-plan.md) — 5 阶段路线（API Client / Runtime 分层 / Session 拆分 / 命名对齐 / Guardrails）
  - [阶段细节](architecture/migration-plan.md#阶段总览) · [迁移铁律](architecture/migration-plan.md#全局迁移铁律所有阶段适用)
- [术语对齐计划](architecture/terminology.md) — R1–R5 命名债清理

## 架构调研

- [Electron 打包最佳实践](architecture/research/electron-packaging-best-practices.md)
- [Node.js 路径安全最佳实践](architecture/research/nodejs-path-safety-best-practices.md)
- [打包复盘 v0.3.8–v0.3.11](architecture/research/packaging-retrospect-v0.3.8-v0.3.11.md)
- [Pi Extension RPC 通道清单](architecture/research/pi-extension-rpc-channels.md)
- [Pi Extension TUI 通道清单](architecture/research/pi-extension-tui-channels.md)

## 历史

[归档目录](architecture/history/) — 被 supersede 的旧架构版本。当前归档：

- [pre-electron-2026-05](architecture/history/pre-electron-2026-05/migration-plan.md) — Tauri → Electron 迁移方案

---

**目录组织规范**：见 [architecture/README.md](architecture/README.md)。
