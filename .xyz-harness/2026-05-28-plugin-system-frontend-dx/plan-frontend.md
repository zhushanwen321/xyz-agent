---
verdict: pass
---

# Plugin System — Frontend Design Document

## Overview

本文档覆盖 plan.md 中 **FG1/FG2/FG3** 三组前端 Task（T8–T12）的详细设计。前端组件通过 Pinia Store 管理插件状态，通过 WebSocket 与 sidecar 通信，遵循现有 `chat.ts`/`useChat.ts` 的架构模式。

**设计原则：**
- 组件 template ≤ 400 行, script ≤ 300 行
- 使用 xyz-ui 组件库（Button/Input/Select/Toggle/Dialog/Badge 等），禁止原生 HTML 表单元素
- Tailwind 工具类样式，禁止 `@apply`、禁止 `<style scoped>` 中写组件样式（Tailwind 无法表达的场景除外）
- 禁止 `any` 类型
- 禁止 Emoji

---

## §1: T8 — Plugin Store + Composable

### 1.1 stores/plugin.ts

**设计模式：** 对齐 `stores/chat.ts` 的 setup store 模式（`defineStore('plugin', () => { ... })`），全部操作为函数式 action，state 用 `reactive`/`ref`。

#### State

```typescript
// ── State ──────────────────────────────────────────────────────
const installedPlugins = ref<PluginInfo[]>([])
const pluginStatuses = reactive(new Map<string, string>())  // pluginId → status
const pluginNotifications = ref<PluginNotificationPayload[]>([])  // 最近 50 条
const permissionRequests = reactive(new Map<string, string[]>())  // pluginId → 待审批权限
const statusBarItems = ref<PluginStatusItem[]>([])
const messageDecorations = reactive(new Map<string, MessageDecoration[]>())  // messageId → decorations
const pluginConfigs = reactive(new Map<string, Record<string, unknown>>())  // pluginId → config
const loading = ref(false)
const error = ref<string | null>(null)
```

**类型定义（新建 `types/plugin.ts`）：**

```typescript
export interface PluginStatusItem {
  id: string
  text: string
  tooltip?: string
  commandId?: string
  pluginId: string
}

export interface MessageDecoration {
  pluginId: string
  pluginName: string
  text: string
  commandId?: string
}

export interface PluginContributes {
  slashCommands?: Array<{ name: string; description: string }>
  tools?: Array<{ name: string; description: string }>
  hooks?: string[]
  statusBarItems?: Array<{ id: string; text: string; priority: number }>
  settings?: PluginSettingSchema[]
}

export interface PluginSettingSchema {
  key: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path'
  label: string
  description?: string
  default?: unknown
  enumValues?: Array<{ label: string; value: string }>  // 仅 type='enum'
  requiresRestart?: boolean
}

/** 前端完整视图模型，扩展自 shared PluginInfo */
export interface PluginViewModel extends PluginInfo {
  description: string
  permissions: string[]
  contributes: PluginContributes
  errorMessage?: string
}
```

> `PluginViewModel` 扩展 `shared/PluginInfo`（pluginId/version/displayName/status/trustLevel/enabled），额外携带 description、permissions、contributes、errorMessage。sidecar 的 `config.plugins` 响应需包含这些字段，否则前端展示不完整。如果 sidecar 暂不返回 `contributes`，前端应 fallback 到空对象。

#### Actions

| Action | WS 消息 | 行为 |
|--------|---------|------|
| `fetchPlugins()` | `plugin.list` | 发送请求，sidecar 回复 `config.plugins`，更新 `installedPlugins` |
| `togglePlugin(id, enabled)` | `plugin.toggle` | 发送请求，乐观更新本地 state（立即反映 UI），sidecar 回复确认 |
| `uninstallPlugin(id)` | `plugin.uninstall` | 发送请求，sidecar 回复更新列表 |
| `approvePermissions(id, perms)` | `plugin.approvePermissions` | 发送批准的权限列表，清除 `permissionRequests` 中对应条目 |
| `revokePermissions(id)` | `plugin.revokePermissions` | 撤销全部权限 |
| `executeCommand(pluginId, commandId, args?)` | `plugin.executeCommand` | 执行插件注册的命令 |
| `getConfig(pluginId)` | `plugin.config.get` | 获取插件配置，存入 `pluginConfigs` |
| `setConfig(pluginId, key, value)` | `plugin.config.set` | 写入配置值，更新 `pluginConfigs` |

#### Getters

| Getter | 类型 | 说明 |
|--------|------|------|
| `activePlugins` | `ComputedRef<PluginInfo[]>` | status === 'active' |
| `pluginById(id)` | `(id: string) => PluginViewModel \| undefined` | 按 ID 查找 |
| `slashCommands` | `ComputedRef<SlashCommand[]>` | 从所有 active 插件的 `contributes.slashCommands` 聚合 |
| `hasPendingPermissions` | `ComputedRef<boolean>` | `permissionRequests.size > 0` |

#### Notification 队列管理

```typescript
function addNotification(n: PluginNotificationPayload) {
  pluginNotifications.value = [n, ...pluginNotifications.value].slice(0, 50)
}
```

#### 乐观更新 + 回滚策略

`togglePlugin` 和 `uninstallPlugin` 采用乐观更新：

```typescript
function togglePlugin(id: string, enabled: boolean) {
  // 1. 保存 snapshot
  const prev = installedPlugins.value.find(p => p.pluginId === id)
  if (!prev) return
  const prevEnabled = prev.enabled

  // 2. 乐观更新
  prev.enabled = enabled
  pluginStatuses.set(id, enabled ? 'active' : 'inactive')

  // 3. 发送 WS
  send({ type: 'plugin.toggle', payload: { pluginId: id, enabled } })

  // 4. 不做显式回滚——sidecar 回复 config.plugins 时会刷新全量列表
  //    如果 WS 断连，store 保持最后已知状态（与 chat.ts 行为一致）
}
```

### 1.2 composables/usePlugin.ts

**设计模式：** 对齐 `composables/useChat.ts` 的全局事件监听模式。`usePlugin` 不绑定特定 sessionId，所有插件事件是全局的。

#### 全局事件处理器注册

```typescript
// 模块级变量，与 useChat.ts 的 globalEventMap 模式一致
let globalPluginHandlers: Record<string, (msg: ServerMessage) => void> | null = null
let registerAttempted = false

function createPluginHandlers(): Record<string, (msg: ServerMessage) => void> {
  const store = usePluginStore()

  return {
    'config.plugins': (msg: ServerMessage) => {
      const payload = msg.payload as { plugins?: PluginViewModel[] }
      if (payload.plugins) {
        store.installedPlugins = payload.plugins
        // 同步 pluginStatuses map
        for (const p of payload.plugins) {
          store.pluginStatuses.set(p.pluginId, p.status)
        }
      }
    },

    'plugin:statusChange': (msg: ServerMessage) => {
      const { pluginId, newStatus } = msg.payload as { pluginId: string; newStatus: string }
      store.pluginStatuses.set(pluginId, newStatus)
      const plugin = store.installedPlugins.find(p => p.pluginId === pluginId)
      if (plugin) plugin.status = newStatus as PluginInfo['status']
    },

    'plugin:crashed': (msg: ServerMessage) => {
      const { pluginId, error } = msg.payload as PluginCrashedPayload
      store.pluginStatuses.set(pluginId, 'crashed')
      const plugin = store.installedPlugins.find(p => p.pluginId === pluginId)
      if (plugin) plugin.status = 'crashed'
      store.addNotification({ pluginId, level: 'error', message: error })
    },

    'plugin:notification': (msg: ServerMessage) => {
      const n = msg.payload as PluginNotificationPayload
      store.addNotification(n)
    },

    'plugin:permissionRequest': (msg: ServerMessage) => {
      const { pluginId, permissions } = msg.payload as { pluginId: string; permissions: string[] }
      store.permissionRequests.set(pluginId, permissions)
    },

    'plugin:statusBarUpdate': (msg: ServerMessage) => {
      const { items } = msg.payload as { items: PluginStatusItem[] }
      store.statusBarItems = items
    },

    'plugin:messageDecoration': (msg: ServerMessage) => {
      const { messageId, decorations } = msg.payload as { messageId: string; decorations: MessageDecoration[] }
      store.messageDecorations.set(messageId, decorations)
    },

    'plugin:config': (msg: ServerMessage) => {
      const { pluginId, config } = msg.payload as { pluginId: string; config: Record<string, unknown> }
      store.pluginConfigs.set(pluginId, config)
    },
  }
}
```

#### refCount 防重复注册

```typescript
let _refCount = 0

function registerGlobalListeners() {
  if (globalPluginHandlers) return
  globalPluginHandlers = createPluginHandlers()
  for (const [evt, handler] of Object.entries(globalPluginHandlers)) {
    on(evt, handler)
  }
}

function unregisterGlobalListeners() {
  if (!globalPluginHandlers) return
  for (const [evt, handler] of Object.entries(globalPluginHandlers)) {
    off(evt, handler)
  }
  globalPluginHandlers = null
}

// 在 usePlugin composable 中管理生命周期
export function usePlugin() {
  const store = usePluginStore()

  onMounted(() => {
    _refCount++
    if (_refCount === 1) {
      registerGlobalListeners()
    }
  })

  onUnmounted(() => {
    _refCount--
    if (_refCount === 0) {
      unregisterGlobalListeners()
    }
  })

  // 首次挂载时自动拉取插件列表
  if (store.installedPlugins.length === 0 && !store.loading) {
    store.fetchPlugins()
  }

  return { store }
}
```

> **注意：** usePlugin 的 refCount 模式不同于 useChat（useChat 的全局监听器注册一次永不注销）。这里选择 refCount + 注销是因为插件事件监听器只在有插件相关组件挂载时才需要，避免空转。但如果后续发现频繁注册/注销有性能问题，可切换为 useChat 的"注册一次"模式。

#### WS 断连时的行为

- Plugin store 保持最后已知状态（`installedPlugins`、`pluginStatuses`、`statusBarItems` 等）
- WS 重连后，`ws-client.ts` 的重连逻辑会触发 `config.plugins` 推送（sidecar 在 WS 连接时主动推送当前状态），store 自动更新
- 如果 sidecar 不主动推送，前端应在 WS `connected` 事件中重新调用 `store.fetchPlugins()`

---

## §2: T9 — PluginsPane

### 2.1 文件位置

`src-electron/renderer/src/components/settings/PluginsPane.vue`

### 2.2 与 ExtensionsPane 的模式差异

| 维度 | ExtensionsPane | PluginsPane |
|------|---------------|-------------|
| 数据来源 | `extension.list` → `config.extensions` | `plugin.list` → `config.plugins` |
| 列表项信息 | name, version, path, enabled | name, version, status badge, trustLevel badge, source tag, enabled |
| 操作 | 仅 toggle | toggle + uninstall + 信任等级切换 + 权限管理 + 配置表单 |
| 展开区 | MetaGrid（name/version/path） | 权限列表 + contributes + 错误信息 + PluginSettingsForm |
| 空状态 | 无插件引导 | 无插件引导 + 手动添加路径入口（仅显示） |
| 禁用态 | — | built-in 插件 toggle/卸载按钮灰显不可操作 |

### 2.3 组件结构概要

```html
<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <!-- Header -->
    <div class="mb-7">
      <div class="font-display text-[22px] font-bold tracking-tight">插件管理</div>
      <div class="text-[12px] text-muted mt-1">管理已安装的插件、权限和配置</div>
    </div>

    <!-- Plugin list (有插件时) -->
    <div v-if="plugins.length > 0" class="border border-border rounded-sm overflow-hidden mb-3">
      <!-- List header -->
      <div class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]">
        <span class="text-[13px] font-semibold">已安装插件</span>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">
          {{ plugins.length }}
        </span>
      </div>

      <!-- Plugin rows -->
      <PluginRow
        v-for="plugin in plugins"
        :key="plugin.pluginId"
        :plugin="plugin"
        @toggle="handleToggle"
        @uninstall="handleUninstall"
        @change-trust="handleTrustChange"
      />
    </div>

    <!-- Empty state (无插件时) -->
    <EmptyState v-else />

    <!-- Add path hint -->
    <div class="text-[11px] text-muted mt-3 px-1">
      手动安装：将插件放置在 ~/.xyz-agent/plugins/ 目录
    </div>

    <!-- Permission dialog (全局唯一) -->
    <PluginPermissionDialog
      v-if="pendingPermissionPlugin"
      :plugin-id="pendingPermissionPlugin.id"
      :plugin-name="pendingPermissionPlugin.name"
      :requested-permissions="pendingPermissionPlugin.permissions"
      :visible="showPermissionDialog"
      @confirm="handlePermissionConfirm"
      @cancel="handlePermissionCancel"
    />
  </div>
</template>
```

### 2.4 插件行组件 PluginRow（内联子组件，同文件内定义）

每个插件行显示：
- **Toggle** — 开关（built-in 灰显不可操作）
- **名称 + 版本 badge** — 版本用 `bg-[var(--accent-light)] text-[var(--accent)]` 小标签
- **状态 badge** — 5 种状态对应不同颜色：
  - `active`: 绿色 `bg-[var(--success-light)] text-[var(--success)]`
  - `inactive`: 灰色 `bg-[var(--hover-bg)] text-[var(--muted)]`
  - `discovered`: 蓝色 `bg-[var(--accent-light)] text-[var(--accent)]`
  - `loaded`: 黄色 `bg-[var(--warning-light)] text-[var(--warning)]`
  - `crashed`: 红色 `bg-[var(--error-light)] text-[var(--error)]`
- **信任等级 badge** — `trusted` 绿色 / `sandbox` 黄色
- **来源标签** — `built-in` 蓝色 / `external` 灰色
- **展开箭头** — 点击展开详情
- **卸载按钮** — 三点菜单内，built-in 不显示

展开区显示：
- **权限列表** — 已批准权限标签列表 + "撤销全部权限"按钮
- **Contributions** — 注册的 slash commands、tools、hooks 摘要
- **错误信息** — crashed 时显示 error message（红色文本）
- **PluginSettingsForm** — 有 `contributes.settings` 时渲染配置表单

### 2.5 启用/禁用交互流程

```
用户点击 Toggle
  → pluginStore.togglePlugin(id, enabled)  // 乐观更新
  → send({ type: 'plugin.toggle', payload: { pluginId, enabled } })
  → sidecar 回复 config.plugins（全量刷新）
  → store 更新 installedPlugins
  → UI 自动同步
```

### 2.6 卸载交互流程

```
用户点击卸载按钮
  → 弹出确认 Dialog（"确定卸载 {name}？" + Cancel/Confirm）
  → 用户确认
  → pluginStore.uninstallPlugin(id)
  → send({ type: 'plugin.uninstall', payload: { pluginId } })
  → sidecar 回复 config.plugins
  → 插件从列表移除
```

### 2.7 信任等级切换

```
用户在插件详情中点击信任等级 badge
  → 如果 sandbox → trusted: 弹出确认 Dialog（"提升信任等级将允许插件访问更多系统资源"）
  → 用户确认
  → send({ type: 'plugin.toggle', payload: { pluginId, trustLevel: 'trusted' } })
    // 注：需要确认 sidecar 是否支持单独修改 trustLevel，或需要新的 WS 类型
    // 如果无独立 WS 类型，可通过 plugin.toggle 的 payload 扩展
```

> **设计决策：** trustLevel 切换的 WS 消息需要与后端确认。如果 `plugin.toggle` 不支持 trustLevel 参数，需要在 protocol.ts 中新增 `plugin.setTrustLevel` 类型。

### 2.8 空状态设计

```html
<div class="border border-border rounded-sm py-12 px-6 text-center">
  <svg class="mx-auto mb-3 text-muted" width="32" height="32" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M12 8v8M8 12h8" />
  </svg>
  <div class="text-[13px] text-muted mb-1">暂无已安装插件</div>
  <div class="text-[11px] text-muted">
    将插件放置在 <span class="font-mono">~/.xyz-agent/plugins/</span> 目录即可自动发现
  </div>
</div>
```

### 2.9 行数预估

- **PluginsPane.vue**: template ~180 行 + script ~180 行 = ~360 行（在 400/300 限制内）
- 如果 PluginRow 逻辑复杂（权限列表、contributes 展示、settings form），应拆为独立子组件 `PluginRow.vue`，保持主文件在限制内

---

## §3: T10 — PluginSettingsForm

### 3.1 文件位置

`src-electron/renderer/src/components/settings/PluginSettingsForm.vue`

### 3.2 manifest settings schema → 表单映射

| Schema type | xyz-ui 组件 | 说明 |
|------------|------------|------|
| `string` | `Input` | 文本输入框 |
| `number` | `Input type="number"` | 数字输入框（或用 Input + 手动校验） |
| `boolean` | `Toggle` | 开关 |
| `enum` | `Select` | 下拉选择，options 来自 `enumValues` |
| `path` | `Input` | 文本框（Phase 4 加文件选择按钮） |

### 3.3 组件接口

```typescript
interface Props {
  pluginId: string
  settings: PluginSettingSchema[]
  disabled?: boolean  // 插件未激活时禁用表单
}

interface Emits {
  // 不需要 emit——直接通过 store 调用 setConfig
}
```

### 3.4 配置值读写流程

```
组件 mount
  → pluginStore.getConfig(pluginId)  // WS: plugin.config.get
  → sidecar 回复 plugin:config
  → store.pluginConfigs.set(pluginId, config)
  → 表单从 store 读取初始值

用户修改配置项
  → debounce 500ms（避免频繁 WS 调用）
  → pluginStore.setConfig(pluginId, key, value)  // WS: plugin.config.set
  → sidecar 回复 plugin:config（确认值已持久化）
  → store 更新 pluginConfigs
  → 如果 schema.requiresRestart === true，显示 inline 提示："此更改需重启插件后生效"
```

### 3.5 模板概要

```html
<template>
  <div class="flex flex-col gap-3">
    <div class="text-[12px] font-semibold text-muted mb-1">插件配置</div>
    <div
      v-for="setting in settings"
      :key="setting.key"
      class="flex items-center justify-between py-2 px-3 border-b border-border last:border-b-0"
    >
      <div class="flex flex-col min-w-0 flex-1 mr-4">
        <span class="text-[12px] font-medium text-fg">{{ setting.label }}</span>
        <span v-if="setting.description" class="text-[10px] text-muted mt-px">
          {{ setting.description }}
        </span>
      </div>

      <!-- Boolean: Toggle -->
      <Toggle
        v-if="setting.type === 'boolean'"
        :checked="getSettingValue(setting.key, setting.default as boolean)"
        @update:checked="handleSettingChange(setting.key, $event)"
        :disabled="disabled"
      />

      <!-- Enum: Select -->
      <Select
        v-else-if="setting.type === 'enum'"
        :model-value="getSettingValue(setting.key, setting.default as string)"
        @update:model-value="handleSettingChange(setting.key, $event)"
        :options="setting.enumValues ?? []"
        :disabled="disabled"
      />

      <!-- String/Number/Path: Input -->
      <Input
        v-else
        :model-value="String(getSettingValue(setting.key, setting.default ?? ''))"
        @update:model-value="handleSettingChange(setting.key, parseInputValue(setting, $event))"
        :type="setting.type === 'number' ? 'number' : 'text'"
        :placeholder="setting.description"
        :disabled="disabled"
        class="max-w-[200px]"
      />

      <!-- requiresRestart badge -->
      <span
        v-if="setting.requiresRestart"
        class="ml-2 text-[9px] text-warning bg-[var(--warning-light)] py-[1px] px-1.5 rounded-sm shrink-0"
      >
        需重启
      </span>
    </div>
  </div>
</template>
```

### 3.6 辅助逻辑

```typescript
// 从 store 中读取配置值，无则用 schema default
function getSettingValue(key: string, fallback: unknown): unknown {
  return store.pluginConfigs.get(props.pluginId)?.[key] ?? fallback
}

// 解析输入值
function parseInputValue(setting: PluginSettingSchema, raw: string): unknown {
  if (setting.type === 'number') {
    const n = Number(raw)
    return Number.isNaN(n) ? setting.default : n
  }
  return raw
}

// 防抖写入
const pendingChanges = reactive(new Map<string, unknown>())
let flushTimer: ReturnType<typeof setTimeout> | null = null

function handleSettingChange(key: string, value: unknown) {
  pendingChanges.set(key, value)
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    for (const [k, v] of pendingChanges) {
      store.setConfig(props.pluginId, k, v)
    }
    pendingChanges.clear()
  }, 500)
}
```

### 3.7 无 contributes.settings 的行为

如果插件的 `contributes` 中无 `settings` 字段，PluginsPane 的展开区不渲染 PluginSettingsForm 组件（`v-if="plugin.contributes?.settings?.length"` ）。

---

## §4: T11 — Permission Dialog

### 4.1 文件位置

`src-electron/renderer/src/components/plugin/PluginPermissionDialog.vue`（现有骨架增强）

### 4.2 现有骨架分析

当前骨架已实现：
- Props: `pluginId`, `pluginName`, `requestedPermissions`, `visible`
- 逐项 Toggle 开关
- confirm/cancel emit
- 样式基本完整

需要增强的点：

| 增强项 | 说明 |
|--------|------|
| 权限描述文本 | 当前只显示权限字符串（如 `fs.read`），需要映射到可读描述 |
| 权限风险等级 | 部分权限需要高亮显示风险（红色边框 + 警告图标） |
| 全选/全不选 | 添加批量操作按钮 |
| 自动弹出 | 监听 `plugin:permissionRequest` 事件，自动设置 visible 和数据 |
| 动画 | Dialog 出现时的过渡动画 |

### 4.3 权限描述映射

```typescript
// 权限描述映射表（内置，不需要外部数据）
const PERMISSION_DESCRIPTIONS: Record<string, { label: string; risk: 'low' | 'medium' | 'high' }> = {
  'fs.read': { label: '读取文件系统', risk: 'low' },
  'fs.write': { label: '写入文件系统', risk: 'medium' },
  'network.request': { label: '发送网络请求', risk: 'medium' },
  'clipboard.read': { label: '读取剪贴板', risk: 'medium' },
  'clipboard.write': { label: '写入剪贴板', risk: 'low' },
  'shell.execute': { label: '执行 Shell 命令', risk: 'high' },
  'env.read': { label: '读取环境变量', risk: 'low' },
  // 未知权限 fallback
}

function getPermissionMeta(perm: string) {
  return PERMISSION_DESCRIPTIONS[perm] ?? { label: perm, risk: 'medium' as const }
}
```

### 4.4 与 plugin:permissionRequest 事件对接

**方案：** 在 PluginsPane 中监听 store 的 `permissionRequests` 变化，自动弹出对话框。PluginPermissionDialog 保持纯展示组件（只负责渲染和用户操作），不直接监听事件。

```typescript
// PluginsPane.vue 中
const pendingPermissionPlugin = computed(() => {
  const entries = Array.from(pluginStore.permissionRequests.entries())
  if (entries.length === 0) return null
  const [pluginId, permissions] = entries[0]
  const plugin = pluginStore.installedPlugins.find(p => p.pluginId === pluginId)
  return {
    id: pluginId,
    name: plugin?.displayName ?? pluginId,
    permissions,
  }
})

const showPermissionDialog = computed(() => pendingPermissionPlugin.value !== null)

function handlePermissionConfirm(approvedPerms: string[]) {
  if (!pendingPermissionPlugin.value) return
  pluginStore.approvePermissions(pendingPermissionPlugin.value.id, approvedPerms)
}

function handlePermissionCancel() {
  if (!pendingPermissionPlugin.value) return
  // 拒绝 = 批准空列表
  pluginStore.approvePermissions(pendingPermissionPlugin.value.id, [])
}
```

### 4.5 增强后的模板概要

```html
<template>
  <Dialog :open="visible" :title="`${pluginName} — 权限请求`" @update:open="handleCancel">
    <p class="text-sm leading-relaxed mb-4" style="color: var(--muted)">
      插件 "{{ pluginName }}" 请求以下权限。您可以选择批准或拒绝每一项。
    </p>

    <!-- 批量操作 -->
    <div class="flex items-center gap-2 mb-3">
      <Button variant="ghost" size="sm" @click="selectAll">全选</Button>
      <Button variant="ghost" size="sm" @click="selectNone">全不选</Button>
    </div>

    <!-- 权限列表 -->
    <div class="flex flex-col gap-1.5 mb-5">
      <div
        v-for="perm in requestedPermissions"
        :key="perm"
        class="flex items-center justify-between px-3 py-2 rounded-sm border text-sm"
        :style="{
          borderColor: isSelected(perm)
            ? riskColor(getPermissionMeta(perm).risk)
            : 'var(--border)',
          background: isSelected(perm) ? riskBg(getPermissionMeta(perm).risk) : 'transparent',
        }"
      >
        <div class="flex items-center gap-2">
          <!-- 高风险警告图标 -->
          <svg
            v-if="getPermissionMeta(perm).risk === 'high'"
            class="shrink-0 text-error"
            width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div>
            <div class="font-medium text-fg">{{ getPermissionMeta(perm).label }}</div>
            <div class="text-[10px] text-muted font-mono">{{ perm }}</div>
          </div>
        </div>
        <Toggle
          :checked="isSelected(perm)"
          @update:checked="togglePermission(perm)"
        />
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="flex justify-end gap-2">
      <Button variant="outline" size="sm" @click="handleCancel">拒绝全部</Button>
      <Button variant="primary" size="sm" @click="handleConfirm">批准选中</Button>
    </div>
  </Dialog>
</template>
```

### 4.6 风险颜色映射

```typescript
function riskColor(risk: 'low' | 'medium' | 'high'): string {
  switch (risk) {
    case 'high': return 'var(--error)'
    case 'medium': return 'var(--warning)'
    case 'low': return 'var(--accent)'
  }
}

function riskBg(risk: 'low' | 'medium' | 'high'): string {
  switch (risk) {
    case 'high': return 'var(--error-light)'
    case 'medium': return 'var(--warning-light)'
    case 'low': return 'var(--accent-light)'
  }
}
```

---

## §5: T12 — Status Bar + MessageDecoration + SlashMenu

### 5.1 AppStatusbar 事件名修改

**现状：** `AppStatusbar.vue` 第 89 行监听 `plugin:status_bar_update`。

**修改：**
1. 将事件名从 `plugin:status_bar_update` 改为 `plugin:statusBarUpdate`
2. 将数据源从直接 event-bus 监听改为从 plugin store 读取 `statusBarItems`

```typescript
// 修改前（直接监听 event-bus）
onMounted(() => {
  _refCount++
  if (_refCount === 1) {
    _cleanup = on('plugin:status_bar_update', (items: PluginStatusItem[]) => {
      pluginItems.value = items.filter(...)
    })
  }
})

// 修改后（从 store 读取，事件由 usePlugin composable 处理）
import { usePluginStore } from '../../stores/plugin'
const pluginStore = usePluginStore()

// 直接使用 computed，不再需要 pluginItems ref
const pluginStatusBarItems = computed(() => pluginStore.statusBarItems)
```

**模板修改：**

```html
<!-- 替换 v-for="item in pluginItems" -->
<template v-for="item in pluginStatusBarItems" :key="item.id">
  <button
    class="inline-flex items-center gap-1 border-l border-border pl-2 hover:text-fg transition-colors cursor-pointer"
    :title="item.tooltip ?? ''"
    @click="handleStatusItemClick(item)"
  >
    {{ item.text }}
  </button>
</template>
```

**点击处理：**

```typescript
function handleStatusItemClick(item: PluginStatusItem) {
  if (item.commandId) {
    pluginStore.executeCommand(item.pluginId, item.commandId)
  }
}
```

> **注意：** 现有的 `_refCount` / `_cleanup` 模式可以保留用于 `plugin:statusBarUpdate` 事件到 store 的桥接，但更推荐完全移除，改为由 `usePlugin` composable 统一管理事件。AppStatusbar 只读 store 数据。

### 5.2 MessageDecoration.vue

**文件位置：** `src-electron/renderer/src/components/plugin/MessageDecoration.vue`

**设计：** 在消息气泡内渲染插件装饰标签。由 `MessageBubble.vue`（或等效的消息渲染组件）调用。

#### Props 接口

```typescript
interface Props {
  messageId: string
}
```

#### 模板

```html
<template>
  <div v-if="decorations.length > 0" class="flex flex-wrap items-center gap-1 mt-1">
    <button
      v-for="deco in decorations"
      :key="`${deco.pluginId}-${deco.text}`"
      class="inline-flex items-center gap-1 text-[10px] py-[1px] px-1.5 rounded-sm border border-border
             bg-[var(--section-bg)] text-muted hover:text-fg hover:border-muted
             transition-colors cursor-pointer"
      :title="`来自插件: ${deco.pluginName}`"
      @click="handleClick(deco)"
    >
      <span class="font-medium">{{ deco.pluginName }}</span>
      <span class="text-muted">·</span>
      <span>{{ deco.text }}</span>
    </button>
  </div>
</template>
```

#### Script

```typescript
<script setup lang="ts">
import { computed } from 'vue'
import { usePluginStore } from '../../stores/plugin'
import type { MessageDecoration } from '../../types/plugin'

const props = defineProps<{ messageId: string }>()
const pluginStore = usePluginStore()

const decorations = computed(() =>
  pluginStore.messageDecorations.get(props.messageId) ?? []
)

function handleClick(deco: MessageDecoration) {
  if (deco.commandId) {
    pluginStore.executeCommand(deco.pluginId, deco.commandId)
  }
}
</script>
```

#### 集成点

在消息渲染组件（`MessageBubble.vue` 或类似组件）中：

```html
<!-- 在消息内容下方 -->
<MessageDecoration :message-id="message.id" />
```

### 5.3 SlashMenu 插件命令合并

**现状：** `SlashMenu.vue` 通过 props 接收 `commands: SlashCommand[]`，由父组件 `ChatInput.vue` 通过 `useSlashCommands` composable 生成命令列表。

**修改策略：** 在 `useSlashCommands.ts` 的 `mergeSkillCommands` 中增加插件命令的合并。

#### 修改 useSlashCommands.ts

```typescript
// 在 mergeSkillCommands 函数中增加插件命令

/** 将插件 contributes.slashCommands 映射为 SlashCommand 格式 */
function mergePluginCommands(
  skills: SkillInfo[],
  agents?: AgentInfo[],
  pluginSlashCommands?: Array<{ name: string; description: string; pluginId: string }>,
): SlashCommand[] {
  // ... 现有 skillCmds + agentCmds 逻辑不变 ...

  const pluginCmds: SlashCommand[] = (pluginSlashCommands ?? []).map(cmd => ({
    name: cmd.name,
    description: cmd.description,
    source: 'plugin' as SlashCommandSource,
    action: {
      type: 'plugin' as const,
      pluginId: cmd.pluginId,
      commandName: cmd.name,
    } as SlashCommandAction,
  }))

  const all = [
    ...builtinCommands.value,
    ...nativeCommands.value,
    ...skillCmds,
    ...agentCmds,
    ...pluginCmds,
    ...extensionCommands.value,
  ]

  // 去重 + 排序（现有逻辑）
  // ...
}
```

#### 扩展 SlashCommandSource 和 SlashCommandAction

```typescript
// 在 useSlashCommands.ts 类型中增加
export type SlashCommandSource = 'builtin' | 'skill' | 'agent' | 'extension' | 'native' | 'plugin'

export type SlashCommandAction =
  | { type: 'local'; handler: (ctx: CommandContext) => void }
  | { type: 'protocol'; messageType: string }
  | { type: 'skill'; skillId: string }
  | { type: 'agent'; agentName: string }
  | { type: 'extension'; commandName: string }
  | { type: 'native'; commandName: string }
  | { type: 'plugin'; pluginId: string; commandName: string }  // 新增
```

#### SlashMenu 中的来源 badge

在 `SlashMenu.vue` 的 badge 渲染中增加 `plugin` source：

```html
<!-- 在现有的条件 badge class 列表中追加 -->
: ... existing conditions ...
: cmd.source === 'plugin'
? 'bg-[var(--warning-light)] text-[var(--warning)]'
: ...
```

显示文本：`cmd.source === 'plugin' ? 'plugin' : ...`

#### 插件命令执行

当用户选择插件 slash command 时：

```typescript
// 在 ChatInput.vue 或 useSlashCommands 的执行逻辑中
function executeCommand(cmd: SlashCommand, sessionId: string) {
  if (cmd.action.type === 'plugin') {
    const pluginStore = usePluginStore()
    pluginStore.executeCommand(cmd.action.pluginId, cmd.action.commandName, { sessionId })
    return
  }
  // ... 现有执行逻辑 ...
}
```

### 5.4 插件命令合并的数据流

```
Plugin Store 初始化
  → fetchPlugins() → sidecar 返回 config.plugins（含 contributes.slashCommands）
  → store.installedPlugins 更新
  → store.slashCommands getter 聚合所有 active 插件的 slash commands

ChatInput 渲染
  → useSlashCommands().mergeSkillCommands(skills, agents, pluginStore.slashCommands)
  → 合并后的命令列表传入 SlashMenu

用户选择插件命令
  → SlashMenu emit('select', cmd)
  → ChatInput 检测 cmd.action.type === 'plugin'
  → pluginStore.executeCommand(pluginId, commandName, { sessionId })
  → send({ type: 'plugin.executeCommand', payload: { pluginId, commandId, args } })
  → sidecar 路由到 Worker 执行
```

---

## 跨 Task 约束

### 行数预算

| 文件 | template | script | 合计 | 状态 |
|------|----------|--------|------|------|
| `stores/plugin.ts` | — | ~200 | ~200 | OK |
| `composables/usePlugin.ts` | — | ~150 | ~150 | OK |
| `PluginsPane.vue` | ~180 | ~150 | ~330 | OK (拆 PluginRow 可更小) |
| `PluginSettingsForm.vue` | ~80 | ~120 | ~200 | OK |
| `PluginPermissionDialog.vue` | ~80 | ~120 | ~200 | OK |
| `MessageDecoration.vue` | ~20 | ~30 | ~50 | OK |
| `AppStatusbar.vue` (修改) | ~10 改动 | ~30 改动 | 现有 ~130 → ~170 | OK |
| `SlashMenu.vue` (修改) | ~5 改动 | ~0 | 现有 ~200 | OK |
| `useSlashCommands.ts` (修改) | — | ~30 改动 | 现有 ~200 → ~230 | OK |

### 依赖关系

```
T8 (Store + Composable) ──→ T9 (PluginsPane)
                       ├──→ T10 (PluginSettingsForm)
                       ├──→ T11 (PermissionDialog)
                       └──→ T12 (StatusBar + Decoration + SlashMenu)
```

T9/T10/T11/T12 均依赖 T8 的 store 和 composable。T12 中 SlashMenu 的修改还依赖 `useSlashCommands.ts` 类型扩展。

### WS 类型扩展需求

BG1（后端 Task T3）需要在 `protocol.ts` 中新增以下类型，前端 T8 直接使用：

**Client → Server 新增：**

```typescript
// ClientMessageType 追加
| 'plugin.uninstall'
| 'plugin.approvePermissions'
| 'plugin.revokePermissions'
| 'plugin.executeCommand'
| 'plugin.config.get'
| 'plugin.config.set'

// ClientMessageMap 追加
'plugin.uninstall': { pluginId: string }
'plugin.approvePermissions': { pluginId: string; permissions: string[] }
'plugin.revokePermissions': { pluginId: string }
'plugin.executeCommand': { pluginId: string; commandId: string; args?: Record<string, unknown> }
'plugin.config.get': { pluginId: string; key: string }
'plugin.config.set': { pluginId: string; key: string; value: unknown }

// ClientMessage discriminated union 追加对应行
```

**Server → Client 新增：**

```typescript
// ServerMessageType 追加
| 'plugin:statusChange'
| 'plugin:permissionRequest'
| 'plugin:statusBarUpdate'
| 'plugin:messageDecoration'
| 'plugin:config'
```

**PluginInfo 扩展：**

```typescript
// 现有 PluginInfo 需要扩展以下字段
export interface PluginInfo {
  // ... 现有字段 ...
  description: string        // 新增
  source: 'built-in' | 'external'  // 新增
  permissions: string[]      // 新增：已批准的权限列表
  contributes: {             // 新增：manifest 中的 contributions
    slashCommands?: Array<{ name: string; description: string }>
    tools?: Array<{ name: string; description: string }>
    hooks?: Array<{ event: string }>
    statusBar?: Array<{ id: string; text: string; tooltip?: string; commandId?: string }>
    settings?: Array<{
      key: string
      type: 'string' | 'number' | 'boolean' | 'enum' | 'path'
      label: string
      description?: string
      default?: unknown
      enumValues?: Array<{ label: string; value: string }>
      requiresRestart?: boolean
    }>
  }
  errorMessage?: string      // 新增：crashed 时的错误信息
}
```

> **与 BG1 的协调：** 以上 protocol.ts 类型变更由 BG1 Task T3 实现。FG1 Task T8 开始时，这些类型应已存在。如果 BG1 未完成，前端 T8 可先在 `types/plugin.ts` 中定义临时类型，待 BG1 完成后切换到 shared 类型。
