---
verdict: pass
---

# Phase 1 前端设计: plan-frontend.md

## 总体结论

**Phase 1 无新增 UI 组件、无新增 Vue/Store/Composable 代码。** 前端变更仅限于共享协议文件 `src-electron/shared/src/protocol.ts` 中的类型定义新增。

**原因**：Phase 1 的目标是搭建 Sidecar 侧的插件系统骨架（Worker Thread 隔离 + JSON-RPC + 懒激活 + KV 持久化）。插件管理 UI（Plugin Store、Settings 面板、状态栏、消息装饰器）在 Phase 2-3 实现。Phase 1 只需要定义前后端的通信协议类型，确保 Sidecar 能发送和接收插件相关消息。

---

## 变更范围

### 单文件变更: `src-electron/shared/src/protocol.ts`

#### 1. ClientMessageType 新增 3 个类型

在 `ClientMessageType` union 末尾追加：

```typescript
// plugin 消息
| 'plugin.list' | 'plugin.toggle' | 'plugin.install'
```

#### 2. ClientMessageMap 新增 3 个映射

```typescript
'plugin.list': Record<string, never>
'plugin.toggle': { pluginId: string; enabled: boolean }
'plugin.install': { source: string }   // stub, Phase 2+ 实现
```

#### 3. ClientMessage discriminated union 新增 3 个成员

遵循现有模式（每个 type 一行 union member）：

```typescript
| { type: 'plugin.list'; id?: string; payload: Record<string, never> }
| { type: 'plugin.toggle'; id?: string; payload: ClientMessageMap['plugin.toggle'] }
| { type: 'plugin.install'; id?: string; payload: ClientMessageMap['plugin.install'] }
```

#### 4. ServerMessageType 新增 3 个类型

在 `ServerMessageType` union 末尾追加：

```typescript
| 'config.plugins' | 'plugin:crashed' | 'plugin:notification'
```

#### 5. 新增 Payload 接口

```typescript
/** 插件描述符（前后端共享的精简版，完整版在 runtime plugin-types.ts） */
export interface PluginDescriptor {
  pluginId: string
  version: string
  displayName: string
  description: string
  main: string
  activationEvents: string[]
  trustLevel: 'trusted' | 'sandbox'
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  enabled: boolean
  contributes?: {
    slashCommands?: Array<{ name: string; description: string }>
    tools?: Array<{ name: string; description: string }>
    hooks?: string[]
    panels?: Array<{ id: string; title: string }>
    statusBarItems?: Array<{ id: string; text: string; priority: number }>
  }
}

/** plugin:notification 消息 payload */
export interface PluginNotificationPayload {
  pluginId: string
  level: 'info' | 'warning' | 'error'
  message: string
}

/** plugin:crashed 消息 payload */
export interface PluginCrashedPayload {
  pluginId: string
  reason: string
  recoverable: boolean
}
```

#### 6. config.plugins 的 payload 结构

`ServerMessage { type: 'config.plugins' }` 的 payload：

```typescript
{
  plugins: PluginDescriptor[]
}
```

遵循现有模式，直接在 `ServerMessage.payload: Record<string, unknown>` 中传递，不需要额外约束 ServerMessage 的 payload 类型。

---

## 不在 Phase 1 范围内的前端工作

| 功能 | 计划阶段 | 说明 |
|------|---------|------|
| Plugin 管理 UI（Settings 页面） | Phase 2 | 插件列表、启用/禁用 toggle、安装/卸载 |
| Plugin Store | Phase 3 | 浏览、搜索、安装插件的 marketplace UI |
| 状态栏插件项 | Phase 2 | `contributes.statusBarItems` 的渲染 |
| 消息装饰器 | Phase 2 | 插件通知在聊天面板中的展示 |
| Slash 命令补全集成 | Phase 2 | `contributes.slashCommands` 注册到 SlashMenu |
| Plugin 面板扩展 | Phase 3 | `contributes.panels` 的 WebView 渲染 |
| 插件崩溃 Toast | Phase 2 | `plugin:crashed` 消息的前端 Toast 提示 |
| 插件通知 Toast | Phase 2 | `plugin:notification` 消息的前端提示 |
| Plugin Store | Phase 3 | 浏览、搜索、安装插件的 marketplace UI |

---

## 前端无工作的验证清单

- [x] 无新增 Vue 组件
- [x] 无新增 Pinia Store
- [x] 无新增 Composable
- [x] 无新增 CSS / Tailwind 样式
- [x] 无新增路由/视图
- [x] 无修改现有 UI 组件
- [x] 仅 `protocol.ts` 新增 TypeScript 类型定义
- [x] 类型变更不破坏现有前端代码（纯新增 union member + 新接口）

---

## 前端对接时机

Phase 2 开始时，前端需要：

1. **创建 `usePlugins` composable** — 监听 `config.plugins` / `plugin:crashed` / `plugin:notification` 消息
2. **创建 `pluginStore`** — 管理插件列表和状态（类似现有 extensionStore）
3. **Settings 页面新增 Plugins section** — 复用 `PluginDescriptor` 类型渲染插件列表
4. **Toast 通知** — 处理 `plugin:crashed` 和 `plugin:notification`

Phase 1 的 `protocol.ts` 类型定义已经为 Phase 2 做好了数据契约准备。
