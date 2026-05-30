---
verdict: pass
complexity: L1
---

# Provider Model Thinking Level Mapping — Implementation Plan

## Goal

在 Provider 设置 UI 中为每个模型提供可视化的 `thinkingLevelMap` 编辑能力，使用户无需手动修改 `models.json` 即可配置 UI 级别到 API 级别的映射关系。

## Architecture

```
shared/types (SetProviderData.models)
        ↓
ConfigService.setProvider (透传 thinkingLevelMap)
        ↓
ProviderPane → ProviderModal → ThinkingLevelConfig (前端 UI)
        ↓
pi-config-bridge → models.json (持久化)
```

**核心思路**：`ModelInfo` 和 `PiModelDefinition` 已支持 `thinkingLevelMap` 字段。`getProviders()` 已读取该字段。需要修复的是 `setProvider()` 写入时丢失该字段，以及前端缺少编辑 UI。

## Tech Stack

- TypeScript（共享类型 + 后端）
- Vue 3 Composition API（前端组件）
- Tailwind CSS + xyz-ui 组件库（Button、Input、ToggleSwitch）
- WebSocket（前端 ↔ Sidecar 通信）

## File Structure

| Group | File | Action | Description |
|-------|------|--------|-------------|
| BG1 | `src-electron/shared/src/protocol.ts` | modify | SetProviderData.models 扩展 thinkingLevelMap |
| BG1 | `src-electron/runtime/src/services/config-service.ts` | modify | setProvider 保留 thinkingLevelMap |
| FG1 | `src-electron/renderer/src/components/settings/ThinkingLevelConfig.vue` | create | thinking level 映射编辑组件 |
| FG1 | `src-electron/renderer/src/components/settings/ProviderModal.vue` | modify | 集成 ThinkingLevelConfig |
| FG1 | `src-electron/renderer/src/components/settings/ProviderPane.vue` | modify | 传递 thinkingLevelMap 到 save 流程 |

## Task List

### Task 1: 扩展 SetProviderData.models 类型

- **Type**: backend (shared types)
- **Group**: BG1
- **Files**: `src-electron/shared/src/protocol.ts`

#### Steps

**Step 1**: 修改 `SetProviderData` 接口中 `models` 字段类型，增加 `thinkingLevelMap` 可选属性。

```typescript
// src-electron/shared/src/protocol.ts — 修改 SetProviderData 接口

// 修改前:
export interface SetProviderData {
  name?: string
  type?: string
  apiKey?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; contextWindow?: number }>
  enabled?: boolean
}

// 修改后:
export interface SetProviderData {
  name?: string
  type?: string
  apiKey?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }>
  enabled?: boolean
}
```

---

### Task 2: 修复 ConfigService.setProvider 保留 thinkingLevelMap

- **Type**: backend
- **Group**: BG1
- **Files**: `src-electron/runtime/src/services/config-service.ts`

#### Steps

**Step 1**: 在 `setProvider` 方法中，`rawModels.map` 回调内增加 `thinkingLevelMap` 透传逻辑。

```typescript
// src-electron/runtime/src/services/config-service.ts — setProvider 方法内
// 修改 rawModels.map 回调

// 修改前:
merged.models = rawModels.map(m => {
  const model: Record<string, unknown> = { id: String(m.id ?? '') }
  if (m.name) model.name = String(m.name)
  if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
  return model as unknown as PiModelDefinition
})

// 修改后:
merged.models = rawModels.map(m => {
  const model: Record<string, unknown> = { id: String(m.id ?? '') }
  if (m.name) model.name = String(m.name)
  if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
  if (m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object') {
    model.thinkingLevelMap = m.thinkingLevelMap as Record<string, string | null>
  }
  return model as unknown as PiModelDefinition
})
```

**Step 2**: 同步更新 `setProvider` 参数类型签名中的 `models` 类型。

```typescript
// src-electron/runtime/src/services/config-service.ts — setProvider 参数类型

// 修改前:
setProvider(providerId: string, data: {
  name?: string
  type?: string
  apiKey?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; contextWindow?: number }>
  enabled?: boolean
}): void {

// 修改后:
setProvider(providerId: string, data: {
  name?: string
  type?: string
  apiKey?: string
  baseUrl?: string
  models?: Array<string | { id: string; name?: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }>
  enabled?: boolean
}): void {
```

---

### Task 3: 创建 ThinkingLevelConfig.vue 组件

- **Type**: frontend
- **Group**: FG1
- **Files**: `src-electron/renderer/src/components/settings/ThinkingLevelConfig.vue`（新建）

#### Steps

**Step 1**: 创建 ThinkingLevelConfig.vue，包含 7 个 level 行 + 3 个预设按钮。

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import ToggleSwitch from './shared/ToggleSwitch.vue'
import { Input, Button } from '../../design-system'

interface LevelState {
  level: string
  enabled: boolean
  apiValue: string
}

const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const props = defineProps<{
  modelValue: Record<string, string | null> | undefined
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, string | null> | undefined]
}>()

const levels = ref<LevelState[]>([])

function initLevels(map: Record<string, string | null> | undefined) {
  levels.value = ALL_THINKING_LEVELS.map(level => {
    if (!map || !(level in map)) {
      return { level, enabled: true, apiValue: '' }
    }
    const val = map[level]
    if (val === null) {
      return { level, enabled: false, apiValue: '' }
    }
    return { level, enabled: true, apiValue: val }
  })
}

initLevels(props.modelValue)

watch(() => props.modelValue, (newVal) => {
  initLevels(newVal)
})

function buildMap(): Record<string, string | null> | undefined {
  const map: Record<string, string | null> = {}
  let hasMapping = false
  for (const l of levels.value) {
    if (!l.enabled) {
      map[l.level] = null
      hasMapping = true
    } else if (l.apiValue) {
      map[l.level] = l.apiValue
      hasMapping = true
    }
    // enabled + empty apiValue → omit key (transparent passthrough)
  }
  return hasMapping ? map : undefined
}

function onToggle(idx: number) {
  levels.value[idx].enabled = !levels.value[idx].enabled
  emit('update:modelValue', buildMap())
}

function onInput(idx: number, value: string) {
  levels.value[idx].apiValue = value
  emit('update:modelValue', buildMap())
}

function applyPreset(name: string) {
  if (name === 'deepseek') {
    levels.value = ALL_THINKING_LEVELS.map(level => {
      const presets: Record<string, string> = { high: 'high', xhigh: 'max', max: 'max' }
      if (level in presets) {
        return { level, enabled: true, apiValue: presets[level] }
      }
      return { level, enabled: false, apiValue: '' }
    })
  } else if (name === 'all-on') {
    levels.value = ALL_THINKING_LEVELS.map(level => ({ level, enabled: true, apiValue: '' }))
  } else if (name === 'generic') {
    levels.value = ALL_THINKING_LEVELS.map(level => {
      const presets: Record<string, string> = { high: 'high', xhigh: 'max', max: 'max' }
      if (level in presets) {
        return { level, enabled: true, apiValue: presets[level] }
      }
      return { level, enabled: true, apiValue: '' }
    })
  }
  emit('update:modelValue', buildMap())
}
</script>

<template>
  <div class="pl-6 py-2 space-y-1">
    <div
      v-for="(item, idx) in levels"
      :key="item.level"
      class="flex items-center gap-3 h-7"
    >
      <ToggleSwitch
        :model-value="item.enabled"
        @update:model-value="onToggle(idx)"
      />
      <span
        class="text-[12px] w-16 shrink-0"
        :class="item.enabled ? 'text-foreground' : 'text-muted'"
      >
        {{ item.level }}
      </span>
      <Input
        :model-value="item.apiValue"
        :disabled="!item.enabled"
        placeholder="—"
        class="flex-1 max-w-[160px]"
        @update:model-value="onInput(idx, $event)"
      />
    </div>
    <div class="flex gap-2 pt-2">
      <Button
        variant="outline"
        size="sm"
        class="text-[11px]"
        @click="applyPreset('deepseek')"
      >
        DeepSeek
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="text-[11px]"
        @click="applyPreset('all-on')"
      >
        全开（透传）
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="text-[11px]"
        @click="applyPreset('generic')"
      >
        通用映射
      </Button>
    </div>
  </div>
</template>
```

---

### Task 4: 集成 ThinkingLevelConfig 到 ProviderModal.vue

- **Type**: frontend
- **Group**: FG1
- **Files**: `src-electron/renderer/src/components/settings/ProviderModal.vue`

#### Steps

**Step 1**: 扩展 `ModalModel` 接口，增加 `thinkingLevelMap` 字段。

```typescript
// src-electron/renderer/src/components/settings/ProviderModal.vue
// 修改 ModalModel 接口

interface ModalModel {
  id: string
  name: string
  contextWindow: number
  enabled?: boolean
  thinkingLevelMap?: Record<string, string | null>
}
```

**Step 2**: 添加展开状态 ref 和 import。

```typescript
import ThinkingLevelConfig from './ThinkingLevelConfig.vue'

// 在 modalModels ref 后增加:
const expandedModels = ref<Set<string>>(new Set())

function toggleExpand(modelId: string) {
  if (expandedModels.value.has(modelId)) {
    expandedModels.value.delete(modelId)
  } else {
    expandedModels.value.add(modelId)
  }
}
```

**Step 3**: 修改 `props.models.map` 初始化逻辑，保留 `thinkingLevelMap`。

```typescript
// 修改 watch(opened) 内的 modalModels 初始化

modalModels.value = props.models.map(m => ({
  id: m.id,
  name: m.name,
  contextWindow: m.contextWindow ?? 0,
  thinkingLevelMap: m.thinkingLevelMap,
}))
```

**Step 4**: 修改自动发现 `models.map` 初始化，保留 `thinkingLevelMap`。

```typescript
// 修改 discoverModels 回调中的 modalModels 赋值

modalModels.value = models.map(m => ({
  ...m,
  contextWindow: m.contextWindow ?? 0,
}))
```

**Step 5**: 在模型行模板中增加 chevron 展开按钮和 ThinkingLevelConfig 嵌套区域。

在 `<template>` 中每个模型行的末尾（删除按钮之前）插入展开按钮，并在行后插入 ThinkingLevelConfig：

```html
<!-- 在模型行容器内，name 输入框和 contextWindow 输入框之后，删除按钮之前 -->
<Button
  variant="ghost"
  size="sm"
  class="shrink-0 !w-5 !h-5 !p-0 rounded-sm transition-transform duration-200"
  :class="{ 'rotate-90': expandedModels.has(mm.id) }"
  @click="toggleExpand(mm.id)"
>
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
</Button>

<!-- 在模型行容器之后、下一个模型行之前插入 -->
<div v-if="expandedModels.has(mm.id)">
  <ThinkingLevelConfig v-model="mm.thinkingLevelMap" />
</div>
```

**Step 6**: 在模型行名称旁增加 `mapped` badge。

```html
<!-- 在模型 id/name 显示区域附近 -->
<span
  v-if="mm.thinkingLevelMap && Object.keys(mm.thinkingLevelMap).length > 0"
  class="text-[10px] px-1.5 py-px rounded-sm bg-accent/10 text-accent"
>
  mapped
</span>
```

---

### Task 5: 修复 ProviderPane.vue save 流程传递 thinkingLevelMap

- **Type**: frontend
- **Group**: FG1
- **Files**: `src-electron/renderer/src/components/settings/ProviderPane.vue`

#### Steps

**Step 1**: 更新 `handleSave` 的 data 参数类型，增加 `thinkingLevelMap`。

```typescript
// src-electron/renderer/src/components/settings/ProviderPane.vue
// 修改 handleSave 参数类型

function handleSave(data: {
  name: string
  type: string
  url: string
  key: string
  models: { id: string; name: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }[]
  providerId?: string
}) {
```

**Step 2**: `setProvider` 调用已经透传 `...configData`（包含 `models`），无需额外修改。`ConfigService.setProvider`（Task 2）已处理 `thinkingLevelMap` 保留。确认 `rest` 解构包含 `models` 数组（含 `thinkingLevelMap`）即可。

```typescript
// 现有代码已通过 ...configData 透传 models，无需修改 setProvider 调用本身
// 只需确认 data 参数类型包含 thinkingLevelMap（Step 1）
```

**Step 3**: 在 save 失败时不关闭 Modal（当前已通过 `showModal.value = false` 在 finally 外处理）。确认错误路径：

```typescript
// 现有 handleSave 中 setProvider 无返回值（同步调用 pi-config-bridge）
// 如果 WS 断连，setProvider 会抛异常。需用 try-catch 包裹：

function handleSave(data: {
  name: string
  type: string
  url: string
  key: string
  models: { id: string; name: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }[]
  providerId?: string
}) {
  const { providerId: _pid, ...rest } = data
  const providerId = _pid || data.name.toLowerCase().replace(/\s+/g, '-')
  const { url, key, ...configData } = rest
  const apiKey = key && key !== '••••••••' ? key : undefined
  try {
    setProvider(providerId, {
      ...(apiKey !== undefined && { apiKey }),
      ...(url && { baseUrl: url }),
      ...configData,
    })
    showModal.value = false
    editingProvider.value = null
  } catch (e: unknown) {
    console.error('Failed to save provider:', e)
    // toast 或 inline message 由上层组件处理
  }
}
```

---

## Interface Contracts

### Module: ThinkingLevelConfig

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `buildMap` | `() → Record<string, string \| null> \| undefined` | 映射表或 undefined（全透传） | 所有 ON + 所有空 → `undefined` | AC-2, AC-3 |
| `applyPreset` | `(name: string) → void` | void | `"all-on"` 预设清除所有映射 | AC-6 |
| `initLevels` | `(map: Record<string, string \| null> \| undefined) → void` | void | `map` 为 `undefined` 时全部默认 ON + 空 | AC-2 |

### Module: ConfigService

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `setProvider` | `(providerId: string, data: SetProviderData) → void` | void | `models` 含 `thinkingLevelMap` 时保留写入 | AC-3 |

### Module: ProviderModal

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `toggleExpand` | `(modelId: string) → void` | void | 多行可同时展开 | AC-1 |
| `handleSave` | `() → void` | void | 无 `thinkingLevelMap` 时不写入字段 | AC-3 |

## Execution Groups

| Group | Tasks | Files | Dependencies |
|-------|-------|-------|--------------|
| BG1 | Task 1, Task 2 | 2 modified | 无 |
| FG1 | Task 3, Task 4, Task 5 | 1 created + 2 modified | BG1 完成 |

## Dependency Graph & Wave Schedule

```
Wave 1: BG1 (Task 1 → Task 2，类型先改再用)
Wave 2: FG1 (Task 3 可独立开发 → Task 4 集成 → Task 5 联调)
```

- Task 1 是 Task 2 的前置（类型定义先更新）
- Task 3 可与 BG1 并行开发（组件独立，不依赖后端类型变更）
- Task 4 依赖 Task 3（组件必须存在才能 import）
- Task 5 依赖 Task 4（Modal 接口变更后 Pane 才能对齐）

## Spec Metrics Traceability

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1: 展开/折叠 | `ProviderModal.toggleExpand` | UI 交互 | Task 4 |
| AC-2: Toggle 与输入 | `ThinkingLevelConfig` toggle/input | UI → 组件 state | Task 3 |
| AC-3: 数据持久化 | `ThinkingLevelConfig.buildMap` + `ConfigService.setProvider` | UI → WS → ConfigService → models.json | Task 1, 2, 3, 5 |
| AC-4: 保存失败处理 | `ProviderPane.handleSave` try-catch | save flow 错误处理 | Task 5 |
| AC-5: 过滤联动 | `InputToolbar`（已有，验证） | store → computed | 无新 task |
| AC-6: 预设模板 | `ThinkingLevelConfig.applyPreset` | UI 交互 | Task 3 |
