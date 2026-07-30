---
name: code-review
description: >-
  审查代码变更。触发词："review"、"审查代码"、"code review"、
  "帮我看看代码"。仅用于 xyz-agent 项目。
---

# code-review

审查当前 worktree 的代码变更，聚焦 xyz-agent 的
Electron + Vue 3 + TypeScript + Node.js Sidecar 架构。

## 启动方式

```bash
# 查看待审查的变更
git diff main...HEAD --stat
git diff main...HEAD
```

## 审查维度

### 1. Vue 3 组件规范

- [ ] 使用 Composition API + `<script setup>`（禁止 Options API）
- [ ] 模板中禁止直接调用方法做副作用，用 `computed` / `watch` 替代
- [ ] 组件 props 用 `defineProps<T>()`，不用 `defineProps({...})` 无类型版
- [ ] 无内联 styles，用 scoped CSS 或 utility classes
- [ ] `<template>` 不超过 400 行，`<script setup>` 不超过 300 行

### 2. TypeScript 类型安全

- [ ] 禁止 `any`，用 `unknown` 或具体类型
- [ ] 事件回调参数有明确类型注解
- [ ] 接口定义完整，不在运行时拼凑类型

### 3. Event Bus 防重复注册

- [ ] listener 注册使用 refCount 保护（`addEventListener` / `on` 配对）
- [ ] 组件 unmount 时清理所有 listener
- [ ] 无遗漏的 `removeEventListener` / `off`

### 4. Emit 规范

- [ ] `emit` 只传单个 payload 对象：`emit('update', { id, value })`
- [ ] 禁止 `emit('event', arg1, arg2)` 多参数模式
- [ ] payload 类型用 interface 定义

### 5. UI 状态错误重置

- [ ] 错误路径必须重置 `isGenerating` / `streamingMessage` 等加载状态
- [ ] `finally` 块或显式 error handler 中清理状态
- [ ] 无 possible infinite loading states

### 6. 代码质量

- [ ] 无死代码（unused imports / variables）
- [ ] 无 console.log 残留（调试代码已清理）
- [ ] 无硬编码的 magic numbers / strings

### 7. 代码质量扫描（fallow）

在人工审查前，运行 fallow 静态分析获取基线数据：

```bash
npm list -g @sourcemeta/fallow 2>/dev/null || npm install -g @sourcemeta/fallow
fallow scan $(git diff main...HEAD --name-only)
```

关注以下指标：
- **复杂度热点**：新增函数是否超过 80 行 / 15 圈复杂度
- **重复代码**：是否与现有代码有重复
- **未使用导出**：新增的类型/函数是否被使用
- **循环依赖**：是否引入新的循环引用

### 8. Electron IPC 安全

- [ ] 通过 preload 桥接，不直接 `require('electron')` 在渲染进程
- [ ] contextBridge.exposeInMainWorld 暴露的 API 最小化
- [ ] 无 IPC 通道暴露敏感操作（文件系统全访问、shell 执行等）

### 9. 测试覆盖

- [ ] 新增功能有对应测试
- [ ] 关键路径有边界条件测试
- [ ] 测试描述清晰，不依赖顺序执行

## 输出格式

审查结果按严重程度分级：

1. **BLOCKER** — 必须修复，阻塞合并
2. **WARNING** — 强烈建议修复
3. **SUGGESTION** — 可改进，不阻塞

每个条目格式：
```
[SEVERITY] file:line — 问题描述
  → 建议修复方式
```

---

## Pi Extension 接口契约 Checklist

> 以下 checklist 来源于实际 bug 复盘（session_start handler 读错参数、subagent 工具 schema 与描述矛盾）。
> 审查 `extensions/` 目录下的 pi extension 代码时 `[MANDATORY]` 逐条核对。

### 1. SDK 接口契约核对 `[MANDATORY]`

凡调用 `pi.on(...)`、`pi.registerTool(...)`、`pi.registerCommand(...)`、读 `ctx.*` 的代码：

- [ ] **handler 参数签名**：`pi.on(event, handler)` 的 handler 必须对照真实 SDK 的 `ExtensionHandler<E> = (event: E, ctx: ExtensionContext) => ...` 签名。**两个参数**——`modelRegistry`/`cwd`/`ui`/`sessionManager` 在第二个参数 `ctx` 上，不在 event 上。
- [ ] **真实 SDK 类型核对**：打开 `node_modules/@earendil-works/pi-coding-agent/dist/` 对照，不能只凭记忆写签名（SDK 版本升级后 API 可能变）。本项目根 devDependencies 已安装 `@earendil-works/pi-coding-agent@0.82.1`。
- [ ] **ctx.mode 分支**：xyz-agent 以 `--mode rpc` 运行 pi，`ctx.mode === "rpc"`。TUI 相关 API（`ctx.ui.setWidget`、`ctx.ui.custom`、`renderResult`）在 RPC 模式下失效。需要 GUI 渲染参阅 `docs/extensions/gui-protocol-guide.md`。

### 2. spec 偏差记录 `[MANDATORY]`

- [ ] 新增/修改的功能需求是否有对应的 spec 条目？无 spec 的功能不应直接实现。
- [ ] 实现与 spec 描述如有偏差，必须在 spec 末尾「实现偏差说明」补 D 编号记录（决策 + 原因）。偏差记录不是自愿的——未记录的偏差等于违反 spec。

### 3. schema / 描述一致性 `[MANDATORY]`

`registerTool` 的 `parameters` schema 与 `description`/`promptGuidelines` 必须一致：

- [ ] schema 必填字段（无 `Optional` 包裹）是否在所有执行模式下都真的必填？若某模式会忽略其他参数，被忽略的参数不应是 schema 层必填——否则 LLM 被迫传占位值。
- [ ] 条件必填场景：schema 设为 Optional，在 `execute()` 内根据模式做运行时校验（抛清晰错误）。
- [ ] `description` 中 "Ignores X/Y/Z" 之类的描述，必须与 schema 实际行为一致。

### 4. 类型断言（配合 taste/no-unsafe-cast） `[MANDATORY]`

`no-unsafe-cast` 规则会 warn 标记 `as never`/`as any`/`as unknown as`/全可选结构断言。审查时：

- [ ] 每处 warn 的断言，确认是否有**不可替代的理由**（如跨 tsconfig 泛型冲突、SDK 类型 stub 缺失）。
- [ ] 不可替代的断言，必须有配套的**运行时 guard**（参数判空抛错）或**契约测试**兜底——不能让类型断言成为唯一防线。

---

## 与 pr-cr-fix / review agent 的关系

本 skill 是**主会话自查的 checklist**（非 PR 触发），适用于快速 review 当前改动。

对于完整的 PR 级 review（review→fix→PR 统一编排），使用 `pr-cr-fix` skill，它会调度 `.agents/agents/` 下的 7 个 review agent 并行审查（arch-boundary / business-logic / electron-build / extension-api / monorepo-impact / test-coverage / type-safety）+ 1 个聚合器。

| 场景 | 用哪个 |
|------|--------|
| 快速自查当前改动（不提 PR） | 本 skill（code-review checklist） |
| PR 级多维 review + 自动修 must-fix + 推 PR | pr-cr-fix skill |

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
