# xyz-agent 架构

> 本文件是**系统架构总览入口**：进程拓扑、三层职责、数据流、核心约束的实质说明。逐点决策、迁移记录、子系统细节在 [`architecture/`](architecture/) 子文档中，链接见文末。

## 一句话定位

基于 Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。引擎由 pi 提供，GUI 核心职责是「让用户高效给 agent 上下文、审查 agent 产出、介入 agent 行为」。完整定位见 [PRODUCT.md](../PRODUCT.md) 与领域术语表 [context.md](architecture/context.md)。

## 进程架构

三个运行上下文 + 一个共享类型包，通过两层边界通信：

```
┌─────────────────────────────────────────────────────────────────┐
│  渲染进程（Electron renderer · Chromium · Vue 3）                 │
│  src-electron/renderer/                                          │
│  Pinia stores · xyz-ui 组件 · event-bus · ws-client              │
└────────────┬────────────────────────────────┬───────────────────┘
             │ ① preload 桥接                │ ② WebSocket
             │   electronAPI（不走 ipcRenderer）│   JSON 协议
             ▼                                ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  主进程（Electron main · Node）│  │  Runtime 子进程（Node · spawn）│
│  src-electron/main/           │  │  src-electron/runtime/        │
│  窗口管理 · runtime 生命周期   │──→│  transport → services → infra │
│  快捷键 · IPC/bridge gateway  │  │  → pi 子进程 RPC              │
└──────────────────────────────┘  └──────────────────────────────┘
                      │                          │
                      └──── @xyz-agent/shared ───┘
                        协议类型（ClientMessage/ServerMessage/...）
                        三上下文共享，sibling npm package
```

- **① preload 边界**：渲染进程不直接用 `ipcRenderer`，通过 `window.electronAPI`（preload 注入）调主进程的 ipc/bridge/privileged handler。主进程是渲染进程访问原生能力（窗口、文件系统、Runtime spawn）的唯一通道。
- **② WebSocket 边界**：主进程用 `ELECTRON_RUN_AS_NODE=1` spawn Runtime 为独立 Node 进程，前端通过 WS 与之双向通信。ServerMessage 流式回推（pi 的 assistant 输出、工具调用、文件变更等）。

## 渲染进程（renderer）

Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui 组件库。设计系统遵循 v3 冷蓝暗色（[page-design/](../page-design/README.md)）。

| 职责 | 位置 | 说明 |
|------|------|------|
| 状态管理 | `src/stores/` | 6 个 store：chat（按 sessionId 分区）/ session / panel / settings / sidebar / navigation |
| WS 通信 | `composables/useConnection.ts` + `lib/ws-client` | 唯一与 Runtime 通信的出口 |
| 事件分发 | `event-bus` | ServerMessage 按 `payload.sessionId` 路由到对应 store 分区 |
| 组件 | `components/` | v3 L0-L4 拓扑：shell / sidebar / workspace(panel×N) / overlays |

**Session 隔离**：所有涉及特定 session 的消息必须带 `sessionId`，前端三层隔离（store 分区 → useChat 路由 → PaneSessionView 过滤）。缺失 `sessionId` 的消息被忽略，避免广播到所有 panel。详见 [context.md](architecture/context.md)。

## 主进程（main）

Electron 主进程，Node 环境。负责原生生命周期与跨进程编排。

| 模块 | 位置 | 职责 |
|------|------|------|
| 窗口管理 | `window/window-manager.ts` + `window-factory.ts` | 多 panel 窗口树、traffic light 安全区（[ADR-0016](architecture/adr/0016-macos-traffic-light-safe-zone.md)） |
| Runtime 监管 | `supervisor/runtime-supervisor.ts` | spawn/重启 Runtime 子进程、健康检查、端口发现 |
| 安全环境 | `supervisor/safe-env.ts` | 环境变量白名单过滤（[shared/constants.ts](../src-electron/shared/src/constants.ts) SSOT） |
| 快捷键 | `shortcuts/shortcut-registry.ts` | 全局/窗口快捷键 |
| IPC gateway | `gateway/ipc-handlers.ts` + `bridge-handlers.ts` + `privileged-handlers.ts` | 渲染进程请求的统一入口 |

## Runtime（子进程）

Node.js WebSocket 服务，三层架构（端口-适配器模式，[ADR 驱动](architecture/runtime-three-layer-design.md)）。与 pi 的唯一对接点。

| 层 | 位置 | 职责 | 铁律 |
|----|------|------|------|
| transport | `src/transport/` (7 file) | 路由 ClientMessage → service，管理 WS，广播 ServerMessage | 零业务逻辑 |
| services | `src/services/` (48 file) | 业务逻辑 + 定义 `ports/` 接口（config/session/pi-engine/model/installer/tree 六域） | **零 infra 直连**，经 ports 访问 |
| infra | `src/infra/` (18 file) | 外部系统连接器（pi RPC / npm / git / HTTP），实现 ports 接口 | 唯一与 pi/npm/git 打交道的位置 |

组合根 `index.ts` 构造 infra 实现 → 注入 services → 启动 server。依赖方向：`transport → services → ports ← infra`。

**详细设计**：
- [Runtime 三层架构设计](architecture/runtime-three-layer-design.md) — 为什么放弃四层、ports 依赖倒置原理
- [Runtime 模块架构图](architecture/runtime-module-map.md) — R9 后快照，各层内部模块 + 依赖铁律
- [Runtime 迁移记录](architecture/runtime-migration-progress.md) — R0–R9 执行（17 commit）

## 共享类型（shared）

`src-electron/shared/` 是独立 npm package，三上下文共享。

`message.ts`（ClientMessage/ServerMessage 协议）、`protocol.ts`、`session.ts`、`panel.ts`、`settings.ts`、`provider.ts`、`extension.ts`、`constants.ts`（`ENV_WHITELIST_PREFIXES` 等 SSOT）、`errors.ts`。依赖方向：`main/runtime/renderer → shared → 外部`，禁止反向。

## 核心架构约束

| # | 约束 | 来源 |
|---|------|------|
| 1 | emit 只传单个 payload 对象 | [CLAUDE.md §关键规则](../CLAUDE.md) |
| 2 | Session 隔离：消息必须带 sessionId，缺失则忽略 | ADR-0015 + 三层隔离机制 |
| 3 | pi 适配层不信任外部格式：EventAdapter/session-pool 是唯一适配点 | design.md D5 |
| 4 | 数据目录隔离：`~/.xyz-agent/` 与 `~/.pi/agent/` 完全隔离 | [ADR-0009](architecture/adr/0009-xyz-agent-data-dir-isolation-from-pi.md) |
| 5 | 路径白名单动态化：禁止硬编码 `~/.xyz-agent`，从 `getConfigDir()` 推导 | 安全规则 |
| 6 | Runtime services 零 infra 直连，经 ports 接口 | runtime 三层铁律 |

完整规则见 [CLAUDE.md](../CLAUDE.md)「关键规则」「架构约定」章节。

## 详细设计文档

- [完整架构设计](architecture/design.md) — 逐点决策 D1–D9 + 分层规则 + 依赖矩阵 + 迁移路线
- [架构评审问题记录](architecture/review-issues.md) — 9 个盲点 D1–D9 的来源与验证
- [领域术语表](architecture/context.md) — Session/Panel/Runtime + v3 UI 结构术语

## v3 视觉与交互层

前端视觉层于 2026-06 完成 v3 重建（冷蓝暗色，W01–W20 视觉验收全部 PASS）：

- [v3 UI 设计稿](../page-design/v3/README.md) — L0–L4 递归骨架 + 22 个 draft
- [设计 Tokens（SSOT）](../page-design/design-tokens.md) · [组件原语层](../page-design/design-system.md)
- v3 视觉/交互 ADR 0018–0022（见下）

## 架构决策（ADR）

[ADR 目录](architecture/adr/) — 共 24 条（0001–0024）。重要的几条：

- [ADR-0005 Bun 编译二进制 vs npm 包](architecture/adr/0005-bun-binary-over-npm-package.md)
- [ADR-0009 xyz-agent 数据目录与 pi 隔离](architecture/adr/0009-xyz-agent-data-dir-isolation-from-pi.md)
- [ADR-0015 Event-bus 类型加固](architecture/adr/0015-event-bus-typed-severmessagetype.md)
- [ADR-0018 视觉方向收敛到冷蓝暗色](architecture/adr/0018-visual-direction.md)（推翻旧 Warm & Soft）
- [ADR-0021 默认主题（暗色冷蓝）](architecture/adr/0021-default-theme-direction.md)
- [ADR-0024 filechanges 通道](architecture/adr/0024-filechanges-channel.md)

## 子系统架构

- [Plugin 子系统](architecture/subsystems/plugin/README.md) — Worker Thread 隔离 + Hook 链 + Tool RPC 路由

## 演进 / 调研 / 历史

- [重构迁移计划](architecture/migration-plan.md) — 5 阶段路线 · [术语对齐](architecture/terminology.md) R1–R5
- [架构调研](architecture/research/) — Electron 打包 · Node.js 路径安全 · Pi Extension 通道
- [历史归档](architecture/history/) — 被 supersede 的旧架构（pre-electron Tauri 方案等）

---

**目录组织规范**：见 [architecture/README.md](architecture/README.md)。**docs 总索引**：见 [README.md](README.md)。
