---
verdict: pass
must_fix: 0
---

# Integration Review v1 — Provider Model Thinking Level Mapping

**Reviewer**: integration-reviewer
**Date**: 2026-05-30
**Scope**: ThinkingLevelConfig ↔ ProviderModal ↔ ProviderPane ↔ useProvider ↔ ConfigService ↔ pi-config-bridge 全链路
**BLR 基线**: business_logic_review_v2.md (verdict: pass, MUST_FIX=0)

## Review Metrics

```yaml
review_metrics:
  files_reviewed: 8
  issues_found: 4
  must_fix_count: 0
  low_count: 2
  info_count: 2
```

## Verdict: PASS

全链路数据流正确，thinkingLevelMap 在各模块间类型一致、序列化/反序列化无损、错误传播不丢失字段。发现 2 个 LOW 级类型接口缺口和 2 个 INFO 级设计限制，均不影响运行时正确性。

---

## 1. 数据流链路验证

### 链路 1: ThinkingLevelConfig emit ↔ ProviderModal v-model

| 维度 | 验证结果 |
|------|---------|
| emit 类型 | `'update:modelValue': [value: Record<string, string \| null> \| undefined]` |
| v-model 绑定 | `v-model="model.thinkingLevelMap"` → `ModalModel.thinkingLevelMap?: Record<string, string \| null>` |
| 类型匹配 | ✅ 完全一致 |
| undefined 语义 | "全开（透传）"预设 → `buildMap()` 返回 `undefined` → v-model 传递 `undefined` → Modal 不写入字段 |

**结论**: ThinkingLevelConfig 与 ProviderModal 的接口契约完全匹配。

### 链路 2: ProviderModal emit save ↔ ProviderPane handleSave

| 维度 | 验证结果 |
|------|---------|
| Modal emit | `save: [data: ModalFormData]`，其中 `ModalFormData.models: ModalModel[]` |
| Pane 接收 | `handleSave(data: { ... models: { id; name; contextWindow?; thinkingLevelMap? }[] ... })` |
| thinkingLevelMap 传递 | `modalModels.value` 展开到 emit payload → Pane 解构 `{ ...configData }` → `setProvider` |
| 结构兼容性 | ✅ ModalModel 是 Pane 参数的超集（多了 `enabled`），但 `enabled` 在 ConfigService 中被忽略，无害 |

**结论**: Modal → Pane 数据传递正确，多余字段（`enabled`）在下游被安全忽略。

### 链路 3: ProviderPane ↔ useProvider composable

| 维度 | 验证结果 |
|------|---------|
| Pane 调用 | `setProvider(providerId, { apiKey?, baseUrl?, name, type, models })` |
| composable 签名 | `setProvider(providerId: string, data: SetProviderData = {})` |
| SetProviderData.models | `Array<string \| { id; name?; contextWindow?; thinkingLevelMap?: Record<string, string \| null> }>` |
| WS payload | `{ type: 'config.setProvider', payload: { providerId, ...data } }` |

**结论**: ProviderPane → useProvider 类型传递正确，SetProviderData 协议类型完整包含 thinkingLevelMap。

### 链路 4: useProvider WS send ↔ server.ts ↔ ConfigService

| 维度 | 验证结果 |
|------|---------|
| WS payload 序列化 | `JSON.stringify(msg)` → thinkingLevelMap 是合法 JSON（string/null 值） |
| server.ts 解构 | `const { providerId, ...data } = msg.payload` → data 包含 models 数组 |
| 类型断言 | `data as Parameters<IConfigService['setProvider']>[1]` → 运行时无影响，仅 TS 层窄化 |
| ConfigService 接收 | `data.models as Array<Record<string, unknown>>` → 运行时访问 m.thinkingLevelMap |
| isValidThinkingLevelMap | runtime type guard 验证 value 类型 → 通过后写入 |

**结论**: WS → server → ConfigService 数据传递正确，runtime type guard 替代了编译期类型检查。

### 链路 5: ConfigService ↔ pi-config-bridge ↔ models.json

| 维度 | 验证结果 |
|------|---------|
| merge 策略 | `{ ...base, id }` 保留已有 model 全部字段（reasoning/api/input 等） |
| thinkingLevelMap 写入 | `isValidThinkingLevelMap(m.thinkingLevelMap)` → true 时写入 |
| thinkingLevelMap 删除 | `m.thinkingLevelMap === undefined && base.thinkingLevelMap` → delete |
| 序列化 | `JSON.stringify(model)` → `Record<string, string \| null>` 是合法 JSON |
| 反序列化 | `JSON.parse(raw)` → 原样恢复 thinkingLevelMap 字段 |
| 写入原子性 | `atomicWrite()` 确保不写半文件 |

**结论**: ConfigService ↔ models.json 序列化/反序列化无损。

---

## 2. 回读链路验证

保存后数据回读全链路：

| 步骤 | 代码路径 | thinkingLevelMap 存在 |
|------|---------|---------------------|
| models.json 读取 | `piBridge.readModels()` → `JSON.parse(raw)` | ✅ |
| listProviders 映射 | `config.models.map(m => ({ ..., thinkingLevelMap: m.thinkingLevelMap }))` | ✅ |
| server 广播 | `broadcastProviderList()` → `config.providers` + `model.list` | ✅ |
| aggregateModels | `m.thinkingLevelMap` 包含在 ModelInfo 映射中 | ✅ |
| 前端 store | `onProviders` / `onModels` → `store.setProviders` / `store.setModels` | ✅ |
| Modal 重开 | `props.models.map(m => ({ ..., thinkingLevelMap: m.thinkingLevelMap }))` | ✅ |
| ThinkingLevelConfig 初始化 | `initLevels(map)` → 正确解析 enabled/apiValue | ✅ |

**结论**: 完整的 write → read → display 回路验证通过。

---

## 3. 状态同步验证

### Modal 关闭→重新打开

| 场景 | 行为 | 验证结果 |
|------|------|---------|
| 保存后重开 | `setProvider` WS → 服务端处理 → broadcast → store 更新 → 下次打开读取新数据 | ✅ 正确 |
| 取消后重开 | 未发送 WS → store 不变 → Modal 从 store 重新初始化 | ✅ 正确 |
| 修改后关闭再开 | watch(props.visible) → 重新从 props.models 拷贝 → 丢弃未保存的修改 | ✅ 正确 |
| expandedModels | 每次打开重置为 `new Set()` → 配置面板折叠 | ✅ 正确 |

### Discover 模型后 thinkingLevelMap 保留

```typescript
// ProviderModal.handleDiscover 的 discoverHandler
modalModels.value = models.map(m => {
  const existing = modalModels.value.find(em => em.id === m.id)
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow ?? 0,
    enabled: existing?.enabled ?? true,
    thinkingLevelMap: existing?.thinkingLevelMap,  // ← 保留已有映射
  }
})
```

| 场景 | 行为 | 验证结果 |
|------|------|---------|
| 已配置映射的模型被 discover 保留 | `existing?.thinkingLevelMap` 有值 → 保留 | ✅ |
| 新 discover 的模型 | `existing` 为 undefined → `thinkingLevelMap: undefined` → 透传模式 | ✅ |

**结论**: Modal 状态生命周期管理正确，discover 操作保留已有映射配置。

---

## 4. 跨模块错误传播

### 错误场景分析

| 错误源 | 错误类型 | 传播路径 | 下游处理 |
|--------|---------|---------|---------|
| ThinkingLevelConfig buildMap | 无（纯计算） | emit undefined/Record | ProviderModal 直接接收，无异常路径 |
| ProviderModal handleSave | 无（纯数据组装） | emit save | ProviderPane 接收 |
| ProviderPane handleSave | try/catch 包裹 | catch console.error，Modal 不关闭 | **INFO-2**: try/catch 实际无法捕获 WS 错误 |
| useProvider send | WS send 失败 | 消息入队等待重连 | 无用户反馈，但消息不丢失 |
| server.ts ConfigService.setProvider | 文件写入失败 | 异常冒泡到 server 通用 handler | WS error 消息发回客户端 |
| pi-config-bridge writeModels | JSON 写入异常 | atomicWrite 失败 → 抛出 | 向上冒泡到 server handler |
| isValidThinkingLevelMap | 类型不合法 | 跳过写入分支 | 静默忽略，不产生错误 |

### 关键发现

**ProviderPane 的 try/catch 是空设防**：`setProvider()` composable 函数是同步的 WS send 调用，不抛异常。实际的服务端错误通过异步 WS error 消息返回，但 ProviderPane 没有监听该消息。Modal 在 `try` 块内无条件关闭。

这是已有的 WS 架构设计限制，不是 thinkingLevelMap 引入的新问题。标记为 INFO-2。

---

## 5. 发现的问题

### LOW-1: IConfigService 接口 models 类型缺少 thinkingLevelMap

**严重级**: LOW
**影响**: 接口文档不完整，新实现者可能遗漏该字段

**位置**: `src-electron/runtime/src/interfaces.ts` L116-122

```typescript
// 当前
models?: Array<string | { id: string; name?: string; contextWindow?: number }>

// 应为
models?: Array<string | { id: string; name?: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }>
```

**分析**: `IConfigService.setProvider` 的 models 类型声明缺少 `thinkingLevelMap`，但实际 `ConfigService` 实现和 `SetProviderData` 协议类型都包含它。TypeScript 编译通过是因为：
1. server.ts 使用 `as Parameters<IConfigService['setProvider']>[1]` 类型断言绕过
2. ConfigService 使用 `as Array<Record<string, unknown>>` 绕过

运行时数据正确传递，但接口定义（契约）不完整。

**修复成本**: 1 行改动。建议在下次改动 interfaces.ts 时一并修复。

### LOW-2: ConfigService.setProvider 的 models 使用 `as Array<Record<string, unknown>>` 丢失类型安全

**严重级**: LOW
**影响**: 内部类型安全降级

**位置**: `src-electron/runtime/src/services/config-service.ts` setProvider 方法

```typescript
const rawModels = data.models as Array<Record<string, unknown>>
```

这个 `as` 断言绕过了 TypeScript 的类型检查，使得 `m.thinkingLevelMap` 的访问失去类型保护。runtime type guard `isValidThinkingLevelMap` 补偿了部分安全性，但如果将来添加新字段，编译器不会提醒在这里添加处理。

与 LOW-1 修复联动：如果接口类型正确，可以用具体类型替代 `Record<string, unknown>`。

### INFO-1: selfEmitting 标志位在默认 watch flush 下可能无效

**来源**: BLR v2 已识别
**位置**: ThinkingLevelConfig.vue

Vue 3 默认 `watch` flush 为 `pre`（异步调度），`selfEmitting = true/false` 在同步代码中设置，watch 回调在下一微任务执行时 `selfEmitting` 已重置为 false。实际效果：每次 emit 后 `initLevels` 会被额外调用一次（双重初始化）。

无功能影响：`initLevels` 和 `buildMap` 互为逆操作，结果状态一致。仅额外一次计算开销。

### INFO-2: ProviderPane handleSave 的 try/catch 无法捕获服务端错误

**位置**: `src-electron/renderer/src/components/settings/ProviderPane.vue` handleSave

```typescript
try {
  setProvider(providerId, { ... })  // 同步 WS send，不抛异常
  showModal.value = false           // 无条件关闭
  editingProvider.value = null
} catch (e: unknown) {
  console.error('Failed to save provider:', e)  // 永远不会执行
}
```

`useProvider.setProvider` 是异步 WS 模式，错误通过 WS error 消息异步返回。Modal 在发送后立即关闭，如果服务端处理失败，用户看不到错误反馈。

这是已有 WS 架构的设计限制，不是 thinkingLevelMap 引入的新问题。

---

## 6. 序列化/反序列化端到端验证

### 完整 round-trip 测试

**输入数据**: `{off: null, high: "high", xhigh: "max", max: "max"}`

| 阶段 | 操作 | 数据形态 |
|------|------|---------|
| 1. buildMap() | ThinkingLevelConfig 生成 | `{off: null, high: "high", xhigh: "max", max: "max"}` |
| 2. v-model emit | Vue 事件传递 | 同上 |
| 3. Modal save | 组装 ModalFormData | `model.thinkingLevelMap = {off: null, ...}` |
| 4. WS send | JSON.stringify | `'{"thinkingLevelMap":{"off":null,"high":"high",...}}'` |
| 5. WS receive | JSON.parse | `{off: null, high: "high", ...}` |
| 6. isValidCheck | runtime guard | `true` |
| 7. model 赋值 | `model.thinkingLevelMap = m.thinkingLevelMap` | 同上 |
| 8. writeModels | JSON.stringify → atomicWrite | JSON 文件中 `"thinkingLevelMap": {"off": null, ...}` |
| 9. readModels | JSON.parse | 同上 |
| 10. listProviders | 展开为 ProviderInfo | `model.thinkingLevelMap = {"off": null, ...}` |
| 11. aggregateModels | 展开为 ModelInfo | 同上 |
| 12. store 更新 | Pinia reactive | 同上 |
| 13. Modal 重开 | props.models → modalModels | 同上 |
| 14. initLevels | 解析为 LevelState[] | `off→{enabled:false, apiValue:''}`, `high→{enabled:true, apiValue:'high'}`, etc. |

**结论**: 完整 round-trip 数据无损，null 值和 string 值在 JSON 序列化/反序列化中正确保留。

---

## 7. 模块依赖关系图

```
ThinkingLevelConfig (buildMap/emit v-model)
        ↕ Record<string, string|null> | undefined
ProviderModal (form state + v-model binding)
        ↓ emit save: ModalFormData
ProviderPane (handleSave → composable call)
        ↓ setProvider(id, SetProviderData)
useProvider composable (WS send)
        ↓ WS message: config.setProvider
server.ts (destructure payload → ConfigService)
        ↓ ConfigService.setProvider(id, data)
config-service.ts (isValidCheck + merge + upsert)
        ↓ piBridge.upsertProvider(id, merged)
pi-config-bridge.ts (JSON.stringify → atomicWrite)
        ↓
models.json (磁盘持久化)

--- 回读路径 ---
pi-config-bridge.ts (readModels → JSON.parse)
        ↓
config-service.ts (listProviders → 映射 thinkingLevelMap)
        ↓
server.ts (broadcastProviderList → config.providers + model.list)
        ↓ WS broadcast
useProvider composable (onProviders/onModels → store)
        ↓
provider store (setProviders/setModels)
        ↓
ProviderPane (computed models → props)
        ↓
ProviderModal (watch visible → modalModels)
        ↓
ThinkingLevelConfig (initLevels → 恢复 UI 状态)
```

---

## 8. 问题汇总

| ID | 级别 | 问题 | 影响范围 | 修复建议 |
|----|------|------|---------|---------|
| LOW-1 | LOW | IConfigService 接口 models 类型缺少 thinkingLevelMap | 接口契约不完整 | interfaces.ts 补充 thinkingLevelMap 字段 |
| LOW-2 | LOW | ConfigService models 的 `as Array<Record<string, unknown>>` | 类型安全降级 | 与 LOW-1 联动，用具体类型替代 |
| INFO-1 | INFO | selfEmitting 标志在默认 flush 下无效 | 额外一次 initLevels 计算 | 使用 `{ flush: 'sync' }` 或 `nextTick` 模式 |
| INFO-2 | INFO | ProviderPane try/catch 无法捕获 WS 错误 | 服务端失败无用户反馈 | 已有设计限制，非本轮修复范围 |

---

## 9. 与 BLR v2 的交叉验证

| BLR v2 关注点 | 集成审查验证 |
|--------------|------------|
| `{ ...base, id }` merge 保留已有字段 | ✅ ConfigService ↔ pi-config-bridge 链路验证通过 |
| isValidThinkingLevelMap 守卫完备 | ✅ 服务端 runtime guard 覆盖所有非法输入 |
| "全开"预设 → delete thinkingLevelMap | ✅ 服务端 else-if 分支正确执行 delete |
| 新模型 base={} 场景 | ✅ 无 pre-existing 字段，不存在丢失 |
| selfEmitting 标志 | 确认为 INFO 级，无功能影响 |

BLR v2 的所有验证结论在集成审查中得到确认，无新增 MUST_FIX 问题。
