# A6. supervisor 健康检查升级设计

> 对应 Wave W5 / MUST FIX #19, #20 + SHOULD FIX #4, #5。

## 1. 背景与问题

三个独立但相关的问题：

| # | 问题 | 文件:行号 | 严重度 |
|---|------|-----------|--------|
| 19 | 半活进程导致 start() 幂等短路返回死端口 | `runtime-supervisor.ts:248` | MUST FIX |
| 20 | spawn 的 error 事件只 console，不入状态机 | `process-control.ts:137` | MUST FIX |
| 4 | 健康检查是纯 TCP 握手，无法检测"端口活但服务死" | `health-checker.ts:34` | SHOULD FIX |
| 5 | 运行期无持续健康监控（只有启动就绪探针） | `runtime-supervisor.ts:102` | SHOULD FIX |

**代码事实纠偏**（A6 收集发现，修正综合报告的 MUST FIX #19 分析）：

综合报告认为"卡死 child 的 exitCode 仍 null → 幂等守卫误判存活 → 返回死端口"。**但代码事实表明**：`waitForHealth` 抛错时 `this._port` 仍是 null（第 104 行未执行），幂等守卫的 `this._port !== null` 条件不满足 → 不会返回死端口，而是会走 `await this.stop()` 清理。

**真正的问题**：`waitForHealth` 失败抛错后，半活 child 进程**不被主动清理**（`this.child` 已赋值但 stop 不被调）。如果 child 进程一直挂着（spawn 成功但 runtime init 卡住），后续 `start()` 调用会先 `await this.stop()`——`stop` 内部应能清理它。**但这依赖 stop 的正确性**，且 spawn 的 error 事件不入状态机（#20），某些时序下 child 异常但不触发 exit，stop 也可能遗漏。

## 2. 设计目标

| 目标 | 说明 |
|------|------|
| 半活进程清理 | start 失败时主动清理半活 child，不依赖隐式 stop |
| spawn error 入状态机 | error 事件触发与 exit 相同的清理 + 重启路径 |
| 就绪探针升级 | TCP 握手 → HTTP /health，覆盖"端口活但服务死" |
| 存活探针（新） | 运行期周期性检查，覆盖"运行中卡死但不退出" |

## 3. 核心决策

### 3.1 半活进程清理（MUST FIX #19）

**决策：start() 的 waitForHealth 包 try/catch，失败时主动 stop**

```typescript
// runtime-supervisor.ts start() 内
this.child = spawnRuntimeProcess(port, (code) => this.onRuntimeExit(code))
try {
  await waitForHealth(port)
} catch (e) {
  // waitForHealth 失败：清理半活 child，避免残留
  await this.stop()
  throw e
}
writePortFile(port)
this._port = port
this.policy.recordSuccess()
```

注意：`this.stop()` 会 markStopping（`restart-policy.reset` 在 start 开头已清 stopping，但 stop 会重新设）。需确认 stop 后 supervisor 状态正确——`attemptRestart` 的 catch 分支会重新调 `start`，start 开头的 `this.policy.reset()` 清 stopping，所以链路自洽。

### 3.2 spawn error 入状态机（MUST FIX #20）

**决策：child.on('error') 调用与 exit 相同的清理路径**

```typescript
// process-control.ts spawnRuntimeProcess 内
child.on('error', (err) => {
  console.error(`[runtime] Spawn error: ${err.message}`)
  // error 事件可能不伴随 exit，需主动通知 supervisor 走清理
  onExit?.(-1)  // 哨兵退出码 -1 表示 spawn error
})
```

**风险**：error 和 exit 都触发时 onExit 被调两次。`onRuntimeExit`（`runtime-supervisor.ts:184`）需幂等——检查 `this.child` 是否已 null。代码事实确认 onRuntimeExit 先做 `this.child = null`，第二次调用时 `if (!this.child)` return，已幂等。

### 3.3 就绪探针升级：TCP → HTTP /health（SHOULD FIX #4）

**决策：waitForHealth 改为 HTTP GET /health**

runtime 已暴露 `/health` 端点（`connection-manager.ts:47-55`），返回 `{status:'ok', uptime}`。

```typescript
// health-checker.ts
async function checkHealthEndpoint(port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < HEALTH_RETRY_COUNT; i++) {
    if (await checkHealthEndpoint(port)) return
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS))
  }
  throw new Error(`Runtime health check timed out on port ${port}`)
}
```

**保留 isPortInUse**（TCP 握手）：`port-discoverer.ts:29` 的 `findAvailablePort` 仍用它做端口探测（只需要知道端口是否被占，不需要 HTTP 服务就绪）。两个函数职责分离。

**局限**：当前 `/health` 只返回 HTTP server 已 listen，不含"服务就绪"（session/plugin 初始化完成）语义。这是因为 `server.start()`（listen）在 `index.ts:278` 早于 `ensurePublicSession`/`pluginService.initialize`。升级 /health 语义是更大改动，**本轮不做**——TCP→HTTP 的升级已能覆盖"runtime 进程活着但 WS server 没起来"的场景，比纯 TCP 强。

### 3.4 存活探针（新机制，SHOULD FIX #5）

**决策：supervisor 新增周期性 /health 轮询 + 连续失败触发重启**

```typescript
// runtime-supervisor.ts 新增
private livenessTimer: ReturnType<typeof setInterval> | null = null
private livenessFailures = 0

private startLivenessProbe(): void {
  const LIVENESS_INTERVAL_MS = 30_000      // 每 30s 检查
  const LIVENESS_FAIL_THRESHOLD = 3        // 连续 3 次失败（~90s）才重启

  this.livenessTimer = setInterval(async () => {
    if (!this._port) return
    const alive = await checkHealthEndpoint(this._port)
    if (alive) {
      this.livenessFailures = 0
    } else {
      this.livenessFailures++
      console.warn(`[runtime] liveness check failed (${this.livenessFailures}/${LIVENESS_FAIL_THRESHOLD})`)
      if (this.livenessFailures >= LIVENESS_FAIL_THRESHOLD) {
        console.error('[runtime] liveness threshold exceeded, forcing restart')
        this.livenessFailures = 0
        await this.forceRestartForLiveness()
      }
    }
  }, LIVENESS_INTERVAL_MS)
  this.livenessTimer.unref()  // 不阻止进程退出
}
```

`forceRestartForLiveness`：调 `this.stop()`（杀 runtime 子进程）→ 触发 `onRuntimeExit` → 走正常崩溃重启路径（restart-policy 编排退避 + 广播 restarting）。

**启动/停止时机**：
- `start()` 成功后启动存活探针
- `stop()` / `destroyAll()` 时 `clearInterval(this.livenessTimer)`

**与 pi watchdog（A2）的协同**：
- pi watchdog（300s）：检测**单个 session 的 pi 子进程**卡死，自动 abort 该 session
- supervisor 存活探针（90s）：检测 **runtime 主进程**卡死，重启整个 runtime
- 两层独立，覆盖不同卡死层级。runtime 主进程卡死时 pi watchdog 也在 runtime 内无法执行，supervisor 探针是外层兜底。

### 3.5 存活探针 vs 心跳超时（边界澄清）

已有机制：
- runtime WS 心跳超时（`connection-manager.ts:109`，45s）：检测**单条 WS 连接**无消息，关闭该连接
- 前端 WS 心跳（`ws-client.ts:186`，15s ping）：保活

**区别**：WS 心跳是连接级，runtime 可以"WS 连接活着（回应 ping）但内部服务卡死"。存活探针是进程级，直接 HTTP 请求 runtime 的 /health 端点。两者不重叠。

## 4. 改动范围

| 文件 | 改动 | 类型 |
|------|------|------|
| `health-checker.ts` | 新增 `checkHealthEndpoint`（HTTP fetch /health）；`waitForHealth` 改用它；保留 `isPortInUse` | 核心 |
| `runtime-supervisor.ts` | `start()` 的 waitForHealth 包 try/catch + stop | 核心 |
| `runtime-supervisor.ts` | 新增存活探针（livenessTimer + startLivenessProbe） | 核心 |
| `runtime-supervisor.ts` | `stop()`/`destroyAll()` 清 livenessTimer | 核心 |
| `process-control.ts` | `child.on('error')` 调 `onExit(-1)` | 小改 |
| `runtime-supervisor.ts` | `onRuntimeExit` 确认幂等（已幂等，加注释说明） | 小改 |

## 5. 测试策略

| 场景 | 方法 |
|------|------|
| waitForHealth 失败清理半活进程 | mock spawn 成功 + waitForHealth reject，断言 stop 被调 + child 被清理 |
| spawn error 入状态机 | mock child emit error，断言 onExit(-1) 被调 + 重启编排触发 |
| HTTP /health 就绪探针 | mock HTTP server 返回 200 → 通过；返回 5xx/连接拒绝 → 失败 |
| 存活探针连续失败重启 | fake timers + mock checkHealthEndpoint 连续返回 false，advanceTimersByTime(90000)，断言 forceRestart 调用 |
| 存活探针恢复清零 | mock 连续 2 次失败后 1 次成功，断言 livenessFailures 归零不重启 |
| 存活探针不阻止退出 | 断言 livenessTimer.unref() 被调 |
| isPortInUse 不受影响 | port-discoverer 仍用 isPortInUse（TCP），断言行为不变 |

## 6. 待决策

| # | 决策点 | 推荐方案 | 备选 |
|---|--------|---------|------|
| 1 | 存活探针频率 | 30s | 60s（更保守）/ 动态 |
| 2 | 连续失败阈值 | 3 次（~90s） | 2 次（~60s，更快恢复）/ 5 次（更保守） |
| 3 | 探针失败后动作 | 直接重启（走 restart-policy 编排） | 先通知前端让用户决定 |
| 4 | /health 端点是否扩展就绪语义 | 本轮不做（保持 status:ok） | 加 session/plugin 初始化状态字段 |

## 7. 实现顺序建议

1. 先做 MUST FIX #19（半活清理）+ #20（spawn error 入状态机）—— 局部修复，低风险
2. 再做 SHOULD FIX #4（TCP→HTTP）—— 改 waitForHealth 实现
3. 最后做 SHOULD FIX #5（存活探针）—— 新机制，可在 1/2 稳定后加
