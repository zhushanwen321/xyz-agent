---
verdict: fail
must_fix: 3
---

# 健壮性审查报告 — provider-model-mapping

**审查范围**: `feat-statusline` 分支 HEAD 相对 HEAD~1 的变更（4 文件）
**审查时间**: 2026-05-30
**审查维度**: 错误处理 / 异常安全 / 日志 / fail-fast / 测试友好 / 调试友好

## review_metrics

| 指标 | 值 |
|------|------|
| files_reviewed | 4 |
| issues_found | 8 |
| must_fix_count | 3 |
| low_count | 3 |
| info_count | 2 |

---

## 一、MUST_FIX 问题

### M1. ThinkingLevelConfig — watch 触发无限重入风险

**严重级**: MUST_FIX
**维度**: 异常安全
**文件**: `ThinkingLevelConfig.vue` L149-151

```ts
watch(() => props.modelValue, (newVal) => {
  initLevels(newVal)
})
```

当 ThinkingLevelConfig emit `update:modelValue` → 父组件更新 `model.thinkingLevelMap` → props 变化 → watch 触发 `initLevels` → 重建 `levels` ref → 但不 emit（好），链路终止。

表面看似安全，但存在隐藏的重入风险：

1. `initLevels` 会整体重建 `levels.value`，导致所有 Input 组件失焦（Vue 响应式数组整体替换）
2. 如果父组件对 `modelValue` 做了任何变换（如深拷贝、序列化-反序列化），即使值相同，引用也会变化，触发 `initLevels`，用户正在编辑的 Input 会失焦

**建议**: watch 加 `{ deep: true }` 并比较值是否真正变化，或使用 `watchEffect` + debounce，或在 `initLevels` 内做 diff 判断是否需要更新。

### M2. ProviderModal — `expandedModels` 在 Modal 关闭时未重置

**严重级**: MUST_FIX
**维度**: 异常安全 / 状态不一致
**文件**: `ProviderModal.vue` L66-72, L101-127

`expandedModels` 是 `ref<Set<string>>(new Set())`，在以下 watch 中处理 Modal 打开逻辑：

```ts
watch(() => props.visible, (v) => {
  if (v) {
    // 初始化表单、模型...
    // ⚠️ 但没有重置 expandedModels
  }
})
```

场景：
1. 用户编辑 Provider A，展开 model-X 的 ThinkingLevelConfig，保存关闭
2. 用户编辑 Provider B，Modal 打开 → `expandedModels` 仍包含 `model-X`
3. 如果 Provider B 没有 model-X，无害但浪费；如果 Provider B 恰好有同名 model-id，ThinkingLevelConfig 会在打开瞬间显示展开态，但数据是 Provider B 的，视觉上令人困惑
4. 关闭 Modal 的代码（`showModal.value = false`）在 ProviderPane 的 `handleSave` 和 Modal 的 close 事件中，均未清理 `expandedModels`

**建议**: 在 `watch(() => props.visible)` 的 `if (v)` 分支中加 `expandedModels.value = new Set()`。

### M3. ConfigService — `thinkingLevelMap` 类型检查不够严格

**严重级**: MUST_FIX
**维度**: fail-fast / 错误处理
**文件**: `config-service.ts` L112-114

```ts
if (m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object') {
  model.thinkingLevelMap = m.thinkingLevelMap as Record<string, string | null>
}
```

问题：
1. `typeof m.thinkingLevelMap === 'object'` 对 `Array`、`Date`、`RegExp` 等也返回 `true`，会将非法类型写入 models.json
2. 没有验证 value 是否为 `string | null`。如果前端传入 `{ off: 123, high: true }`，会直接写入配置文件，pi 读取时行为未定义
3. `m` 的类型是 `Record<string, unknown>`（因为 `data.models as Array<Record<string, unknown>>`），所以 `m.thinkingLevelMap` 是 `unknown`，直接 cast 为 `Record<string, string | null>` 不安全

**建议**: 添加运行时校验函数，如：
```ts
function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v).every(val => val === null || typeof val === 'string')
}
```

---

## 二、LOW 问题

### L1. ThinkingLevelConfig — `buildMap()` 不处理非标准 level key

**严重级**: LOW
**维度**: fail-fast
**文件**: `ThinkingLevelConfig.vue` L49-60

`buildMap()` 遍历 `levels.value`（由 `ALL_THINKING_LEVELS` 初始化，只有 7 个固定 key），但如果 `initLevels` 收到的 `map` 包含不在 `ALL_THINKING_LEVELS` 中的 key（如 `'ultra'`），这些 key 会被静默丢弃。

数据丢失本身风险低（pi 只识别标准 level），但用户如果手动编辑 models.json 添加了自定义 level，ThinkingLevelConfig 会无声地删除它们。

**建议**: 在 `initLevels` 末尾检查是否有未识别的 key，至少 console.warn。

### L2. ProviderPane — `handleSave` 的 try-catch 静默吞掉错误

**严重级**: LOW
**维度**: 日志 / 错误处理
**文件**: `ProviderPane.vue` L81-89

```ts
try {
  setProvider(providerId, { ... })
  showModal.value = false
  editingProvider.value = null
} catch (e: unknown) {
  console.error('Failed to save provider:', e)
}
```

问题：
1. catch 后没有给用户任何反馈（无 toast/banner/message），用户点击 Save → Modal 不关闭 → 无任何提示 → 用户困惑
2. `setProvider` 内部调用 `piBridge.upsertProvider`，最终是文件写入。Node.js 文件写入在正常场景下几乎不会 throw，这个 try-catch 更像是防御编程。但如果真的失败了（如磁盘满），用户完全不知道

**建议**: catch 中设置一个错误状态，在 UI 上显示保存失败提示。或在 catch 后 emit 一个 error 事件让父组件处理。

### L3. ThinkingLevelConfig — `onToggle` / `onInput` 无 index 越界保护

**严重级**: LOW
**维度**: fail-fast
**文件**: `ThinkingLevelConfig.vue` L63-70

```ts
function onToggle(idx: number): void {
  levels.value[idx].enabled = !levels.value[idx].enabled
```

如果 `idx` 越界（理论上不会，因为 idx 来自 `v-for`，但防御编程角度），会 throw `Cannot read properties of undefined`。

**建议**: 加边界检查 `if (idx < 0 || idx >= levels.value.length) return`。

---

## 三、INFO 问题

### I1. ThinkingLevelConfig — `applyPreset('deepseek')` 的 max level 重复映射

**严重级**: INFO
**维度**: 正确性
**文件**: `ThinkingLevelConfig.vue` L82-87

```ts
} else if (item.level === 'xhigh') {
  item.enabled = true
  item.apiValue = 'max'
} else if (item.level === 'max') {
  item.enabled = true
  item.apiValue = 'max'  // xhigh 和 max 都映射到 'max'
}
```

`xhigh` 和 `max` 都映射到 apiValue `'max'`，这是有意为之（DeepSeek 的 deepthink 只有 `high` 和 `max` 两档），但建议加注释说明设计意图，避免后续维护者误以为是 bug。

### I2. ConfigService — `data.models` 的 `as` 断言绕过类型系统

**严重级**: INFO
**维度**: 测试友好 / 类型安全
**文件**: `config-service.ts` L107

```ts
const rawModels = data.models as Array<Record<string, unknown>>
```

这个 `as` 断言将联合类型 `Array<string | { id: string; ... }>` 强转为 `Array<Record<string, unknown>>`，导致：
1. 如果 `models` 数组中包含 `string` 元素（合法的！`SetProviderData.models` 允许 `string[]`），后续 `m.id` 会是 `undefined`，`String(m.id ?? '')` 得到空字符串
2. 调试时难以发现是 string 还是 object 被传入

这不是本次变更引入的问题（原代码已有），但 `thinkingLevelMap` 新字段让这个路径更值得关注。

---

## 四、六维度总结

| 维度 | 评级 | 说明 |
|------|------|------|
| 错误处理 | ⚠️ 部分覆盖 | ProviderPane 有 try-catch 但吞错误（L2）；ConfigService 缺运行时类型校验（M3） |
| 异常安全 | ⚠️ 有隐患 | expandedModels 未重置（M2）；watch 可能重入（M1） |
| 日志 | ❌ 不足 | ConfigService 对 thinkingLevelMap 写入无日志；ThinkingLevelConfig 全程无日志 |
| fail-fast | ⚠️ 部分 | ThinkingLevelConfig 的 initLevels 对非法 key 无告警（L1）；index 无越界保护（L3） |
| 测试友好 | ❌ 弱 | ThinkingLevelConfig 的 buildMap/initLevels 是纯函数，理论上可测，但耦合了 Vue ref；ConfigService 类型校验可抽取为独立函数 |
| 调试友好 | ✅ 可接受 | "mapped" 标签可视化（好）；preset 按钮直观；但 ThinkingLevelConfig 内部状态（levels ref）不可从外部观察 |

---

## 五、修复优先级

| 优先级 | Issue | 预估工时 |
|--------|-------|----------|
| P0 | M2: expandedModels 未重置 | 5 min |
| P0 | M3: thinkingLevelMap 类型校验 | 15 min |
| P1 | M1: watch 重入 / Input 失焦 | 20 min |
| P2 | L2: handleSave 错误反馈 | 10 min |
| P3 | L1, L3, I1, I2 | 可选 |
