# xyz-agent CLAUDE.md

## 项目概述

xyz-agent 是基于 Tauri v2 + Vue 3 + Node.js Sidecar 的 AI Agent 桌面工作台。三层架构：
- **前端** (`src/src/`): Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui 组件库
- **Sidecar** (`sidecar/src/`): Node.js WebSocket 服务，通过子进程 RPC 与 pi 通信
- **Tauri** (`src-tauri/src/`): Rust 后端，管理 sidecar 进程和原生窗口

## 常用命令

```bash
npm run dev          # 开发模式 (Tauri dev)
npm run mock:dev     # Mock 模式 (XYZ_MOCK=1 VITE_MOCK=true)
npm run build        # 生产构建
npm run build:vite   # 仅构建前端
npm run lint         # ESLint 检查
npm run prepare      # 安装 git hooks
```

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
| taste-lint (ESLint) | no-native-html / no-emoji / prefer-v-model / no-hardcoded-colors / no-magic-spacing / no-silent-catch / prefer-allsettled | `npm run lint` + pre-commit |
| vue_rules_checker.py | 行数上限 / CSS 选择器 / Tab 缩进 / 原生元素 / Emoji / v-model | pre-commit |
| pre-commit hook | ESLint + vue_rules_checker | git commit |

### 渐进式迁移

部分旧文件尚未迁移到 xyz-ui 组件，记录在 `.githooks/vue_rules_checker.py` 的 `LEGACY_WHITELIST` 中。新文件必须遵循规范，旧文件在重构时逐步迁移。

## 架构约定

- **视图切换**: 状态驱动（settingsStore.currentView），不用 vue-router
- **Mock 模式**: `VITE_MOCK=true` 环境变量控制，在 ws-client 层拦截
- **共享类型**: `shared/src/` 通过 npm workspace 在前端和 sidecar 间共享
- **Sidecar 通信**: WebSocket，前端通过 `ws-client.ts` + `event-bus.ts` 消息分发

## 跳过检查

```bash
SKIP_ALL_CHECKS=1 git commit       # 跳过所有（仅紧急情况）
SKIP_FRONTEND_LINT=1 git commit    # 跳过 ESLint
SKIP_CODE_RULES_CHECK=1 git commit # 跳过 vue_rules_checker
```
