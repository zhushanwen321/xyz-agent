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

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
