# xyz-agent

AI Agent 桌面工作台，基于 Electron + Vue 3 + Node.js Sidecar 架构。

通过 [pi](https://github.com/nicepkg/pi-coding-agent) 的子进程 RPC 协议与各类 AI Agent 通信，提供多 session 管理、split view、focus mode、drawer 面板等功能。

## 架构

```
┌──────────────────────────────────────────────────┐
│                  Electron 主进程                   │
│  窗口管理 · Sidecar 生命周期 · 全局快捷键          │
└─────────────┬────────────────────┬────────────────┘
              │ IPC                │ spawn
              ▼                    ▼
┌──────────────────┐   ┌──────────────────────────┐
│   Preload 桥接    │   │    Sidecar (Node.js)      │
│ electronAPI 暴露  │   │  WebSocket Server (ws)    │
└────────┬─────────┘   │  pi RPC 适配 · 事件翻译    │
         │             └────────────┬───────────────┘
         │                          │ child_process RPC
         ▼                          ▼
┌──────────────────────────────────────────────────┐
│              渲染进程 (Vue 3 + Vite)              │
│  Pinia 状态 · xyz-ui 组件 · ws-client · event-bus │
└──────────────────────────────────────────────────┘
```

四个核心模块：

| 模块 | 路径 | 职责 |
|------|------|------|
| **主进程** | `src-electron/main/` | BrowserWindow 生命周期、sidecar spawn/stop、全局快捷键注册 |
| **Preload** | `src-electron/preload/` | `contextIsolation` 安全桥接，暴露 `window.electronAPI` |
| **前端** | `src-electron/renderer/` | Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui |
| **Sidecar** | `src-electron/sidecar/` | WebSocket 服务，通过 pi RPC 协议与 Agent 通信 |
| **共享类型** | `src-electron/shared/` | 前端与 sidecar 间的 TypeScript 类型定义（npm workspace） |

### 为什么是 Electron

项目早期使用 Tauri，后迁移至 Electron，原因：

1. **渲染稳定性** — Electron 使用 Chromium，CSS/布局渲染结果与 Chrome DevTools 完全一致，不存在 WebView2/WebKit 的平台差异
2. **视觉锐利度** — 字体渲染、亚像素抗锯齿、GPU 合成行为完全可控，跨平台表现一致
3. **生态成熟度** — electron-builder、electron-store、DevTools 扩展、Sentry 集成等工具链完善
4. **Node.js 原生能力** — 主进程直接使用 Node API（child_process、fs、net），不需要 Rust sidecar 或 FFI

## 快速开始

**前置条件**: Node.js >= 20, npm >= 10

```bash
# 安装依赖（根目录 + npm workspaces）
npm install

# 开发模式（Vite HMR + Electron 主进程）
npm run dev

# 生产构建
npm run build

# 类型检查
npm -w @xyz-agent/frontend run typecheck

# ESLint
npm run lint
```

### 环境变量

| 变量 | 作用 | 默认值 |
|------|------|--------|
| `XYZ_MOCK` | 设为 `1` 跳过 sidecar 启动，使用 Mock 数据 | — |
| `VITE_MOCK` | 设为 `true` 在 ws-client 层拦截所有 WS 消息 | — |

## 核心功能

- **多 Session** — 左侧栏管理多个 agent 会话，支持 JSONL 持久化和恢复
- **Split View** — 并排两个聊天面板，独立 session
- **Focus Mode** — 隐藏侧栏和状态栏，聊天区居中窄化，沉浸式对话
- **Overview** — 快速概览所有 session 的卡片视图
- **Drawer 面板** — 右侧/左侧抽屉展示任务树、已完成项、请求回应
- **SubAgent 支持** — SlashMenu 触发 / LLM 自动调用 subagent，聊天流内结构化渲染
- **Settings** — Provider / Skill / Agent / System 四标签完整管理
- **快捷键** — Standard / Split / Focus / Overview / Settings 全局切换

## 功能开发地图

项目长期规划按 7 个 Phase 推进，详见 [docs/feature-map/](docs/feature-map/)。

```
Phase 0  生产可用化        →  Sidecar 编译 · electron-builder · Markdown 渲染优化
Phase 1  基础修复          →  tool_execution_update · 手动触发修复 · 布局切换 · Tag 分组
Phase 2  聊天核心增强      →  @-mention · Command Palette · 文件变更 Diff · Session Tree · 系统通知
Phase 3  SubAgent 数据流   →  TaskTree 真实数据 · Drawer 三 Tab · 终止 subagent · PanelBar 联动
Phase 4  高级模式          →  Parallel/Chain 渲染 · Background agent · Overview 状态聚合
Phase 5  树形引擎          →  RPC 桥接 · ask_user · 递归分解 · Preset/Fork · 预算控制
Phase 6  树形 GUI          →  SubAgent Tab 栏 · 子 Agent 对话面板 · 用户介入 · 全局任务树
```

各层完成度：Layer 1（GUI 壳）~90% · Layer 2（聊天核心）~85% · Layer 3（SubAgent 基础）~40% · Layer 4（树形引擎）0%

关键决策点和完整资料链接见 [docs/feature-map/2026-05-19.md](docs/feature-map/2026-05-19.md)。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 33 |
| 前端框架 | Vue 3.5 + TypeScript 5.8 |
| 状态管理 | Pinia 3 + persistedstate |
| 构建工具 | Vite 8 (renderer) + Vite (main/preload lib mode) |
| UI 组件 | xyz-ui (内部组件库) + radix-vue / reka-ui |
| 样式 | Tailwind CSS v3 |
| 图标 | lucide-vue-next |
| 国际化 | vue-i18n 10 |
| 后端通信 | ws (WebSocket) + pi 子进程 RPC |
| 打包 | electron-builder |

## 项目结构

```
xyz-agent/
├── src-electron/
│   ├── main/                  # Electron 主进程
│   │   ├── main.ts            # 应用入口、窗口创建、生命周期
│   │   ├── sidecar-manager.ts # Sidecar 进程 spawn/stop
│   │   ├── shortcuts.ts       # 全局快捷键
│   │   └── ipc-handlers.ts    # IPC 处理器
│   ├── preload/               # Preload 脚本
│   ├── renderer/              # Vue 前端 (npm workspace: @xyz-agent/frontend)
│   │   └── src/
│   │       ├── components/    # Vue 组件 (chat/ layout/ panel/ drawer/ overview/ toast/)
│   │       ├── composables/   # 组合式函数 (useConnection, useSession, useProvider)
│   │       ├── stores/        # Pinia stores (settings, session)
│   │       └── lib/           # 工具库 (ws-client, event-bus, markdown)
│   ├── sidecar/               # Node.js WebSocket 服务 (npm workspace: @xyz-agent/sidecar)
│   │   └── src/
│   │       ├── server.ts      # WS 服务器
│   │       └── index.ts       # 入口
│   └── shared/                # 共享类型 (npm workspace: @xyz-agent/shared)
│       └── src/
│           ├── protocol.ts    # WS 消息协议
│           ├── message.ts     # 消息类型
│           ├── session.ts     # Session 类型
│           └── settings.ts    # 设置类型
├── docs/
│   ├── feature-map/          # 功能开发地图（长期规划、现状、决策、资料链接）
│   ├── designs/              # UI 设计 demo（HTML 文件）
│   ├── project/              # 功能清单（已完成 / 规划 / 最高优先级）
│   ├── templates/            # 竞品分析、设计原则、设计方向
│   └── standards.md          # 编码规范与架构标准
├── tools/                     # 验证脚本 (verify-*.cjs)
└── package.json               # 根 package（workspaces 配置）
```

## 编码规范

详见 [docs/standards.md](docs/standards.md) 和 [CLAUDE.md](CLAUDE.md)。

关键规则摘要：

- **禁止原生 HTML 表单元素** — 必须使用 xyz-ui 组件
- **禁止 Emoji** — 使用 SVG 或 lucide-vue-next
- **禁止手写 CSS 选择器** — `<style scoped>` 内只允许 `@apply`
- **emit 只传单个 payload 对象** — 禁止多参数 emit
- **行数上限** — `<template>` ≤ 400 行, `<script setup>` ≤ 300 行
- **禁止 `any`** — 用 `unknown` 或具体类型
- **独立数据源用 `Promise.allSettled`** — 不用 `Promise.all`

## License

Private
