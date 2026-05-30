---
verdict: fail
must_fix: 1
---

# Business Logic Review — Provider Model Thinking Level Mapping

**Reviewer**: business-logic-reviewer
**Date**: 2026-05-30
**Commit**: HEAD (vs HEAD~1)
**Files Changed**: 6 (+257, -18)

## Review Metrics

```yaml
review_metrics:
  files_reviewed: 7
  issues_found: 4
  must_fix_count: 1
  low_count: 2
  info_count: 1
```

## Verdict: FAIL

1 个 MUST_FIX 问题导致 thinkingLevelMap 功能在保存后实际不可用。

---

## UC-1 模拟：为 DeepSeek 模型配置 thinking level 映射

### 执行路径追踪

| 步骤 | 代码位置 | 验证结果 |
|------|---------|---------|
| 点击编辑 → Modal 加载 | `ProviderModal.vue` watch(props.visible) L120 | ✅ `thinkingLevelMap` 从 props.models 正确复制到 modalModels |
| 点击 chevron 展开 | `toggleExpand()` L65 | ✅ Set 管理展开状态，多行可同时展开 |
| 点击 DeepSeek 预设 | `ThinkingLevelConfig.vue` applyPreset('deepseek') L80 | ✅ off~medium OFF, high="high", xhigh="max", max="max" |
| buildMap 序列化 | `buildMap()` L47 | ✅ OFF→null, ON+value→value, ON+empty→omit, hasNonTrivial→返回 map |
| v-model 双向绑定 | `ProviderModal.vue` L395 | ✅ `v-model="model.thinkingLevelMap"` 正确更新 reactive 对象 |
| 点击保存 | `handleSave()` → emit → ProviderPane.handleSave | ✅ thinkingLevelMap 随 models 数组传递 |
| WS 发送 | `useProvider.setProvider()` → `send()` | ✅ payload 包含 thinkingLevelMap |
| ConfigService 写入 | `config-service.ts` L113 | ✅ 条件 `m.thinkingLevelMap && typeof === 'object'` 正确保留 |
| pi-config-bridge 写入 | `upsertProvider()` | ✅ 写入 models.json |
| providerUpdated 广播 | → store 刷新 | ✅ 前端 store 收到更新 |

### 🔴 MUST_FIX-1: 保存后 model 字段丢失 → thinkingLevelMap 功能失效

**严重级**: MUST_FIX
**影响范围**: UC-1 核心路径
**发现位置**: `config-service.ts` setProvider() L104-118

**问题**:

`ConfigService.setProvider()` 在处理 models 时，只保留了 `id/name/contextWindow/thinkingLevelMap` 四个字段：

```typescript
// config-service.ts L104-118
merged.models = rawModels.map(m => {
  const model: Record<string, unknown> = { id: String(m.id ?? '') }
  if (m.name) model.name = String(m.name)
  if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
  if (m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object') {
    model.thinkingLevelMap = m.thinkingLevelMap
  }
  return model as unknown as PiModelDefinition
})
```

丢失的字段包括：`api`, `baseUrl`, `reasoning`, `input`, `maxTokens`, `cost`, `compat`。

**致命连锁反应**：

1. 用户保存 thinkingLevelMap 配置
2. `reasoning: true` 被丢弃（models.json 中该模型不再有 `reasoning` 字段）
3. `config.providerUpdated` 广播 → store 刷新
4. `InputToolbar.vue` L47 执行 `if (!model.reasoning) return []`
5. `model.reasoning` 为 `undefined` → `!undefined === true` → 返回空数组
6. **思考级别选择器消失**，用户刚配置的 thinkingLevelMap 完全无法使用

**复现路径**：

```
1. Auto-discover DeepSeek provider → models.json 中 ds-flash 有 reasoning: true
2. 打开 ProviderModal → 展开 ds-flash → 点击 DeepSeek 预设
3. 保存 → ConfigService.setProvider 用只有 4 个字段的 model 覆盖完整 model 定义
4. store 刷新 → InputToolbar 检测 reasoning=undefined → 不显示 thinking level picker
5. 用户的 thinkingLevelMap 配置成为死数据
```

**修复方案**：

在 `ConfigService.setProvider()` 中，用已有 model 定义作为基础，只覆盖用户实际修改的字段：

```typescript
const existingModels = (existing.models ?? []) as PiModelDefinition[]
merged.models = rawModels.map(m => {
  const base = existingModels.find(em => em.id === m.id) ?? {}
  return {
    ...base,  // 保留所有已有字段（api, reasoning, input 等）
    id: String(m.id ?? ''),
    ...(m.name && { name: String(m.name) }),
    ...(typeof m.contextWindow === 'number' && { contextWindow: m.contextWindow }),
    ...(m.thinkingLevelMap != null && { thinkingLevelMap: m.thinkingLevelMap }),
  } as PiModelDefinition
})
```

注意：需要区分"用户清除 thinkingLevelMap"和"用户未触及 thinkingLevelMap"两种场景。如果用户应用了"全开（透传）"预设，buildMap 返回 `undefined`，此时应从 model 中删除 thinkingLevelMap 字段而非保留旧值。需要在 payload 中增加标记或在 ProviderModal 中保留原始 model 引用用于 merge。

---

## UC-2 模拟：为新模型快速应用预设

### 执行路径追踪

| 步骤 | 代码位置 | 验证结果 |
|------|---------|---------|
| 新增模型 "deepseek-v3" | `addModel()` L149 | ✅ 无 thinkingLevelMap（undefined） |
| 展开配置面板 | `initLevels(undefined)` | ✅ 所有 7 个 level: ON + 空 |
| 点击"通用映射"预设 | `applyPreset('generic')` L97 | ✅ all ON, high="high", xhigh="max", max="max" |
| buildMap | `buildMap()` | ✅ `{high:"high", xhigh:"max", max:"max"}`, 其余 omit |
| 微调 low→OFF | `onToggle(2)` → buildMap | ✅ `{low:null, high:"high", xhigh:"max", max:"max"}` |
| 保存 | 同 UC-1 路径 | ✅ 数据正确传递到 ConfigService |
| 写入 models.json | config-service.ts L113 | ✅ thinkingLevelMap 写入 |

### 替代路径验证

- **4a "全开（透传）"**: applyPreset('all-on') → all ON + empty → buildMap() hasNonTrivial=false → return undefined → models.json 不写入 thinkingLevelMap ✅
- **6a 不微调直接保存**: 预设值完整写入 ✅

**UC-2 路径本身逻辑正确**，但受 MUST_FIX-1 影响，保存后 reasoning 字段丢失会导致功能不可用。

---

## UC-3 模拟：查看已有映射配置

### 执行路径追踪

**前置数据**: `models.json` 中 ds-flash 有 `thinkingLevelMap: {off:null, high:"high", xhigh:"max", max:"max"}`

| 步骤 | 代码位置 | 验证结果 |
|------|---------|---------|
| 打开编辑 | watch(props.visible) L120 | ✅ thinkingLevelMap 从 store model 复制到 modalModels |
| "mapped" badge | ProviderModal L385 | ✅ `thinkingLevelMap && Object.keys(...).length > 0` → 显示 |
| 展开配置 | `initLevels({off:null, high:"high", xhigh:"max", max:"max"})` | 见下表 |
| 关闭不保存 | — | ✅ 无副作用 |

**initLevels 逐字段验证**:

| level | map[level] | 条件分支 | enabled | apiValue | 符合 UC-3 预期 |
|-------|-----------|---------|---------|----------|---------------|
| off | null | val===null | false | '' | ✅ toggle OFF |
| minimal | undefined | !(level in map) | true | '' | ✅ ON+空（透传） |
| low | undefined | !(level in map) | true | '' | ✅ ON+空（透传） |
| medium | undefined | !(level in map) | true | '' | ✅ ON+空（透传） |
| high | "high" | val非null | true | "high" | ✅ ON+"high" |
| xhigh | "max" | val非null | true | "max" | ✅ ON+"max" |
| max | "max" | val非null | true | "max" | ✅ ON+"max" |

UC-3 所有步骤正确 ✅

---

## 数据序列化验证: buildMap() 逻辑

### 三种序列化规则

| 规则 | 输入状态 | buildMap 行为 | 输出 | 验证 |
|------|---------|-------------|------|------|
| ON + 空 | enabled=true, apiValue='' | 跳过（omit） | key 不在 map 中 | ✅ FR-2 |
| OFF | enabled=false | `map[level]=null, hasNonTrivial=true` | `"level": null` | ✅ FR-2 |
| ON + value | enabled=true, apiValue='high' | `map[level]=value, hasNonTrivial=true` | `"level": "value"` | ✅ FR-2 |

### 全透传场景

所有 7 个 level 均为 ON + 空 → 无任何 entry 写入 map → `hasNonTrivial=false` → return `undefined` → ProviderModal model.thinkingLevelMap = undefined → ConfigService 条件 `m.thinkingLevelMap && typeof === 'object'` 为 false → 不写入 models.json ✅

### 空对象防护

buildMap 初始化 `const map = {}`，不会产生空对象 `{}`。即使所有 level 都 ON+空，也返回 undefined 而非 `{}` ✅

---

## 错误路径分析

### 🟡 LOW-1: AC-4 保存失败处理未生效

**严重级**: LOW
**影响范围**: UC-1 替代路径 7a
**发现位置**: `ProviderPane.vue` handleSave() L65-77

ProviderPane 的 try/catch 新增：

```typescript
try {
  setProvider(providerId, { ... })
  showModal.value = false
  editingProvider.value = null
} catch (e: unknown) {
  console.error('Failed to save provider:', e)
}
```

`setProvider()` 来自 `useProvider()`，其实现是 `send({ type: 'config.setProvider', payload: {...} })`。`send()` 是 fire-and-forget WS 发送，不会因 WS 断连而同步抛异常。保存失败的唯一反馈通道是服务端通过 `config.providerUpdated` 广播更新后的列表——若保存失败，广播不会发出，但 Modal 已经关闭。

**实际行为**: WS 断连时，`send()` 静默失败（或 ws-client 内部吞错），Modal 仍关闭，用户以为保存成功但数据未持久化。

**Spec AC-4 要求**: "保存时如果 WS 断连或服务端返回错误，显示错误提示，不关闭 Modal"

**现状**: 不满足 AC-4。try/catch 提供了虚假的安全感。

---

## 其他发现

### 🟡 LOW-2: ThinkingLevelConfig watch 导致循环 re-initialization

**严重级**: LOW
**发现位置**: `ThinkingLevelConfig.vue` L112-114

```typescript
watch(() => props.modelValue, (newVal) => {
  initLevels(newVal)
})
```

每次用户操作（toggle/input/preset）触发 `emit('update:modelValue')` → 父组件更新 prop → watch 触发 → `initLevels()` 重建整个 levels 数组。

由于 buildMap() 和 initLevels() 互为逆操作，结果状态一致，不会产生逻辑错误。但每次用户交互导致：
1. `levels.value` 被 onToggle/onInput 修改（第一次）
2. `levels.value` 被 initLevels 重建（第二次）

对于输入框场景，虽然 Vue 的 key 复用机制通常能保持光标位置，但双重初始化不是最佳实践。

**建议**: 增加内部标志位，跳过由组件自身 emit 触发的 watch 回调。

### ℹ️ INFO-1: Preset 实现与 AC-6 完全一致

三个预设的实现已逐条验证：

| 预设 | AC-6 预期 | 代码实现 | 匹配 |
|------|----------|---------|------|
| DeepSeek | off~medium OFF, high="high", xhigh="max", max="max" | L82-94 | ✅ |
| 全开（透传） | 所有 ON, 所有空 | L95-98 | ✅ |
| 通用映射 | 所有 ON, high="high", xhigh="max", max="max" | L99-112 | ✅ |

---

## Summary

| ID | 严重级 | 问题 | 影响范围 |
|----|-------|------|---------|
| MUST_FIX-1 | MUST_FIX | setProvider 丢失 model 字段（reasoning/api 等），导致保存后 thinking level picker 消失 | UC-1/UC-2 核心路径 |
| LOW-1 | LOW | AC-4 保存失败处理未生效，try/catch 对 fire-and-forget WS 无效 | UC-1 替代路径 7a |
| LOW-2 | LOW | ThinkingLevelConfig watch 循环 re-init | 性能/代码质量 |
| INFO-1 | INFO | 三个预设实现完全符合 AC-6 | — |

**核心问题**: ConfigService.setProvider 中 models 数组的 full-replace 逻辑，使得 ProviderModal 保存时只写入 4 个字段（id/name/contextWindow/thinkingLevelMap），丢弃原有的 `reasoning`、`api`、`input` 等关键字段。此为 pre-existing bug，但本 PR 的 thinkingLevelMap 功能首次将"保存 provider 配置"变成高频操作，使该 bug 的触发概率从"极少"变为"每次配置 thinkingLevelMap 必触发"，且直接导致本 PR 的核心功能不可用。
