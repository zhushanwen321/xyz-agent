# xyz-agent CLAUDE.md

## 项目概述

xyz-agent 是基于 Electron + Vue 3 + Node.js Sidecar 的 AI Agent 桌面工作台。架构：

- **Electron 主进程** (`src-electron/main/`): 窗口管理、sidecar 进程生命周期、快捷键
- **Preload** (`src-electron/preload/`): 安全桥接，暴露 `electronAPI` 给渲染进程
- **前端渲染进程** (`src-electron/renderer/src/`): Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui 组件库
- **Sidecar** (`src-electron/sidecar/src/`): Node.js WebSocket 服务，通过子进程 RPC 与 pi 通信
- **共享类型** (`src-electron/shared/src/`): 前端与 sidecar 之间的 TypeScript 类型定义

**完整编码规范**: [docs/standards.md](docs/standards.md)

**设计参考文档**:
- [竞品 UI 分析](docs/templates/competitor-ui-analysis.md) — Claude Code / Codex 逐图拆解，7 条设计原则
- [UI/UX 设计原则与参考](docs/templates/ui-design-principles-and-references.md) — 设计方法论 + 竞品案例 + 行动清单
- [设计方向](docs/templates/design-direction.md) — 产品定位、主题策略、窗口架构、实施优先级
- [暗色主题选项 demo](docs/templates/dark-theme-options.html) — 5 种 accent 色方案对比

## 常用命令

```bash
npm run dev          # 开发模式 (Electron + Vite HMR)
npm run build        # 生产构建 (electron-builder)
npm run lint         # ESLint 检查
npm run prepare      # 安装 git hooks
```

## 关键规则（违反必出 bug）

### 1. emit 只传单个 payload 对象
禁止 `emit('event', arg1, arg2)` — handler 极易混淆参数顺序。必须 `emit('event', { arg1, arg2 })`。

### 2. Event bus listener 防重复注册
组件可能多实例（split mode），listener 必须用模块级 refCount 保护，否则事件处理翻倍。

### 3. 错误必须重置 isGenerating + streamingMessage
任何错误路径都必须重置状态，否则 UI 卡死在「思考中」。错误作为 assistant 消息插入聊天流，不用顶部 banner。

### 4. 外部系统对接先验证再编码
对接 pi RPC 等外部系统时，先写独立验证脚本（`tools/verify-*.cjs`），确认字段名和格式后再写业务代码。

### 5. pi 适配层不信任外部格式
EventAdapter 和 session-pool 是 pi 协议的唯一适配点。业务代码不直接处理 pi 格式。`sendCommand` 必须检查 `success` 字段。

## 前端编码规范

**权威标准文档**: `~/Code/xyz-ui/CONVENTIONS.md`

### 核心规则

1. **禁止原生 HTML 表单元素** — 必须使用 xyz-ui 组件（Button/Input/Select/Dialog 等）
2. **禁止 Emoji** — 使用 inline `<svg>` 或 lucide-vue-next 图标
3. **禁止手写 CSS 选择器** — `<style scoped>` 内只允许 `@apply`
4. **行数上限** — `<template>` ≤ 400 行, `<script setup>` ≤ 300 行
5. **禁止 `any`** — 用 `unknown` 或具体类型
6. **v-model 绑定** — 禁止 `:value` + `@input`，用 `v-model`
7. **Promise.allSettled** — 独立数据源用 `allSettled`，不用 `all`
8. **禁止硬编码颜色** — 用 CSS 变量（`var(--accent)`）或语义 Tailwind 类
9. **禁止魔数间距** — 用标准 Tailwind scale，不用 `p-[17px]`

### 自动化检查

| 检查工具 | 覆盖范围 | 触发时机 |
|---------|---------|---------|
| taste-lint (ESLint) | no-native-html / no-emoji / prefer-v-model / no-hardcoded-colors / no-magic-spacing / no-silent-catch / prefer-allsettled / no-multi-arg-emit | `npm run lint` + pre-commit |
| vue_rules_checker.py | 行数上限 / CSS 选择器 / Tab 缩进 / 原生元素 / Emoji / v-model | pre-commit |


## 架构约定

- **视图切换**: 状态驱动（settingsStore.currentView），不用 vue-router
- **Mock 模式**: `VITE_MOCK=true` 环境变量控制，在 ws-client 层拦截
- **共享类型**: `src-electron/shared/src/` 通过 npm workspace 在前端和 sidecar 间共享
- **Sidecar 通信**: WebSocket，前端通过 `ws-client.ts` + `event-bus.ts` 消息分发
- **Electron IPC**: 主进程通过 preload 暴露 `window.electronAPI`，渲染进程不直接使用 `ipcRenderer`

## 跳过检查

```bash
SKIP_ALL_CHECKS=1 git commit       # 跳过所有（仅紧急情况）
SKIP_FRONTEND_LINT=1 git commit    # 跳过 ESLint
SKIP_CODE_RULES_CHECK=1 git commit # 跳过 vue_rules_checker
```
