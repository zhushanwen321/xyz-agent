---
id: "2026-06-07-instance-isolation-audit"
title: "实例隔离审计：WS 连接、主题持久化、Event Bus 防重复问题"
---

# Audit Report

## 检查范围

1. IPC event handler 的 disconnect/reconnect 逻辑
2. WebSocket 连接/心跳管理
3. Pinia persist 与初始化时序
4. Event bus listener 防重复
5. 其他 WS 相关的 timing issues

---

## 发现的 6 个问题

### P0 — 直接影响用户症状

#### #1 — `onRuntimePort` handler 不检查端口是否已变化

**文件**: `src-electron/renderer/src/composables/useConnection.ts:57-61`

```typescript
removeRuntimePortListener = window.electronAPI.onRuntimePort((newPort) => {
    if (newPort && state.value !== 'disconnected') {
        disconnect()
        connect('ws://localhost:' + newPort)
    }
})
```

**问题**: handler 不比较 `newPort` 与当前已连接的端口。即使 frontend 已连在 3210 上、收到 `runtime-port: 3210`（相同端口），也会执行一次完整的 `disconnect()` + `connect()`。

**影响**: WS 断连风暴。每次 `runtime-port` 事件触发一次无意义的重连。在 prod 启动序列中，`init()` fallback 先连 3210（失败）→ `runtime-port: 3210` 到达 → handler 重连 → 成功 → 后续又断开（机制见 #4）→ 再重连。每次重连触发 Vue 响应式更新，打断 IME 合成 →「中文输入卡顿」。

**修复方向**: handler 记录当前端口，只在 `newPort !== currentPort` 时重连。

---

#### #2 — `connect()` 去重逻辑不检查 URL

**文件**: `src-electron/renderer/src/lib/ws-client.ts:37`

```typescript
export function connect(url: string): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  // ...
}
```

**问题**: 只检查"有没有已存在的 WS"，不检查该 WS 是否已连接（或正在连接）到**相同的 URL**。如果 frontend 已连 `ws://localhost:3210`、外部调 `connect('ws://localhost:3310')`，这个调用被静默忽略。

**影响**: 如果 `onRuntimePort` fix (P0#1) 加上后，handler 改为只在端口变化时重连，那 `connect()` 的去重必须也感知 URL，否则 `connect(newPort)` 可能因现有 WS 被跳过。

---

#### #3 — 主题持久化时序竞争

**文件**:
- `src-electron/renderer/src/stores/settings.ts` (Pinia persist)
- `src-electron/renderer/src/design-system/theme/ThemeProvider.vue`

**问题**: 主题存储在**两个独立位置**：

| 位置 | 写入者 | 读取者 |
|------|--------|--------|
| `localStorage['xyz-agent-theme']` | `ThemeProvider.onMounted()` + `settingsStore.applyTheme()` | `ThemeProvider.onMounted()` |
| `localStorage['xyz-settings']` → `theme` | `pinia-plugin-persistedstate` | `useSettingsStore()` |

**时序竞争**:

```
1. ThemeProvider.onMounted() fires
   → localStorage.getItem('xyz-agent-theme') → null（首次或刚被覆盖）
   → applyTheme(prefersDark ? 'dark' : 'light')
   → 写入 localStorage['xyz-agent-theme'] = 'light'

2. useSettingsStore() 首次调用
   → Pinia persist 从 localStorage['xyz-settings'] 恢复 { theme: 'dark' }
   → store.theme = 'dark'
   → 但 localStorage['xyz-agent-theme'] 已经是 'light'

3. 下次启动
   → ThemeProvider 读到的又是 'light'
   → 覆盖 persist 的 'dark'
```

**影响**: 主题从 'dark' 变为 'light'，且 persist 的 'dark' 永无机会同步到 DOM。

**修复方向**: `settingsStore.applyTheme()` 应在 store setup 末尾被调用一次，使 DOM 和 localStorage 与 persist 恢复后的值同步。或在 `ThemeProvider.onMounted()` 中优先使用 store 的值。

---

#### #4 — App.vue 有两个重复的 WS state watcher

**文件**: `src-electron/renderer/src/App.vue`
- L117: `watch(wsState, ...)` — 创建 "连接已断开" toast
- L300: `watch(wsWatchState, ...)` — 创建 "连接断开" toast

**问题**: 两个 watcher 监听同一个 WS state，各自有独立的 timer 逻辑。WS 断开时两个 watcher 都会触发 → **两条重复的 toast 通知**。这是重构时遗留的清理问题。

**影响**: WS 断连时用户看到两条 toast（"连接已断开" + "连接断开"）。WS 恢复时两个 watcher 分别清理各自的 timer。

**修复方向**: 删除 L117-L134 的旧 watcher，保留 L300-L327 的新实现。

---

### P2 — 理论风险，实际可能不触发

#### #5 — `scheduleReconnect` timer 与 `disconnect()` 的竞态

**文件**: `src-electron/renderer/src/lib/ws-client.ts:78-83`

```typescript
function scheduleReconnect(url: string): void {
  const delay = ...
  reconnectTimer = setTimeout(() => connect(url), delay)
}
```

和 `disconnect()`:

```typescript
if (reconnectTimer) clearTimeout(reconnectTimer)
```

**问题**: 如果 `setTimeout` 刚触发（回调已入微任务队列）但尚未执行，`disconnect()` 的 `clearTimeout` 无效。残留的 `connect(url)` 回调会创建一条新的 WS 连接。

**缓解**: `connect()` 内部的 `wsGeneration` 检查 + `ws && (OPEN or CONNECTING)` 的早期返回能拦截大多数情况。但若 timing 恰好让垃圾 `connect()` 在 handler 的 `connect()` 之前执行，会导致 handler 的 `connect()` 被跳过（见 #2）。

---

#### #6 — `connect()` 不保存当前 URL

**文件**: `src-electron/renderer/src/lib/ws-client.ts:26`

```typescript
export function connect(url: string): void {
  hmrUrl = url  // 仅用于 HMR
  // ...
}
```

**问题**: `hmrUrl` 用于 HMR 后的重连，但模块没有保存"当前已连接的 URL"。这导致：
- 无法判断 `connect()` 是否连接到相同的 URL（#2 的去重问题）
- 无法在 `runtime-port` handler 中判断端口是否变化（#1）
- 断连后重建 toast 时无法显示具体端口

---

## 完整修复方案

### 1. `ws-client.ts` — 添加 URL 跟踪

```typescript
let currentUrl: string | null = null

export function connect(url: string): void {
  // 如果已有 WS 且 URL 相同 → 跳过
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) && currentUrl === url) {
    return
  }
  currentUrl = url
  // ...
}

export function disconnect(): void {
  currentUrl = null
  // ...
}
```

### 2. `useConnection.ts` — `onRuntimePort` handler 只在端口变化时重连

```typescript
let previousPort: number | null = null

removeRuntimePortListener = window.electronAPI.onRuntimePort((newPort) => {
  if (newPort && newPort !== previousPort) {
    previousPort = newPort
    disconnect()
    connect('ws://localhost:' + newPort)
  }
  // 如果端口没变 → 不做任何事
})
```

### 3. `settings.ts` — store setup 末尾同步 DOM

```typescript
// 在所有 ref 定义和函数定义之后，在 return 之前：
// 同步 DOM 和 localStorage 与持久化的配置
applyTheme()
```

### 4. `App.vue` — 删除重复的 WS state watcher

删除 L117-L134 的第一个 `watch(wsState, ...)` block（含 `wsDisconnectTimer` 变量和 `wsStateUnwatch`），保留 L300-L327 的第二个实现。

---

## 测试验证清单

- [ ] prod 先开 + dev 后开 → prod 不主动断连
- [ ] dev 先开 + prod 后开 → dev 不主动断连
- [ ] WS 连接成功后，`runtime-port` 事件不触发断开重连
- [ ] 主题设为 dark → 重启 → 保持 dark
- [ ] 主题设为 dark → 重启多次 → 始终 dark
- [ ] WS 断连 → 仅出现一条 toast（非两条）
- [ ] 中文输入不卡顿
