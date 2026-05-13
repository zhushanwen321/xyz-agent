# Plan: Model Row Toggle 实现

## 问题

E2E 测试 TC-2-05 失败：前端 ProviderSection 的 Model Row toggle 发送 `model.switch` 消息，但 sidecar 的 `model.switch` handler 语义是"切换当前会话的活跃 model"（需要 sessionId），不是"启停 model"。此外，ModelInfo 的 `enabled` 字段从未被 sidecar 填充。

## 方案

新增 `model.toggle` 协议消息，前端只发 `{ providerId, modelId, enabled }` 三个字段，sidecar 侧原子更新 config.json 中对应 provider 的对应 model 的 `enabled` 状态。

不复用 `config.setProvider`（原方案），原因：
1. 前端需要做 ModelInfo → ProviderConfig.models 的双向格式转换，字段映射脆弱
2. 全量替换 models 数组，快速连续 toggle 会丢失状态
3. ProviderModal 保存时不感知 enabled，会覆盖已有 model 的 enabled 状态
4. 前端承担了不属于它的 config.json 内部结构知识

## 依赖

无。独立于其他 task。

## 文件变更清单

| # | 文件 | 改动 | 风险 |
|---|------|------|------|
| 1 | `src-electron/shared/src/provider.ts` | `ProviderInfo.models` 对象元素加 `enabled?` | 低：纯类型扩展 |
| 2 | `src-electron/shared/src/protocol.ts` | ClientMessageType 加 `model.toggle`，ServerMessageType 加 `model.toggled` | 低：追加联合类型成员 |
| 3 | `src-electron/sidecar/src/config-store.ts` | `ProviderConfig.models` 类型加 `enabled?`；新增 `toggleModelEnabled()` 函数 | 中：涉及 config.json 读写 |
| 4 | `src-electron/sidecar/src/provider-store.ts` | setProvider 的 models 参数类型加 `enabled?` | 低 |
| 5 | `src-electron/sidecar/src/server.ts` | aggregateModels 透传 enabled；新增 `model.toggle` case | 中 |
| 6 | `src-electron/renderer/src/composables/useProvider.ts` | handlers 加 `model.toggled` 监听 | 低 |
| 7 | `src-electron/renderer/src/components/settings/ProviderPane.vue` | toggleModel 加乐观更新，改发 `model.toggle` | 低 |
| 8 | `src-electron/renderer/src/components/settings/ProviderModal.vue` | ModalModel 加 enabled，discoverModels merge 已有状态 | 低 |
| 9 | `src-electron/renderer/src/stores/provider.ts` | 新增 `updateModel()` 方法（乐观更新用） | 低 |

---

## Task 1: 类型层 — provider.ts + protocol.ts

### 1a. provider.ts

文件：`src-electron/shared/src/provider.ts`

`ProviderInfo.models` 的对象元素加 `enabled`：

```typescript
// 改前
models: Array<string | { id: string; name?: string; ctx?: number; tags?: string[] }>

// 改后
models: Array<string | { id: string; name?: string; ctx?: number; tags?: string[]; enabled?: boolean }>
```

### 1b. protocol.ts

文件：`src-electron/shared/src/protocol.ts`

ClientMessageType 追加 `'model.toggle'`：

```typescript
// 在 'model.switch' 后面追加
export type ClientMessageType =
  | ... 
  | 'model.list' | 'model.switch' | 'model.toggle'
  | ...
```

ServerMessageType 追加 `'model.toggled'`：

```typescript
// 在 'model.switched' 后面追加
export type ServerMessageType =
  | ...
  | 'model.list' | 'model.switched' | 'model.toggled'
  | ...
```

验证：`cd src-electron && npx tsc --noEmit`（预计无新错误）

---

## Task 2: Sidecar 持久化层 — config-store.ts

文件：`src-electron/sidecar/src/config-store.ts`

### 2a. ProviderConfig.models 类型加 enabled

```typescript
// ProviderConfig 接口
models?: Array<string | { id: string; name?: string; ctx?: number; tags?: string[]; enabled?: boolean }>
```

### 2b. 新增 toggleModelEnabled 函数

在文件末尾（`export function getProvider` 之前）新增：

```typescript
/**
 * 切换指定 provider 下某个 model 的 enabled 状态。
 * 如果 model 是纯字符串，先升级为对象格式（保留 lookupModel 查询到的 name/ctx）再设置 enabled。
 * 返回 true 表示成功，false 表示未找到。
 */
export function toggleModelEnabled(providerId: string, modelId: string, enabled: boolean): boolean {
  const config = loadConfig()
  const prov = config.providers[providerId]
  if (!prov || !Array.isArray(prov.models)) return false

  let found = false
  prov.models = prov.models.map(m => {
    if (typeof m === 'string') {
      if (m === modelId) {
        found = true
        // 升级为对象格式，保留完整信息（name/ctx 通过 lookupModel 补全）
        // 注意：这里不 import lookupModel 避免 config-store 依赖 model-db
        // name/ctx 在首次 aggregateModels 时会被补全
        return { id: m, enabled }
      }
      return m
    }
    if (m.id === modelId) {
      found = true
      return { ...m, enabled }
    }
    return m
  })

  if (!found) return false
  saveConfig(config)
  return true
}
```

关键设计决策：
- 纯字符串 model 自动升级为对象格式（`"glm-5.1"` → `{ id: "glm-5.1", enabled: false }`），不丢失原数据
- 升级后的对象在 `aggregateModels` object 分支中：`name` 会 fallback 到 `String(meta.name ?? meta.id)` = id 本身（与 string 分支 `dbRecord?.name ?? entry` 结果一致，因为 lookupModel 查不到时也用 entry）
- 返回 boolean 让 server 层知道是否成功

验证：`cd src-electron && npx tsc --noEmit`

---

## Task 3: Sidecar 业务层 — provider-store.ts + server.ts

### 3a. provider-store.ts

文件：`src-electron/sidecar/src/provider-store.ts`

setProvider 的 models 参数类型加 `enabled`：

```typescript
models?: Array<string | { id: string; name?: string; ctx?: number; tags?: string[]; enabled?: boolean }>
```

注意：不需要在 provider-store 中新增 `toggleModel` 函数。server.ts 直接调用 config-store 的 `toggleModelEnabled` + `providerStore.reload()` 即可。

### 3b. server.ts — aggregateModels 透传 enabled

文件：`src-electron/sidecar/src/server.ts`

在 `aggregateModels` 方法的两个分支中透传 `enabled`：

**string 分支**（默认 true）：
```typescript
if (typeof entry === 'string') {
  const dbRecord = lookupModel(entry)
  return {
    id: entry,
    name: dbRecord?.name ?? entry,
    providerId: p.id,
    providerName: p.name,
    contextWindow: dbRecord?.context,
    enabled: true,  // string 格式默认启用
  } as ModelInfo
}
```

**object 分支**（读取持久化值）：
```typescript
if (entry && typeof entry === 'object' && 'id' in entry) {
  const meta = entry as { id: unknown; name: unknown; ctx?: unknown; tags?: unknown; enabled?: unknown }
  return {
    id: typeof meta.id === 'string' ? meta.id : String(meta.id),
    name: typeof meta.name === 'string' ? meta.name : String(meta.name ?? meta.id),
    providerId: p.id,
    providerName: p.name,
    tags: Array.isArray(meta.tags) ? meta.tags.filter(t => typeof t === 'string') : [],
    contextWindow: typeof meta.ctx === 'number'
      ? meta.ctx
      : this.parseCtxToNumber(
        typeof meta.ctx === 'string' ? meta.ctx : undefined,
      ),
    enabled: meta.enabled !== false,  // 读取持久化状态，默认 true
  } as ModelInfo
}
```

**fallback 分支**（默认 true）：
```typescript
return {
  id: String(m),
  name: String(m),
  providerId: p.id,
  providerName: p.name,
  enabled: true,
} as ModelInfo
```

### 3c. server.ts — 新增 model.toggle case

在 `case 'model.switch'` 的 break 之后新增：

```typescript
case 'model.toggle': {
  const { providerId, modelId, enabled } = msg.payload as {
    providerId: string
    modelId: string
    enabled: boolean
  }
  const ok = toggleModelEnabled(providerId, modelId, enabled)
  if (ok) {
    providerStore.reload()  // 清除内存缓存，下次 aggregateModels 从磁盘读取
    this.send(ws, {
      type: 'model.toggled',
      id: msg.id,
      payload: { providerId, modelId, enabled, success: true },
    })
    this.broadcastProviderList()  // 广播 config.providers + model.list（含更新后的 enabled）
  } else {
    // 失败时也广播最新状态，让前端清理 stale data（如 model 已被其他客户端删除）
    providerStore.reload()
    this.broadcastProviderList()
    this.send(ws, {
      type: 'model.toggled',
      id: msg.id,
      payload: { providerId, modelId, enabled, success: false, error: 'Model not found' },
    })
  }
  break
}
```

顶部 import 追加（项目使用 ESM，import 必须带 `.js` 后缀，见 server.ts 顶部已有 import 模式）：
```typescript
import { ..., toggleModelEnabled } from './config-store.js'
```

即修改现有第 7 行的 import，在解构中追加 `toggleModelEnabled`：
```typescript
// 改前
import { updateToolPermissions, getProvider, loadSkills, saveSkills, loadAgents, saveAgents } from './config-store.js'
// 改后
import { updateToolPermissions, getProvider, loadSkills, saveSkills, loadAgents, saveAgents, toggleModelEnabled } from './config-store.js'
```

验证：`cd src-electron && npx tsc --noEmit`

---

## Task 4: 前端事件层 — useProvider.ts

文件：`src-electron/renderer/src/composables/useProvider.ts`

handlers 中追加 `model.toggled` 监听（虽然实际更新由 `model.list` 广播触发，但保留作为确认回调和错误处理）：

```typescript
function onModelToggled(msg: ServerMessage) {
  const payload = msg.payload as { success?: boolean; error?: string }
  if (!payload.success) {
    console.error('[useProvider] model.toggle failed:', payload.error)
  }
  // 成功时 broadcastProviderList 已经发了新的 model.list，无需额外处理
}

const handlers: Record<string, (msg: ServerMessage) => void> = {
  // ... 已有的
  'model.toggled': onModelToggled,
}
```

验证：`cd src-electron && npx tsc --noEmit`

---

## Task 4.5: 前端 Store 层 — provider store 新增 updateModel

文件：`src-electron/renderer/src/stores/provider.ts`

新增 `updateModel` 方法，用于乐观更新（toggle 后立即修改本地 `models.value`，不等 WS 广播回来）：

```typescript
function updateModel(providerId: string, modelId: string, data: Partial<ModelInfo>) {
  models.value = models.value.map(m =>
    m.id === modelId && m.providerId === providerId ? { ...m, ...data } : m
  )
}
```

在 return 中导出：
```typescript
return {
  // ... 已有的
  updateModel,
}
```

---

## Task 5: 前端 UI 层 — ProviderPane.vue

文件：`src-electron/renderer/src/components/settings/ProviderPane.vue`

替换 `toggleModel` 函数（**含乐观更新**）：

```typescript
// 改前（当前代码，精确匹配）
function toggleModel(providerId: string, modelId: string) {
  const m = models.value.find(m => m.id === modelId && m.providerId === providerId)
  if (m) {
    send({ type: 'model.switch', payload: { modelId, enabled: !m.enabled } })
  }
}

// 改后
function toggleModel(providerId: string, modelId: string) {
  const m = models.value.find(m => m.id === modelId && m.providerId === providerId)
  if (m) {
    const newEnabled = !m.enabled
    // 乐观更新：立即修改本地状态，UI 即时响应
    providerStore.updateModel(providerId, modelId, { enabled: newEnabled })
    send({ type: 'model.toggle', payload: { providerId, modelId, enabled: newEnabled } })
  }
}
```

同时在 import 区域解构 `providerStore` 的 `updateModel`：
```typescript
const providerStore = useProviderStore()
// 无需额外 import，updateModel 是 store 上的方法
```

设计说明：
- 乐观更新保证 UI 即时响应（toggle switch 立即翻转 + opacity 变化）
- WS 广播 `model.list` 到达后会覆盖为服务端真实状态，保证最终一致
- 如果 toggle 失败（model not found），`broadcastProviderList` 广播会刷新前端数据，回滚乐观更新

验证：`cd src-electron && npx tsc --noEmit`

---

## Task 6: 修复 ProviderModal 保存时丢失 enabled 的问题

文件：`src-electron/renderer/src/components/settings/ProviderModal.vue`

ProviderModal 打开时从 `ModelInfo[]` 初始化 `modalModels`（第 101 行），但 `ModalModel` 接口没有 `enabled` 字段，保存时发出去的 models 数组也不含 enabled。

虽然用了新方案后 toggle 不走 setProvider，但 **ProviderModal 保存（编辑 provider）仍然会走 config.setProvider 并携带 models 数组**，如果不保留 enabled，还是会覆盖。

修复：ModalModel 加 enabled 字段，初始化时透传，保存时携带。

### 6a. ModalModel 接口加 enabled

```typescript
// 改前
interface ModalModel {
  id: string
  name: string
  ctx: string | number | undefined
  tags: string[]
}

// 改后
interface ModalModel {
  id: string
  name: string
  ctx: string | number | undefined
  tags: string[]
  enabled?: boolean
}
```

### 6b. 初始化时透传 enabled

```typescript
// 第 101 行
modalModels.value = props.models.map(m => ({
  id: m.id,
  name: m.name,
  ctx: m.contextWindow ?? '--',
  tags: [...(m.tags ?? [])],
  enabled: m.enabled !== false,
}))
```

### 6c. 保存时携带 enabled

handleSave 发送的 models 数组自然包含 enabled（因为 ModalModel 上已有），不需要额外处理。handleSave 中的 `...configData` 展开已经包含 models。

### 6d. discoverModels 时保留已有 enabled

ProviderModal 中 `config.discoveredModels` 事件处理在 `discoverHandler` 闭包变量中（约 L218-228）。
需要替换其中的 `modalModels.value = models.map(...)` 赋值：

```typescript
// 改前（discoverHandler 闭包内，约 L224）
      modalModels.value = models.map(m => ({
        id: m.id,
        name: m.name,
        ctx: m.ctx,
        tags: [],
      }))

// 改后
      modalModels.value = models.map(m => {
        const existing = modalModels.value.find(em => em.id === m.id)
        return {
          id: m.id,
          name: m.name,
          ctx: m.ctx,
          tags: [],
          enabled: existing?.enabled ?? true,  // 保留已有 toggle 状态
        }
      })
```

验证：`cd src-electron && npx tsc --noEmit`

---

## Task 7: 整体验证

```bash
# TypeScript 编译
cd src-electron && npx tsc --noEmit

# 重启 sidecar
kill $(lsof -i :3210 -t)
cd $PROJECT && ./src-electron/node_modules/.bin/tsx src-electron/sidecar/src/index.ts --port 3210 --project-root "$(pwd)" &

# 手动验证 model toggle
# 1. 打开 Electron Settings → Provider tab
# 2. 点击某个 Model Row 的 toggle
# 3. 验证 row 变为 opacity-50
# 4. 再次点击恢复
# 5. 检查 ~/.xyz-agent/config.json 中对应 model 的 enabled 字段
```

---

## 数据流图

```
用户点击 ModelRow toggle
  → ModelRow emit('toggle-enabled')
    → ProviderSection emit('toggle-model', providerId, modelId)
      → ProviderPane toggleModel(providerId, modelId)
        → send({ type: 'model.toggle', payload: { providerId, modelId, enabled } })
          → Sidecar case 'model.toggle'
            → toggleModelEnabled(providerId, modelId, enabled)
              → config.json: provider.models[x].enabled = value
            → providerStore.reload()  // 清缓存
            → broadcastProviderList()
              → 广播 config.providers（含 updated models）
              → 广播 model.list（aggregateModels 重新读取，含 enabled）
            → send model.toggled（确认消息）
          → 前端 onModelToggled（确认）
          → 前端 onModels（model.list 广播更新 models.value）
            → Vue reactivity → ModelRow enabled prop 更新 → UI 更新
```

## 风险点

| 风险 | 缓解措施 |
|------|---------|
| config.json 并发写入 | toggleModelEnabled 内部是同步的（loadConfig → mutate → saveConfig），Node.js 单线程不会交叉 |
| string model 升级为 object 后格式变化 | 升级是兼容的：{ id: "glm-5.1", enabled: false } 和 "glm-5.1" 在 aggregateModels 中都能正确处理 |
| ProviderModal 保存覆盖 enabled | Task 6 专门修复：ModalModel 加 enabled 字段，discoverModels 时 merge 已有状态 |
