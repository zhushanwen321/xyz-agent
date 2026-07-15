# A4. WS 生命周期闭环设计

> 对应 Wave W4 / MUST FIX #2, #4 + SHOULD FIX（连接中请求、不可恢复判定）。

## 0. 审查结论纠偏（重要）

综合报告基于审查阶段标记了 2 个 MUST FIX：
- #2 页面可见性切换无连接维护
- #3 重连后不重建全局状态

**代码事实收集推翻了 #3**。`connection-manager.ts:84` 每次 `onConnect` 都调 `broker.sendInitialState(ws)`；前端 `useSettings.ts:58-77` 的 7 个订阅（providers/models/skills/agents/skillDirs/agentDirs/defaults/extensions）是**常驻的**（`unsubs` 不卸载，AppShell 应用级调用一次）。重连后 runtime 自动推全量 initial state，订阅回调自然触发 store 写入。

**结论**：重连状态重建靠"被动推送 + 常驻订阅"模式，**已经工作**。唯一漏洞是 `config.extensions` 段是 async fire-and-forget（`broker.ts:247-258`），断连早于扫描完成则丢失、无补发——这是 SHOULD FIX 不是 MUST FIX。

**本文档实际处理的 MUST FIX 降为 1 个**：#2 页面可见性。#3 相关问题降级为 SHOULD FIX。

## 1. 背景与问题

| # | 问题 | 文件:行号 | 严重度 |
|---|------|-----------|--------|
| 2 | 页面可见性切换无连接维护，后台心跳被节流断连 | `useConnection.ts:159` | MUST FIX |
| — | 连接中（非 OPEN）发出的 RPC 静默丢弃，等满 65s 超时 | `transport.ts:33` / `ws-client.ts:162` | SHOULD FIX |
| — | 不可恢复错误（端口被占/URL 非法）无限重连，永不进 failed 态 | `ws-client.ts:174` | SHOULD FIX |
| — | config.extensions 异步段断连早于扫描完成则丢失 | `broker.ts:247` | SHOULD FIX |

## 2. 设计目标

| 目标 | 说明 |
|------|------|
| 可见性切换主动重连 | 窗口恢复可见时，若连接非 connected 立即探测/重连 |
| 连接中请求 fast-fail | 非 OPEN 态发 RPC 立即 reject，不等 65s |
| 不可恢复判定 | 重连次数/持续时间上限 → setFailed + 手动重试 |
| extensions 补发 | 重连后主动重拉 extensions（唯一非 server-push 同步的段） |

## 3. 核心决策

### 3.1 页面可见性切换（MUST FIX #2）

**决策：useConnection 监听 visibilitychange，可见时主动重连**

```typescript
// useConnection.ts init() 内
const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') {
    const state = getState()
    if (state !== 'connected') {
      // 窗口恢复可见但连接不在 → 主动重连（不等下一次退避 timer）
      const url = getCurrentUrl()
      if (url) connect(url)  // connect 幂等，已连接则 no-op
    }
  }
}
document.addEventListener('visibilitychange', handleVisibilityChange)

// teardown
document.removeEventListener('visibilitychange', handleVisibilityChange)
```

**为什么有效**：
- 切后台时 setInterval 被浏览器节流（Chrome 后台 tab ~1/min），心跳 15s 可能超期，runtime 侧 45s 心跳超时关闭连接
- 回前台时 `onclose` 可能已触发但 `reconnectTimer` 也被节流未执行 → 卡在 disconnected/reconnecting
- visibilitychange 事件**不受 setInterval 节流影响**（用户操作触发的优先级高），可立即补救

**不处理 hidden 态**：切后台时主动断连 + 切前台重连的模式更激进，但会丢失后台时的事件流推送。维持"后台保持连接（靠心跳），前台补救"的策略。

### 3.2 连接中请求 fast-fail（SHOULD FIX）

**决策：transport.send 在非 OPEN 态立即 reject 对应 pending**

两种方案对比：

| 方案 | 优点 | 缺点 |
|------|------|------|
| (a) fast-fail | 简单、用户立即知道失败、无队列复杂度 | 连接 1s 后恢复的请求也被拒 |
| (b) 短暂队列 | 短暂断连（重连快）的请求不丢失 | 队列深度管理、顺序保证、超时语义复杂 |

**选 (a) fast-fail**。理由：xyz-agent 是桌面应用，连接断开通常意味着 runtime 重启（秒级）或网络异常。用户在重连窗口期点按钮（切模型、设思考等级），快速失败 + toast 比静默等 65s 体验好得多。

```typescript
// transport.ts 改为返回 boolean 或抛错
export function send(msg: ClientMessage): boolean {
  return wsClient.send(msg)  // 返回是否成功发送
}

// ws-client.ts
export function send(msg: ClientMessage): boolean {
  if (isMock) { mockSend(msg); return true }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  }
  return false  // 非 OPEN → 调用方应 reject pending
}
```

**调用方适配**：`api/domains/*` 的 request 函数在 send 后检查返回值，false 时 `pending.reject(id, new Error('Not connected'))`。

**注意**：`reconnecting`/`restarting` 态也被 fast-fail——这些态下 `rejectAll` 已经批量 reject 了所有 pending（`useConnection.ts:159-163`），但新发出的请求仍会进 pending。fast-fail 覆盖这个窗口。

### 3.3 不可恢复判定（SHOULD FIX）

**决策：重连次数上限 + 持续时间上限，两者满足其一进 failed 态**

```typescript
// ws-client.ts scheduleReconnect() 内
const MAX_RECONNECT_ATTEMPTS = 20        // 累计 20 次重连
const MAX_RECONNECT_DURATION_MS = 60_000 // 或持续 60s 仍未连上

// 新增：记录首次重连时间
private reconnectStartedAt: number | null = null

if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS ||
    (this.reconnectStartedAt && Date.now() - this.reconnectStartedAt > MAX_RECONNECT_DURATION_MS)) {
  this.setFailed()
  return
}
```

**与 supervisor 的协调**：supervisor 的 `MAX_RESTARTS=5` + 退避总计 ~40s 会先于前端重连耗尽触发 `runtime-failed` IPC（`runtime-supervisor.ts:228`）。前端的 20 次/60s 上限是**supervisor 链路失效时的兜底**（如 runtime 未崩溃但网络不通、端口被其他进程占）。

**setFailed 后**：前端已有 failed 态 UI（App.vue 重试按钮），点击 → IPC `runtime-restart` → supervisor `clearForManualRestart` 清零计数 → 重启。

### 3.4 config.extensions 补发（SHOULD FIX）

**决策：前端重连后主动重拉 extensions**

```typescript
// useSidebar.ts onConnected() 重连分支（hasConnectedBefore=true）
// 现有：workspaceStore.load()
// 新增：extensions 是 async fire-and-forget，重连后主动补拉
extensionApi.scan().catch(() => {})  // fire-and-forget，失败不阻断
```

或者更优：runtime 侧 `sendInitialState` 的 extensions 段改为**同步等待扫描完成**（`broker.ts:247-258`）。但这会拖慢首次连接（extensions 扫描读文件系统）。权衡后选前端主动补拉（轻量、不影响首次连接速度）。

## 4. 改动范围

| 文件 | 改动 | 类型 |
|------|------|------|
| `useConnection.ts` | 新增 visibilitychange 监听 + 可见时主动 connect | 核心 |
| `ws-client.ts` | `send` 返回 boolean（是否成功发送） | 核心 |
| `transport.ts` | `send` 透传返回值 | 小改 |
| `api/domains/*` 的 request 函数 | send 后检查返回值，false 时 reject pending | 中改（多个文件） |
| `ws-client.ts` | scheduleReconnect 增加次数/持续时间上限 → setFailed | 核心 |
| `useSidebar.ts` | onConnected 重连分支补 extensionApi.scan() | 小改 |

## 5. 测试策略

| 场景 | 方法 |
|------|------|
| 可见性切换重连 | mock document.visibilityState 变 visible + getState 返回 disconnected，断言 connect 被调 |
| 可见但已连接不重连 | mock visibilityState visible + getState connected，断言 connect 未调 |
| fast-fail 非 OPEN 态 | mock ws.readyState = connecting，send 返回 false，断言 pending 被 reject |
| fast-fail OPEN 态正常 | mock readyState = OPEN，send 返回 true，pending 正常等待响应 |
| 重连次数上限 | mock 20 次 scheduleReconnect，断言第 20 次后 setFailed |
| 重连持续时间上限 | fake timers + mock 连续失败 60s，断言 setFailed |
| supervisor 先于前端 failed | 模拟 runtime-failed IPC 到达，断言前端 setFailed（不受前端重连计数影响） |

## 6. 待决策

| # | 决策点 | 推荐方案 | 备选 |
|---|--------|---------|------|
| 1 | 非 OPEN 态请求处理 | fast-fail（立即 reject） | 短暂队列 |
| 2 | 重连上限 | 20 次 / 60s | 10 次 / 30s（更激进） |
| 3 | extensions 补发 | 前端主动补拉 | runtime sendInitialState 同步等待 |
| 4 | 后台态策略 | 保持连接（靠心跳）+ 前台补救 | 后台主动断连 + 前台重连 |

## 7. 关于综合报告的 MUST FIX 数量修正

本设计文档完成后，W4 wave 的 MUST FIX 覆盖：

| 综合报告编号 | 原严重度 | 纠偏后 | 处理 |
|-------------|---------|--------|------|
| #2 可见性切换 | MUST FIX | 确认 | 本文档 3.1 |
| #3 重连后不重建状态 | MUST FIX | **降为无问题**（已由 server-push + 常驻订阅覆盖） | 不处理，extensions 补发降为 SHOULD FIX |
| #4 Extension UI respond 出队 | MUST FIX | 确认（但属前端杂项，非 WS 生命周期） | 归入 W1 防御补丁 |

**净效果**：W4 的 MUST FIX 从 2 个降为 1 个（可见性切换）。
