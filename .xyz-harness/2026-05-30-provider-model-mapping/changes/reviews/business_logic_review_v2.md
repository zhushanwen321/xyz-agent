---
verdict: pass
must_fix: 0
---

# Business Logic Review v2 — Provider Model Thinking Level Mapping

**Reviewer**: business-logic-reviewer
**Date**: 2026-05-30
**Commit**: e482b82 (fix: address review MUST_FIX issues)
**Diff Scope**: config-service.ts +18/-4, ThinkingLevelConfig.vue +10/-1, ProviderModal.vue +1

## Review Metrics

```yaml
review_metrics:
  files_reviewed: 3
  must_fix_resolved: 1
  must_fix_remaining: 0
  new_issues: 1
  new_issue_severity: info
```

## Verdict: PASS

MUST_FIX-1 已修复。`setProvider` 现在用 `{ ...base, id }` merge 策略保留已有 model 全部字段，reasoning/api/input 等关键字段不再丢失。

---

## MUST_FIX-1 验证：setProvider 保存后 reasoning 字段保留

### 修复代码

```typescript
// 修复前 (HEAD~1)
const model: Record<string, unknown> = { id: String(m.id ?? '') }

// 修复后 (HEAD)
const id = String(m.id ?? '')
const base = existingModels.find(em => em.id === id) ?? {}
const model: Record<string, unknown> = { ...base, id }
```

### UC-1 路径重新模拟

**前置数据**: models.json 中 ds-flash = `{ id: "ds-flash", reasoning: true, api: "openai-completions", input: ["text","image"], baseUrl: "...", maxTokens: 8192 }`

| 步骤 | 执行路径 | 验证结果 |
|------|---------|---------|
| 前端发送保存 | ProviderModal → useProvider.setProvider → WS | payload: `{ id: "ds-flash", name: "...", contextWindow: 64000, thinkingLevelMap: {off:null, high:"high", xhigh:"max", max:"max"} }` |
| 获取已有配置 | `piBridge.getProviderConfig("deepseek")` | existing.models 包含完整 ds-flash 定义 |
| 查找 base | `existingModels.find(em => em.id === "ds-flash")` | base = `{ id: "ds-flash", reasoning: true, api: "openai-completions", input: [...], ... }` |
| merge | `{ ...base, id }` | model 包含 reasoning: true ✅ |
| 覆盖 name | `m.name` truthy → `model.name = "..."` | 覆盖 base.name，不影响其他字段 ✅ |
| 覆盖 contextWindow | `typeof m.contextWindow === 'number'` → set | 覆盖 base.contextWindow ✅ |
| 写入 thinkingLevelMap | `isValidThinkingLevelMap(m.thinkingLevelMap)` → true → set | 写入 `{off:null, high:"high", ...}` ✅ |
| 写入 models.json | `upsertProvider()` | ds-flash = `{ reasoning: true, api: "openai-completions", ..., thinkingLevelMap: {off:null, ...} }` ✅ |
| store 刷新 | providerUpdated 广播 | model.reasoning = true ✅ |
| InputToolbar 检查 | `if (!model.reasoning) return []` | reasoning=true → 不触发 → thinking picker 正常显示 ✅ |

**结论**: MUST_FIX-1 彻底修复。reasoning 字段在保存后保留，连锁反应不再发生。

---

## "全开（透传）"预设场景验证

用户对已有 thinkingLevelMap 的模型应用"全开"预设后保存：

| 步骤 | 执行路径 | 验证结果 |
|------|---------|---------|
| applyPreset('all-on') | 所有 level → ON + 空 | buildMap → hasNonTrivial=false → return undefined ✅ |
| v-model emit | `emit('update:modelValue', undefined)` | ProviderModal model.thinkingLevelMap = undefined ✅ |
| 前端 payload | `m.thinkingLevelMap` 为 undefined | 不在 payload 中出现（或值为 undefined） ✅ |
| isValidThinkingLevelMap | `typeof undefined !== 'object'` → false | 跳过写入分支 ✅ |
| else-if 检查 | `m.thinkingLevelMap === undefined && base.thinkingLevelMap` | base 原有 thinkingLevelMap → truthy ✅ |
| delete | `delete model.thinkingLevelMap` | thinkingLevelMap 从 model 中移除 ✅ |
| 最终结果 | models.json 中 ds-flash 无 thinkingLevelMap 字段 | pi 使用默认透传行为 ✅ |

**关键点**: `{ ...base, id }` 先从 base 继承了 `thinkingLevelMap`，随后 `delete model.thinkingLevelMap` 将其删除。这保证了"从有映射→切回全开"场景下字段被正确清除。

---

## 新模型场景（base 为空对象）

| 步骤 | 执行路径 | 验证结果 |
|------|---------|---------|
| 新增模型 | id 不在 existingModels 中 | `base = {}` |
| merge | `{ ...{}, id }` | model = `{ id: "new-model" }` ✅ |
| 后续字段覆盖 | name/contextWindow/thinkingLevelMap | 仅写入用户提供的数据 ✅ |

新模型无 pre-existing 字段，不存在丢失问题。

---

## UC-2 重新模拟：为新模型快速应用预设

**前置数据**: 新增模型 "deepseek-v3"，existing 中无此模型

| 步骤 | 验证结果 |
|------|---------|
| addModel → 展开配置 → initLevels(undefined) | 所有 7 level: ON + 空 ✅ |
| applyPreset('generic') | high="high", xhigh="max", max="max" ✅ |
| buildMap | `{high:"high", xhigh:"max", max:"max"}` ✅ |
| 保存 → setProvider | base = {} → merge → 正确写入 ✅ |
| reasoning 保留 | 新模型 base 无 reasoning → 不影响（本来就无） ✅ |

UC-2 完整路径可用 ✅

---

## UC-3 重新模拟：查看已有映射配置

UC-3 为只读路径（打开 Modal 查看，关闭不保存），不涉及 setProvider 写入逻辑。v1 已验证所有步骤正确，修复不影响 UC-3。

UC-3 无变化 ✅

---

## isValidThinkingLevelMap 类型守卫

新增的 runtime type guard 替代了原来的 `m.thinkingLevelMap && typeof === 'object'` 检查：

```typescript
function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => val === null || typeof val === 'string')
}
```

| 输入 | 结果 | 正确性 |
|------|------|--------|
| `{off:null, high:"high"}` | true ✅ | 正常映射 |
| `{}` | true（vacuously） | 无害：空对象不产生副作用 |
| `undefined` | false ✅ | "全开"预设 |
| `null` | false ✅ | 非法值 |
| `[{off:null}]` | false ✅ | 数组拦截 |
| `{off: 123}` | false ✅ | 非法 value 类型 |
| `{off: {nested:true}}` | false ✅ | 嵌套对象拦截 |

守卫完备 ✅

---

## 附带修复：LOW-2 selfEmitting 标志位

修复提交同时处理了 v1 的 LOW-2（watch 循环 re-initialization）：

```typescript
let selfEmitting = false

function onToggle(idx: number): void {
  levels.value[idx].enabled = !levels.value[idx].enabled
  selfEmitting = true
  emit('update:modelValue', buildMap())
  selfEmitting = false
}

watch(() => props.modelValue, (newVal) => {
  if (!selfEmitting) initLevels(newVal)
})
```

### ℹ️ INFO-1: selfEmitting 标志位在默认 watch flush 模式下可能无效

**严重级**: INFO
**影响范围**: 性能（双重初始化），无功能影响

Vue 3 的 `watch()` 默认 `flush: 'pre'`，回调是异步调度的（下一微任务）。执行序列：

1. `selfEmitting = true`
2. `emit(...)` → 父组件同步更新 reactive state
3. Vue 调度 watch 回调（异步）
4. `selfEmitting = false` ← 同步执行，在 watch 回调之前
5. Watch 回调执行 → `selfEmitting` 已为 false → `initLevels` 仍被调用

如需真正阻止 re-init，应使用 `watch(..., { flush: 'sync' })` 或 `nextTick` 模式。但这仅影响性能（双重初始化），initLevels 和 buildMap 互为逆操作，结果状态一致，不会产生功能错误。维持 INFO 级别。

---

## v1 遗留问题状态

| v1 ID | 级别 | v2 状态 |
|-------|------|---------|
| MUST_FIX-1 | MUST_FIX | ✅ 已修复 |
| LOW-1 | LOW | 未修复（预期：不在本轮范围） |
| LOW-2 | LOW | ⚠️ 尝试修复但 selfEmitting 标志可能无效（INFO-1） |
| INFO-1 | INFO | —（预设实现正确，无需修复） |

---

## Summary

| ID | 级别 | 问题 | 状态 |
|----|------|------|------|
| MUST_FIX-1 | ~~MUST_FIX~~ | setProvider 丢失 model 字段 | ✅ 已修复 |
| INFO-1 | INFO | selfEmitting 标志在默认 flush 下可能无效 | 无功能影响 |

**核心修复验证通过**：`{ ...base, id }` merge 策略正确保留 reasoning/api/input 等全部已有字段，thinkingLevelMap 写入和删除逻辑完备，UC-1/UC-2/UC-3 三条路径完整可用。
