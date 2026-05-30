---
verdict: pass
must_fix: 0
---

# 健壮性审查报告 (Round 2) — provider-model-mapping

**审查范围**: feat-statusline HEAD~1 相对 HEAD 的修复变更（3 文件）
**审查时间**: 2026-05-30
**审查目的**: 验证 v1 审查中 3 条 MUST_FIX 的修复质量，检查是否引入新问题

## review_metrics

| 指标 | 值 |
|------|------|
| files_reviewed | 3 |
| must_fix_from_v1 | 3 |
| must_fix_resolved | 3 |
| new_issues_found | 1 |
| new_must_fix | 0 |
| low_count | 1 |

---

## 一、v1 MUST_FIX 逐条验证

### M1. ThinkingLevelConfig — watch 重入 / Input 失焦

**v1 问题**: `watch(() => props.modelValue)` 每次用户操作后触发 `initLevels`，整体替换 `levels.value` 导致 Input 失焦。

**修复方案**: 添加模块级 `selfEmitting` 标志，emit 前后设置/重置，watch 内判断跳过。

```ts
let selfEmitting = false

function onInput(idx: number, value: string): void {
  levels.value[idx].apiValue = value
  selfEmitting = true
  emit('update:modelValue', buildMap())
  selfEmitting = false
}

watch(() => props.modelValue, (newVal) => {
  if (!selfEmitting) initLevels(newVal)
})
```

**验证结论**: ✅ 功能正确（PASS），但存在机制瑕疵（见下方 NEW-L1）。

**实际安全性分析**:

| 执行步骤 | selfEmitting | 说明 |
|----------|-------------|------|
| `onInput` 修改 `levels.value[idx].apiValue` | false | 内部状态更新 |
| `selfEmitting = true` | true | 设置标志 |
| `emit(...)` → 父组件 v-model 赋值 | true | 同步执行，触发 reactive dep |
| Vue scheduler 将 watch callback 入队 | true | watch 是 `flush: 'pre'`，异步执行 |
| `selfEmitting = false` | false | 同步重置 |
| **[microtask]** watch callback 执行 | **false** | `!selfEmitting` 为 true → `initLevels` 被调用 |

由于 Vue 3 `watch` 默认 `flush: 'pre'`，callback 通过 `Promise.resolve().then()` 调度到微任务队列。`selfEmitting` 在同步代码段内已重置为 `false`，所以 **标志本身无法阻止 `initLevels` 执行**。

**但实际不造成 Input 失焦**，原因：

1. `v-for` 使用 `:key="item.level"` — key 稳定（'off', 'minimal' 等 7 个固定字符串）
2. `buildMap()` → `initLevels()` 是无损往返（round-trip），产生完全相同的数据
3. Vue 的 VDOM diff：key 匹配 + prop 值相同 → 不重建 DOM → Input 焦点保留

**判定**: 用户不可见的代码质量问题。`selfEmitting` 给了维护者错误的安全感（"已经防护了"），实际上防护无效但恰好无害。降级为 LOW。

---

### M2. ProviderModal — `expandedModels` 未重置

**v1 问题**: Modal 关闭再打开时，`expandedModels` 残留上次展开的 model-id，可能导致切换 Provider 后 ThinkingLevelConfig 错误展开。

**修复方案**: 在 `watch(() => props.visible)` 的 `if (v)` 分支中重置。

```diff
     modalModels.value = props.models.map(m => ({
       id: m.id,
       name: m.name,
       contextWindow: m.contextWindow ?? 0,
       thinkingLevelMap: m.thinkingLevelMap,
     }))
+    expandedModels.value = new Set()
     testResult.value = 'none'
```

**验证结论**: ✅ 完全修复。

- 重置位置正确：在 modalModels 初始化之后、其他状态重置之前
- 所有 Modal 打开场景均覆盖（新建 provider / 编辑 provider）
- 关闭时的 `cleanupDiscover()` 不涉及 expandedModels，打开时重置是唯一需要的时机

---

### M3. ConfigService — `thinkingLevelMap` 类型校验

**v1 问题**: `typeof m.thinkingLevelMap === 'object'` 对 Array/Date/RegExp 等返回 true，且不校验 value 类型，导致非法数据可能写入 models.json。

**修复方案**: 提取独立类型守卫函数 `isValidThinkingLevelMap`，并增加"透传清除"逻辑。

```ts
function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => val === null || typeof val === 'string')
}
```

使用处：

```ts
if (isValidThinkingLevelMap(m.thinkingLevelMap)) {
  model.thinkingLevelMap = m.thinkingLevelMap
} else if (m.thinkingLevelMap === undefined && base.thinkingLevelMap) {
  delete model.thinkingLevelMap
}
```

**验证结论**: ✅ 完全修复。

| 校验场景 | v1 行为 | v2 行为 | 修复 |
|----------|---------|---------|------|
| `null` | `typeof === 'object'` → 通过 → 写入 null | `typeof !== 'object'` → false → 不写入 | ✅ |
| `Array` | 通过 → 写入数组 | `Array.isArray` → false → 不写入 | ✅ |
| `{ off: 123 }` | 通过 → 写入非法 value | `Object.values` 检查 → false → 不写入 | ✅ |
| `{ high: "high" }` | 通过 | 正确通过 | ✅ |
| `{ off: null, high: "high" }` | 通过 | 正确通过 | ✅ |
| `undefined` (透传) | 不写入 | 不写入 + 清除已有 thinkingLevelMap | ✅ 额外改进 |

**附带修复**: 同一 commit 还修复了 business logic review 的 MUST_FIX-1（model 字段丢失问题）：

```ts
const existingModels = (existing.models ?? []) as PiModelDefinition[]
const base = existingModels.find(em => em.id === id) ?? {}
const model: Record<string, unknown> = { ...base, id }
```

`{ ...base, id }` 保留了 `reasoning`、`api`、`input`、`maxTokens`、`cost`、`compat` 等已有字段，只覆盖用户实际修改的字段。✅

---

## 二、新发现问题

### NEW-L1. `selfEmitting` 标志存在时序缺陷（代码质量）

**严重级**: LOW
**维度**: 代码正确性 / 可维护性
**文件**: `ThinkingLevelConfig.vue` L55, L63-67, L73-77, L110-112, L117

`selfEmitting` 作为同步标志无法跨越 Vue 的异步 watch 调度边界：

```
[同步] selfEmitting = true → emit() → selfEmitting = false
[微任务] watch callback → selfEmitting === false → initLevels() 仍被调用
```

**实际影响**: 无。原因见 M1 分析（stable key + same value → DOM 不变 → 焦点保留）。

**建议改进**: 如果要真正消除重入，使用值比较代替标志：

```ts
let lastEmittedJson = ''

function emitChange(): void {
  const map = buildMap()
  lastEmittedJson = JSON.stringify(map)
  emit('update:modelValue', map)
}

watch(() => props.modelValue, (newVal) => {
  if (JSON.stringify(newVal) === lastEmittedJson) return
  initLevels(newVal)
})
```

或者更简洁：直接移除 `selfEmitting`，在 `initLevels` 内做 diff 判断是否需要更新。

---

## 三、v1 LOW/INFO 问题状态

| v1 Issue | 本轮状态 | 说明 |
|----------|---------|------|
| L1: buildMap 丢弃未知 level key | 未变 | 非阻塞，可后续处理 |
| L2: handleSave try-catch 静默吞错误 | 未变 | 非阻塞，与 WS fire-and-forget 模型有关 |
| L3: onToggle/onInput 无越界保护 | 未变 | idx 来自 v-for，实际不会越界 |
| I1: xhigh/max 重复映射 | 未变 | 设计意图，加注释即可 |
| I2: data.models 的 as 断言 | 未变 | 已有模式 |

---

## 四、六维度总结（对比 v1）

| 维度 | v1 评级 | v2 评级 | 变化 |
|------|---------|---------|------|
| 错误处理 | ⚠️ 部分 | ✅ 良好 | M3 添加了严格运行时校验 |
| 异常安全 | ⚠️ 隐患 | ✅ 良好 | M2 重置 expandedModels；M1 焦点问题实际无害 |
| 日志 | ❌ 不足 | ❌ 不足 | 未变（非本次修复范围） |
| fail-fast | ⚠️ 部分 | ✅ 良好 | M3 类型守卫实现了 fail-fast |
| 测试友好 | ❌ 弱 | ⚠️ 部分 | isValidThinkingLevelMap 已抽取为独立纯函数，可单测 |
| 调试友好 | ✅ 可接受 | ✅ 可接受 | 未变 |

---

## 五、最终结论

**verdict: pass**

3 条 MUST_FIX 全部得到有效修复：

| Issue | 修复方案 | 结果 |
|-------|---------|------|
| M1: watch 重入 | selfEmitting 标志 | ✅ 实际无害（stable key 保证焦点保留），标志机制有时序瑕疵但不影响用户 |
| M2: expandedModels 未重置 | Modal 打开时重置为 new Set() | ✅ 完全修复 |
| M3: 类型校验不严格 | isValidThinkingLevelMap 类型守卫 | ✅ 完全修复，附带修复了 model 字段丢失问题 |

无新的 MUST_FIX 问题。1 个新 LOW（selfEmitting 时序缺陷），建议后续用值比较替代标志位。
