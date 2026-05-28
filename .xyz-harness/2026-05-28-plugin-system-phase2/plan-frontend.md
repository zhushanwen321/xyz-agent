---
verdict: pass
---

# Plugin System Phase 2 — 前端设计

> 对应 spec FR-4.3（权限审批）和 plan FG1 Execution Group。
> 约束：前端最小改动，不新增通用组件，不破坏 Phase 1 已有接口。

---

## §1 PluginPermissionDialog

### 1.1 职责

安装外部插件时，后端 PermissionChecker 通过 WS 推送权限审批请求，前端以模态对话框展示插件声明的权限列表，用户逐项或批量审批后回写 `permissions.json`（FR-4.3）。

### 1.2 组件签名

**文件**: `renderer/src/components/plugin/PluginPermissionDialog.vue`

```vue
<!--
Props: 无（由 composable 控制 visibility）
Emits: 无（通过 ws-client 响应后端）
-->
```

**不接收 props**。visibility 和数据完全由 `usePluginPermission` composable 管理，保持与现有 `ExtensionUIDialog`（读取 `useExtensionUI` 的 `activeRequest`）一致的模式。

### 1.3 Composable：`usePluginPermission`

**文件**: `renderer/src/composables/usePluginPermission.ts`

模块级单例模式，与 `useExtensionUI.ts` 一致：

```ts
// ── 状态（模块级） ──
const activeRequest = ref<PluginPermissionRequestPayload | null>(null)
let listenersRegistered = false

// ── 注册事件监听 ──
function registerListeners() {
  if (listenersRegistered) return
  listenersRegistered = true
  on('plugin.permission_request', onPermissionRequest)
}

registerListeners()

// ── 导出 ──
export function usePluginPermission() {
  // activeRequest: 当前权限请求（含 pluginId, displayName, permissions[]）
  // grantAll():      通过所有权限 → send plugin.permission_response
  // denyAll():       拒绝所有权限 → send plugin.permission_response
  // grantPartial():  通过选中的权限 → send plugin.permission_response
  // dismiss():       关闭对话框（不发送响应，后端超时处理）
  return { activeRequest, grantAll, denyAll, grantPartial, dismiss }
}
```

### 1.4 WS 消息流

```
安装外部插件
    │
    ▼
PermissionChecker.check() 发现无缓存权限
    │
    ▼
PluginService → sidecar server.ts → WS 推送
  type: 'plugin.permission_request'
  payload: {
    pluginId: string
    displayName: string
    permissions: string[]
  }
    │
    ▼
前端 usePluginPermission composable 接收事件
    │
    ▼
PluginPermissionDialog 弹窗展示权限列表
    │
    ▼
用户操作：
  ├─ 全部批准 → send({ type: 'plugin.permission_response', payload: { pluginId, approved: true, permissions: [...] } })
  ├─ 全部拒绝 → send({ type: 'plugin.permission_response', payload: { pluginId, approved: false, permissions: [] } })
  └─ 部分批准 → send({ type: 'plugin.permission_response', payload: { pluginId, approved: true, permissions: selectedSubset } })
    │
    ▼
sidecar → PermissionChecker.grant() → permissions.json 持久化
```

### 1.5 UI 布局

基于 xyz-ui 的 `Dialog` 组件：

| 区域 | 组件 | 说明 |
|------|------|------|
| 标题栏 | `Dialog` title | "插件权限请求：{displayName}" |
| 提示文字 | `<p>`（design token 文案） | "{displayName} 请求以下权限：" |
| 权限列表 | 逐行 `Toggle` + 权限名称 | 每条权限一行，默认全勾选。`Toggle` 开关逐项控制 |
| 底部按钮 | `Button` primary + `Button` outline | "全部批准"和"拒绝"两按钮。无"部分批准"按钮——用户通过 Toggle 勾选后点"全部批准"即按勾选状态提交 |

**权限项渲染规则**：
- 每条权限展示为一行：`Toggle` (可切换) + 权限 string 文本
- 权限字符串直接展示（如 `"tool:webSearch"`），不做翻译/二次渲染

**边界状态**：
- 所有 Toggle 关闭时点击"全部批准"→ 提交 `permissions: []`（等价于拒绝）
- 对话框通过 `dismiss()` 关闭但不提交时 → 后端设 30s 超时，超时视为拒绝

### 1.6 xyz-ui 组件选型

| 用途 | 组件 | 说明 |
|------|------|------|
| 对话框容器 | `Dialog` | 复用现有模态对话框 |
| 权限开关 | `Toggle` | 逐项控制，默认 `checked` |
| 操作按钮 | `Button` variant=`primary` | "全部批准" |
| 操作按钮 | `Button` variant=`outline` | "拒绝" |
| 关闭机制 | `Dialog` `@update:open` | 关闭时不提交，后端超时兜底 |

### 1.7 共享类型扩展

`shared/src/protocol.ts` 新增：

```ts
// ServerMessageType 新增
'plugin.permission_request'

// ClientMessageType 新增
'plugin.permission_response'

// Payload 类型
export interface PluginPermissionRequestPayload {
  pluginId: string
  displayName: string
  permissions: string[]
}

// ClientMessageMap 新增
'plugin.permission_response': {
  pluginId: string
  approved: boolean
  permissions: string[]  // 用户批准的权限子集
}
```

---

## §2 AppStatusBar Plugin Slot

### 2.1 职责

插件通过 `api.ui.updateStatusBarItem()`（FR-2.9）注册状态栏项。前端监听 `plugin:status_bar_update` WS 事件，在 AppStatusBar 中集中渲染所有插件的状态栏项。

### 2.2 组件改动

**文件**: `renderer/src/components/layout/AppStatusBar.vue`

在现有 `<footer>` 内增加一个 slot 区域，渲染插件状态栏项列表：

```vue
<template>
  <footer class="flex items-center justify-between h-statusbar px-4 bg-surface border-t border-border text-[11px] text-muted shrink-0">
    <div class="inline-flex items-center gap-2 min-w-0">
      <!-- 现有：连接状态 -->
      <span class="inline-flex items-center gap-1">...</span>

      <!-- 新增：插件状态栏项区域 -->
      <template v-for="item in pluginStatusItems" :key="item.id">
        <span v-if="item.separator" class="w-px h-3 bg-border"></span>
        <span
          class="inline-flex items-center gap-1 cursor-default"
          :style="{ color: item.color ?? 'var(--muted)' }"
          :title="item.tooltip"
          @click="item.command && executePluginCommand(item)"
        >
          <component :is="itemIcon(item)" v-if="item.icon" :size="10" />
          {{ item.text }}
        </span>
      </template>
    </div>
    <!-- 现有：右侧信息 -->
    <div class="inline-flex items-center gap-2 min-w-0">...</div>
  </footer>
</template>
```

### 2.3 Composable：`usePluginStatusBar`

**文件**: `renderer/src/composables/usePluginStatusBar.ts`

模块级单例，管理状态栏项列表：

```ts
// ── 状态（模块级） ──
const pluginStatusItems = ref<PluginStatusBarItem[]>([])

// ── 类型定义 ──
interface PluginStatusBarItem {
  id: string        // pluginId + itemKey 组合，保证唯一
  pluginId: string
  text: string
  icon?: string     // lucide icon name
  color?: string    // 颜色 CSS 值
  tooltip?: string
  command?: string  // 点击时触发的 command
  separator?: boolean  // true 时渲染为分隔线
  priority?: number // 排序权重（大在前）
}
```

**数据流**：

```
插件内调用 api.ui.updateStatusBarItem({ text, icon, ... })
    │
    ▼ 通过 Worker → PluginRPC → sidecar → server.ts
WS 推送 type: 'plugin:status_bar_update'
payload: {
  pluginId: string
  items: Array<{ text, icon?, color?, tooltip?, command?, separator?, priority? }>
}
    │
    ▼
前端 usePluginStatusBar composable 接收
  → 替换该 pluginId 对应的所有状态栏项
  → 按 priority 排序
```

### 2.4 注册防护

`onMounted` 中注册事件监听（refCount 保护），避免 split mode 下重复注册：

```ts
let refCount = 0

onMounted(() => {
  if (refCount === 0) on('plugin:status_bar_update', onStatusBarUpdate)
  refCount++
})
onUnmounted(() => {
  refCount--
  if (refCount === 0) off('plugin:status_bar_update', onStatusBarUpdate)
})
```

---

## §3 WS 消息协议

### 3.1 新增消息总览

| 方向 | type | Payload | 用途 | 对应功能 |
|------|------|---------|------|----------|
| Server → Client | `plugin.permission_request` | `{ pluginId, displayName, permissions[] }` | 推送权限审批 | §1 |
| Client → Server | `plugin.permission_response` | `{ pluginId, approved, permissions[] }` | 返回用户审批结果 | §1 |
| Server → Client | `plugin:status_bar_update` | `{ pluginId, items[] }` | 更新插件状态栏项 | §2 |
| Server → Client | `plugin:crashed` | 已有（`PluginCrashedPayload`） | 插件崩溃通知 | 复用 |

### 3.2 ServerMessageType 更新（protocol.ts）

新增 `'plugin.permission_request'`

### 3.3 ClientMessageType 更新（protocol.ts）

新增 `'plugin.permission_response'`

### 3.4 ClientMessageMap 更新

```ts
'plugin.permission_response': {
  pluginId: string
  approved: boolean
  permissions: string[]
}
```

### 3.5 ServerMessage payload 接口

```ts
// protocol.ts 新增

export interface PluginPermissionRequestPayload {
  pluginId: string
  displayName: string
  permissions: string[]
}

export interface PluginStatusBarUpdatePayload {
  pluginId: string
  items: Array<{
    id: string
    text: string
    icon?: string
    color?: string
    tooltip?: string
    command?: string
    separator?: boolean
    priority?: number
  }>
}
```

---

## 附录：材料清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `renderer/src/components/plugin/PluginPermissionDialog.vue` | create | 权限审批对话框 |
| `renderer/src/composables/usePluginPermission.ts` | create | 权限请求 composable |
| `renderer/src/composables/usePluginStatusBar.ts` | create | 状态栏插件项 composable |
| `renderer/src/components/layout/AppStatusBar.vue` | modify | 新增 plugin status items 渲染 |
| `shared/src/protocol.ts` | modify | 新增消息类型和 payload 接口 |
| `renderer/tests/PluginPermissionDialog.test.ts` | create | 权限对话框测试 |
