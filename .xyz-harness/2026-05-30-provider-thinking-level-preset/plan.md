---
verdict: pass
complexity: L1
last_updated: 2026-05-30
---

# Provider Thinking Level 快捷配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ProviderModal 中添加两个预设按钮（DeepSeek 预设 / 清空映射），并清理之前创建的 ThinkingLevelConfig 组件和 chevron 展开逻辑。

**Architecture:** 纯前端改动。在 ProviderModal.vue 中新增 `applyThinkingPreset` 函数和两个 Button，清理 expandedModels/toggleExpand 和 ThinkingLevelConfig 引用。InputToolbar.vue 的 ALL_THINKING_LEVELS 已对齐 pi-ai（当前代码已是正确值），无需修改。

**Tech Stack:** Vue 3 + TypeScript + xyz-ui Button 组件

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/renderer/src/components/settings/ThinkingLevelConfig.vue` | delete | FG1 | 删除不需要的组件（175 行） |
| `src-electron/renderer/src/components/settings/ProviderModal.vue` | modify | FG1 | 清理 chevron 逻辑 + 新增预设按钮 |
| `src-electron/renderer/src/components/settings/ProviderPane.vue` | modify | FG1 | handleSave 类型中对 thinkingLevelMap 保持现有处理 |
| `src-electron/runtime/src/services/config-service.ts` | no-change | — | 已有 thinkingLevelMap 合并逻辑，无需修改 |
| `src-electron/renderer/src/components/chat/InputToolbar.vue` | no-change | — | ALL_THINKING_LEVELS 已正确，无需修改 |

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1: DeepSeek 预设 | adopted | Task 3 |
| AC-2: 清空映射 | adopted | Task 3 |
| AC-3: InputToolbar 不展示 max | adopted | Task 2（验证已正确） |
| AC-4: 发送前自动同步 thinking level | adopted | Task 4（验证已正确） |
| AC-5: 不影响已有数据 | adopted | Task 1（清理不破坏已有逻辑）+ Task 3（保存走已有路径） |

---

## Interface Contracts

### Module: ProviderModal

#### Function: applyThinkingPreset

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| applyThinkingPreset | (preset: 'deepseek' \| 'clear') => void | void | modalModels 为空时不报错，静默跳过 | AC-1, AC-2 |

#### Data: ModalModel (existing)

| Field | Type | Description |
|-------|------|-------------|
| thinkingLevelMap | Record\<string, string \| null\> \| undefined | DeepSeek 预设写入固定 map；清空映射设为 undefined |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | applyThinkingPreset('deepseek') | Button click → set modalModels[].thinkingLevelMap → save → models.json | Task 3 |
| AC-2 | applyThinkingPreset('clear') | Button click → set modalModels[].thinkingLevelMap = undefined → save → models.json | Task 3 |
| AC-3 | InputToolbar ALL_THINKING_LEVELS | 已是正确值 `['off','minimal','low','medium','high','xhigh']`，无需修改 | Task 2 |
| AC-4 | ChatInput @select-thinking-level | 已有 setThinkingLevel 发送逻辑，无需修改 | Task 4 |
| AC-5 | ConfigService.setProvider merge | 已有 isValidThinkingLevelMap + merge 逻辑，无需修改 | Task 1 |

---

## Tasks

### Task 1: 清理 ThinkingLevelConfig 和 chevron 展开逻辑

**Type:** frontend

**Files:**
- Delete: `src-electron/renderer/src/components/settings/ThinkingLevelConfig.vue`
- Modify: `src-electron/renderer/src/components/settings/ProviderModal.vue`

- [ ] **Step 1: 删除 ThinkingLevelConfig.vue**

删除文件 `src-electron/renderer/src/components/settings/ThinkingLevelConfig.vue`

- [ ] **Step 2: 清理 ProviderModal.vue 中的 import 和展开逻辑**

在 `ProviderModal.vue` 中：

1. 删除 `import ThinkingLevelConfig from './ThinkingLevelConfig.vue'`（第 8 行）
2. 删除 `expandedModels` ref 和 `toggleExpand` 函数（第 59-66 行）
3. 删除 resetForm 中的 `expandedModels.value = new Set()`（第 117 行）

- [ ] **Step 3: 清理 ProviderModal.vue template 中的 chevron 和 ThinkingLevelConfig**

在 `<template>` 中删除：

1. chevron 按钮（包含 `rotate-90` class 绑定的 Button，约第 371-377 行）
2. "mapped" 标签（`v-if="model.thinkingLevelMap && ..."` 的 span，约第 379-381 行）
3. `<div v-if="expandedModels.has(model.id)">` 包裹的 ThinkingLevelConfig 区域（约第 389-391 行）

**保留：** 模型行中的 model.name、formatCtx、removeModel 按钮。

- [ ] **Step 4: 运行 dev 验证**

Run: `npm run dev`

预期：ProviderModal 编辑时不再有 chevron 展开按钮和 ThinkingLevelConfig 组件。模型行只显示名称、context window、删除按钮。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove ThinkingLevelConfig and chevron expand logic"
```

---

### Task 2: 验证 InputToolbar ALL_THINKING_LEVELS 已正确

**Type:** frontend (verification only)

**Files:**
- Verify: `src-electron/renderer/src/components/chat/InputToolbar.vue`

- [ ] **Step 1: 验证当前值**

读取 `InputToolbar.vue` 第 42 行，确认：
```typescript
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
```

如果已经是此值，无需修改。如果仍是旧值（`['low', 'medium', 'high', 'xhigh', 'max']`），则更新为上述值。

- [ ] **Step 2: 验证过滤逻辑**

确认 thinkingLevels computed（第 44-55 行）逻辑：
- `thinkingLevelMap` 为 undefined → 显示全部 level
- `thinkingLevelMap` 中 key 对应 `null` → 该 level 不显示
- `thinkingLevelMap` 中 key 对应 string → 该 level 显示

Run: `npm run dev`，确认 thinking picker 正常工作。

---

### Task 3: ProviderModal 新增预设按钮

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/settings/ProviderModal.vue`

- [ ] **Step 1: 添加 applyThinkingPreset 函数**

在 ProviderModal.vue `<script setup>` 中添加：

```typescript
function applyThinkingPreset(preset: 'deepseek' | 'clear') {
  for (const m of modalModels.value) {
    if (preset === 'deepseek') {
      m.thinkingLevelMap = {
        minimal: null, low: null, medium: null,
        high: 'high', xhigh: 'max'
      }
    } else {
      m.thinkingLevelMap = undefined
    }
  }
}
```

- [ ] **Step 2: 在 template 模型列表上方添加按钮**

在 `<div>` models-list 容器开头、模型列表 `<div v-for>` 之前，添加：

```html
<div class="flex gap-2 mb-3">
  <Button variant="outline" size="sm" @click="applyThinkingPreset('deepseek')">
    DeepSeek 预设
  </Button>
  <Button variant="outline" size="sm" @click="applyThinkingPreset('clear')">
    清空映射
  </Button>
</div>
```

- [ ] **Step 3: 运行 dev 验证**

Run: `npm run dev`

验证步骤：
1. 打开 Settings → Provider Section
2. 编辑一个已有 provider
3. 确认模型列表上方出现 "DeepSeek 预设" 和 "清空映射" 两个按钮
4. 点击 "DeepSeek 预设" → 保存 → 确认 InputToolbar 中该模型只显示 `off, high, xhigh`
5. 重新编辑同一 provider → 点击 "清空映射" → 保存 → 确认 InputToolbar 恢复显示全部 6 个 level

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add thinking level preset buttons to ProviderModal"
```

---

### Task 4: 验证 setThinkingLevel 发送链路和 config-service 保存

**Type:** frontend (verification only)

**Files:**
- Verify: `src-electron/renderer/src/components/chat/ChatInput.vue`（第 51 行 @select-thinking-level）
- Verify: `src-electron/runtime/src/services/config-service.ts`（setProvider merge 逻辑）

- [ ] **Step 1: 验证 ChatInput setThinkingLevel**

确认 `ChatInput.vue` 第 51 行：
```html
@select-thinking-level="(l: string) => emit('send-command', { type: 'session.setThinkingLevel', payload: { sessionId, level: l } })"
```
存在且工作正常。

- [ ] **Step 2: 验证 ConfigService.setProvider 的 thinkingLevelMap merge**

确认 `config-service.ts` 第 122-126 行的合并逻辑：
- `isValidThinkingLevelMap(m.thinkingLevelMap)` → 保存 map
- `m.thinkingLevelMap === undefined && base.thinkingLevelMap` → 删除旧 map
- 其他情况保留 base 值

此逻辑正确处理 DeepSeek 预设（写入 map）和清空映射（undefined → 删除 map）。

---

## Execution Groups

#### FG1: Provider Modal 清理与预设按钮

**Description:** 清理 ThinkingLevelConfig 组件和 chevron 展开逻辑，新增 DeepSeek 预设和清空映射按钮。

**Tasks:** Task 1, Task 2, Task 3, Task 4

**Files (预估):** 3 个文件（1 delete + 1 modify + 1 verify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium (前端改动) |
| 注入上下文 | Task 1-4 描述 + spec §Design + 前端编码规范 |
| 读取文件 | ProviderModal.vue, InputToolbar.vue, ChatInput.vue, config-service.ts, ThinkingLevelConfig.vue |
| 修改/创建文件 | ProviderModal.vue (modify), ThinkingLevelConfig.vue (delete) |

**Execution Flow (FG1 内部):** 串行执行 Task 1→2→3→4。

**Dependencies:** 无

**设计细节:** 纯前端改动，所有变更在 ProviderModal.vue 一个文件中。InputToolbar 和 ConfigService 已正确，仅需验证。

---

## Dependency Graph & Wave Schedule

```
FG1 (ProviderModal) → 完成

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | FG1 | 唯一的 Group，无依赖 |
```
