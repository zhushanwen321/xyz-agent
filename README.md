# xyz-agent

AI Agent 桌面工作台，基于 Electron + Vue 3 + Node.js Runtime 架构。

通过 [pi](https://github.com/badlogic/pi-mono)（npm 包名 `@earendil-works/pi-coding-agent`）的子进程 RPC 协议与各类 AI Agent 通信，提供多 session 管理、split view、focus mode、drawer 面板等功能。

> 本项目使用上游 [pi-mono](https://github.com/badlogic/pi-mono)。详见 [CLAUDE.md](CLAUDE.md)。

## 架构

```
┌──────────────────────────────────────────────────┐
│                  Electron 主进程                   │
│  窗口管理 · Runtime 子进程生命周期 · 全局快捷键   │
└─────────────┬────────────────────┬────────────────┘
              │ IPC                │ spawn
              ▼                    ▼
┌──────────────────┐   ┌──────────────────────────┐
│   Preload 桥接    │   │   Runtime (Node.js 子进程) │
│ electronAPI 暴露  │   │  WebSocket Server (ws)    │
└────────┬─────────┘   │  pi RPC 适配 · 事件翻译    │
         │             └────────────┬───────────────┘
         │                          │ child_process RPC
         ▼                          ▼
┌──────────────────────────────────────────────────┐
│        渲染进程 (Vue 3 + Vite · v3 冷蓝暗色)        │
│  Pinia 状态 · xyz-ui 组件 · ws-client · event-bus │
└──────────────────────────────────────────────────┘
```

四个核心模块：

| 模块 | 路径 | 职责 |
|------|------|------|
| **主进程** | `apps/electron/main/` | BrowserWindow 生命周期、runtime spawn/stop、全局快捷键注册 |
| **Preload** | `apps/electron/preload/` | `contextIsolation` 安全桥接，暴露 `window.electronAPI` |
| **前端** | `packages/renderer/` | Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui（v3 冷蓝暗色设计系统）|
| **Runtime** | `packages/runtime/` | WebSocket 服务，三层架构（transport/services/infra），通过 pi RPC 协议与 Agent 通信 |
| **共享类型** | `packages/shared/` | 前端与 runtime 间的 TypeScript 类型定义（pnpm workspace）|

渲染进程有两条出口通道：**WS**（→ Runtime，业务/数据）与 **IPC**（→ Main，窗口/进程/OS 特权）。渲染进程不直接调 `window.electronAPI`，统一走 [`lib/ipc.ts`](packages/renderer/src/lib/ipc.ts) 门面。

### 为什么是 Electron

项目早期使用 Tauri，后迁移至 Electron，原因：

1. **渲染稳定性** — Electron 使用 Chromium，CSS/布局渲染结果与 Chrome DevTools 完全一致，不存在 WebView2/WebKit 的平台差异
2. **视觉锐利度** — 字体渲染、亚像素抗锯齿、GPU 合成行为完全可控，跨平台表现一致
3. **生态成熟度** — electron-builder、electron-store、DevTools 扩展、Sentry 集成等工具链完善
4. **Node.js 原生能力** — 主进程直接使用 Node API（child_process、fs、net），不需要 Rust 后端进程或 FFI

## 快速开始

**前置条件**: Node.js >= 20, pnpm >= 10

```bash
# 安装依赖（pnpm workspace 单步装完 packages/* + apps/*）
pnpm install

# 开发模式（Vite HMR + Electron 主进程）
pnpm dev

# 生产构建
pnpm build

# 类型检查
pnpm --filter @xyz-agent/frontend run typecheck

# ESLint
pnpm run lint
```

### 环境变量

| 变量 | 作用 | 默认值 |
|------|------|--------|
| `XYZ_MOCK` | 设为 `1` 跳过 runtime 子进程启动，使用 Mock 数据 | — |
| `VITE_MOCK` | 设为 `true` 在 ws-client 层拦截所有 WS 消息 | — |
| `XYZ_AGENT_DATA_DIR` | 自定义数据目录（dev 模式默认 `~/.xyz-agent-dev`，与 pi 的 `~/.pi/agent/` 完全隔离）| `~/.xyz-agent` |

## 核心功能（v3 UI）

v3 前端于 2026-06 完成 L0–L4 递归骨架重建（W01–W20 视觉验收全部 PASS），冷蓝暗色设计系统（ADR-0018）。设计 SSOT 见 [docs/page-design/v3/](docs/page-design/v3/)，术语见 [领域术语表](docs/architecture/context.md#v3-ui-结构术语2026-06-重构)。

- **Sidebar（侧栏）** — 持久容器（非单列表），顶部 Logo + 主操作 → segmented tab（会话｜文件）互斥切换 → 子视图列表 → 底部设置/用户。透明融合于 base，支持折叠（⌘B）
- **Workspace（工作区）** — 双 Panel 主从模式（单 Panel = 默认态，开第二 session 才 split）
- **Panel 5 zone** — 每个 Panel 自上而下：① panel-header（面包屑）② message-stream（消息流 + 回合折叠）③ progress-zone ④ composer（输入 + 工具区）⑤ git-zone
- **Overview（概览）** — 独立 L1 Region，多会话鸟瞰统筹（卡片网格 + 筛选 + 后台 agent 聚合），⌘⇧O 触发（ADR-0022）
- **Settings** — modal 形态，Provider / Extension / Agent / System 四菜单（ADR-0020 资源加载）
- **Search Modal** — ⌘K 全局搜索浮层（归 Overlay 层，非 Sidebar 子组件）
- **Traffic Light 安全区** — macOS 三按钮 + 跨平台 AppNavControls（ADR-0016，已实现）

> v1 范围限制：Overview/Settings/Overlays 在 v1 仅实现骨架 + 入口隐藏（功能未全部落地，详见 [spec §8.5/§9](.xyz-harness/2026-06-20-frontend-rebuild/spec.md)）。

## Plugin System

xyz-agent 内置插件系统，支持扩展功能（tools、hooks、slash commands、status bar items）。

### 架构

- **Backend**: PluginService 管理 Worker Thread 池，每个插件独立 Worker 进程
- **Frontend**: Pinia store + Vue 组件（PluginsPane、PluginSettingsForm、MessageDecoration）
- **Communication**: WebSocket（前端↔后端）+ JSON-RPC over MessagePort（后端↔Worker）

### Built-in Plugins

- **Goal**: 目标管理（create_tasks, update_tasks, complete_goal, cancel_goal）
- **Todo**: 待办清单（add, update, delete, clear, list）

### Extension Points

| 扩展点 | 描述 |
|--------|------|
| Tools | 注册 LLM 可调用的工具（通过 Pi Bridge Extension） |
| Hooks | 拦截消息流（onBeforeSendMessage, onAfterToolUse 等） |
| Slash Commands | 注册 /command 快捷操作 |
| Status Bar Items | 在状态栏显示插件状态 |
| Message Decorations | 在消息气泡上显示标签 |
| Settings | 插件配置项（自动渲染表单） |

## Extension 开发

xyz-agent 通过 pi 的 extension 机制扩展能力（注册工具、命令、事件钩子等）。Extension 与上文的 Plugin System 是两套独立机制——Extension 走 pi 子进程的 `--extension` 参数加载，Plugin 走 xyz-agent 自有的 Worker Thread。

- [本地开发调试指南](docs/extensions/local-dev-guide.md) — 环境搭建、`XYZ_EXTENSION_PATHS` live link、日志查看、生效机制
- [GUI 协议接入指南](docs/extensions/gui-protocol-guide.md) — TUI extension 改造为 TUI/GUI 双模

## 功能开发地图

项目长期规划按 7 个 Phase 推进，详见 [docs/feature-map/](docs/feature-map/)。

```
Phase 0  生产可用化        →  Runtime 编译 · electron-builder · Markdown 渲染优化
Phase 1  基础修复          →  tool_execution_update · 手动触发修复 · 布局切换 · Tag 分组
Phase 2  聊天核心增强      →  @-mention · Command Palette · 文件变更 Diff · 系统通知
Phase 3  SubAgent 数据流   →  TaskTree 真实数据 · Side Drawer · 终止 subagent · PanelBar 联动
Phase 4  高级模式          →  Parallel/Chain 渲染 · Background agent · Overview 状态聚合
Phase 5  树形引擎          →  RPC 桥接 · ask_user · 递归分解 · Preset/Fork · 预算控制
Phase 6  树形 GUI          →  SubAgent Tab 栏 · 子 Agent 对话面板 · 用户介入 · 全局任务树
```

**当前进展（2026-06-20）**：前端视觉层 v3 重建完成（W01–W20 视觉验收全 PASS），冷蓝暗色设计系统落地。下一阶段：真实模式集成（`transport.on → events.dispatch` 打通）+ SubAgent 数据流（Phase 3）。

关键决策点和完整资料链接见 [docs/feature-map/2026-06-20.md](docs/feature-map/2026-06-20.md)（v3 重建后最新版）。旧版 [2026-05-19.md](docs/feature-map/2026-05-19.md) 保留作重构前状态快照。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 42 |
| 前端框架 | Vue 3.5 + TypeScript 5.8 |
| 状态管理 | Pinia 3 + persistedstate |
| 构建工具 | Vite 8 (renderer) + Vite (main/preload lib mode) |
| UI 组件 | xyz-ui (内部组件库) + radix-vue / reka-ui |
| 样式 | Tailwind CSS v3（v3 冷蓝暗色 tokens，禁 scoped CSS / 禁 @apply）|
| 图标 | lucide-vue-next |
| 国际化 | vue-i18n 10 |
| 后端通信 | ws (WebSocket) + pi 子进程 RPC |
| 打包 | electron-builder |

## 项目结构

```
xyz-agent/
├── packages/                      # 可复用层（pnpm workspace）
│   ├── shared/                    # @xyz-agent/shared — 共享类型（protocol/message/session/...）
│   ├── renderer/                  # @xyz-agent/frontend — Vue 前端
│   │   └── src/
│   │       ├── components/        # v3 组件分组：shell/sidebar/workspace/panel/overview/settings/overlays/ui
│   │       ├── composables/       # 分层：effects/ features/ logic/ + useConnection.ts
│   │       ├── stores/            # Pinia stores (chat/navigation/panel/session/sidebar)
│   │       └── lib/               # ws-client/event-bus/markdown/ipc 门面
│   ├── runtime/                   # @xyz-agent/runtime — Node.js Runtime
│   │   └── src/                   # 三层架构：transport/ services/ infra/ + plugins/
│   └── plugin-sdk/                # 插件 SDK
├── apps/
│   └── electron/                  # @xyz-agent/electron — Electron 壳
│       ├── main/                  # 主进程（三编排子系统 M1/M2/M3）
│       │   ├── main.ts            # 应用入口、窗口创建、生命周期
│       │   ├── supervisor/        # M1 Process Supervisor（runtime-supervisor + 端口发现/健康检查）
│       │   ├── window/            # M2 Window Manager（window-factory + traffic-light 安全区）
│       │   ├── gateway/           # M3 OS Gateway + IPC handlers（privileged/bridge/input-validators）
│       │   └── shortcuts/         # 全局快捷键注册（shortcut-registry）
│       └── preload/               # 安全桥接，暴露 electronAPI
├── docs/
│   ├── architecture/          # 架构文档（design.md/ADR/context/术语表）
│   ├── designs/               # v3 设计 SSOT：design-tokens.md + design-system.md + v3-demo/
│   ├── feature-map/           # 功能开发地图（长期规划、现状、决策）
│   ├── project/               # 功能清单（已完成 / 规划 / 最高优先级）
│   └── standards.md           # 编码规范与架构标准
├── tools/                     # 验证脚本 (verify-*.cjs)
└── package.json               # 根 package（workspaces 配置）
```

## 编码规范

详见 [docs/standards.md](docs/standards.md) 和 [CLAUDE.md](CLAUDE.md)。

关键规则摘要：

- **禁止原生 HTML 表单元素** — 必须使用 xyz-ui 组件
- **禁止 Emoji** — 使用 SVG 或 lucide-vue-next
- **样式三层结构** — design tokens（`:root`）→ Template class（Tailwind）→ `<style scoped>`（仅伪元素/后代选择器/transition）。**禁止 `@apply`，禁止在 `<style scoped>` 写组件样式**
- **border-radius v3** — 三档：`rounded-sm`(3px) / `rounded`/`rounded-md`(8px) / `rounded-lg`(12px)（SSOT 见 [design-tokens.md](docs/page-design/design-tokens.md)）
- **emit 只传单个 payload 对象** — 禁止多参数 emit
- **行数上限** — `<template>` ≤ 400 行, `<script setup>` ≤ 300 行
- **禁止 `any`** — 用 `unknown` 或具体类型
- **独立数据源用 `Promise.allSettled`** — 不用 `Promise.all`
- **IPC 门面** — 渲染进程不直接调 `window.electronAPI`，统一走 `lib/ipc.ts`

## License

Private
