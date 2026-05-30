---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 1
  issues_found: 6
  must_fix_count: 0
  low_count: 3
  info_count: 3
---

# TS Taste Review: ProviderModal.vue

**文件**: `src-electron/renderer/src/components/settings/ProviderModal.vue`
**行数**: ~280 (script ~160, template ~120)
**整体评价**: 中等偏好，结构清晰但存在可改进项。

---

## 审查结果

### LOW-1: `handleDiscover` 内的 composable 调用位置不当

```typescript
// handleDiscover() 函数内部，约第 160 行
const { discoverModels } = useProvider()
discoverModels(...)
```

`useProvider()` 是 composable，应在 `<script setup>` 顶层调用，不能在普通函数内部按需解构。当前写法依赖 Vue 的响应式系统在某些场景下仍然能工作（因为 composable 内部可能只是返回一个函数引用），但违反了 Vue composable 的使用规范。如果 `useProvider` 内部有 `inject`/`provide` 或生命周期依赖，在函数内调用会导致非预期行为。

**建议**: 在 `<script setup>` 顶层解构 `const { discoverModels } = useProvider()`，然后直接调用。

### LOW-2: `discoverHandler` 的类型断言链过长

```typescript
const payload = (msg as { payload: Record<string, unknown> }).payload
const models = payload.models as Array<{ id: string; name: string; contextWindow?: number }>
const success = payload.success as boolean
const error = payload.error as string | undefined
```

三层 `as` 断言，且外层 `msg: unknown` 没有任何运行时校验。如果 event-bus 发出的消息结构变化，这里会静默失败。

**建议**: 定义一个 `DiscoveredModelsEvent` 类型，在 event-bus 层或此处做一次 runtime guard（至少检查 `payload` 存在且 `success` 是 boolean）。

### LOW-3: `applyThinkingPreset` 存在 hardcoded 枚举和条件分支

```typescript
function applyThinkingPreset(preset: 'deepseek' | 'clear') {
  for (const m of modalModels.value) {
    if (preset === 'deepseek') {
      m.thinkingLevelMap = {
        minimal: null, low: null, medium: null,
        high: 'high', xhigh: 'max',
      }
    } else {
      m.thinkingLevelMap = undefined
    }
  }
}
```

preset 值 `'deepseek'` 和 `'clear'` 是隐式枚举。随着 preset 增多，if-else 会膨胀。

**建议**: 用 Record<string, Record<string, string | null>> 映射 preset 配置，消除条件分支：

```typescript
const THINKING_PRESETS: Record<string, Record<string, string | null> | undefined> = {
  deepseek: { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
  clear: undefined,
}
```

### INFO-1: 两个 `watch(() => props.visible, ...)` 可合并

第 1 个 watch 负责表单初始化，第 2 个负责 keydown 监听注册和 discover 清理。两个 watch 监听同一个源，可合并为一个以减少 watch 数量。

### INFO-2: `FALLBACK_MODEL_COUNT = 3` 魔数

`handleTest` 中的 `FALLBACK_MODEL_COUNT` 有命名，但语义不清——为什么 fallback 是 3？这是测试模式的模拟值还是默认发现数量？建议加一行注释说明意图。

### INFO-3: template 中的内联 SVG 可考虑提取

模板中有 3 处内联 SVG（关闭按钮、删除按钮、测试按钮图标）。当前体积可控，但如果有更多图标加入，建议统一为图标组件或使用 lucide-vue-next。

---

## 总结

| 维度 | 评价 |
|------|------|
| 函数职责单一性 | 良好。每个 handler 职责明确，`cleanupDiscover` 正确抽离了清理逻辑 |
| 命名清晰度 | 良好。`discoverStatus`、`discoverMessage`、`cleanupDiscover` 等命名准确 |
| 代码重复 | 无明显重复 |
| 条件逻辑简洁性 | LOW-3 的 preset 分支可优化；discover handler 内的三路分支可接受 |
| 类型安全性 | LOW-1 (composable 误用) + LOW-2 (过度的 as 断言) 需改进 |
| 组件职责边界 | 偏宽。一个组件同时负责：provider 表单、model 列表管理、自动发现、thinking preset。可接受但不理想，长期应考虑拆分 model 列表为子组件 |
