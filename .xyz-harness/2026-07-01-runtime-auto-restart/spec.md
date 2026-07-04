# Runtime 子进程崩溃自动恢复（长期方案）

> 状态：设计稿 | 日期：2026-07-01
> 触发：runtime 子进程崩溃后应用静默假死（supervisor 只清状态不重启）

## 1. 问题与目标

### 1.1 现状缺陷

runtime 子进程崩溃后的完整失效链路：

```
runtime 崩溃
  → process-control spawnRuntimeProcess 的 onExit 回调触发
  → runtime-supervisor.ts:88-89 仅 this.child=null / this._port=null（不重启、不推 IPC）
  → 主进程不重新 spawn，不推 'runtime-port'
  → 前端 useConnection onRuntimePort 永远收不到新端口
  → 前端 ws-client 在死端口上无限重连（指数退避到 30s）
  → 应用假死：窗口在，所有 runtime 操作全连不上
```

根因：`start()`（runtime-supervisor.ts:73）只在应用启动 whenReady 调一次。onExit 回调的 `[HISTORICAL]` 注释明确写"恢复旧 runtime-manager 语义"——而旧语义本身只清状态不重启。

### 1.2 目标

| # | 目标 | 可衡量成功标准 |
|---|------|--------------|
| G1 | runtime 崩溃后自动重启 | kill runtime 子进程 → 10s 内应用恢复可用（文件树/会话可操作） |
| G2 | 重启有上限，避免风暴 | 持续性故障下最多重启 N 次，之后停止并给用户明确反馈 |
| G3 | 用户可见恢复过程 | 崩溃后前端展示「runtime 重启中」状态条，恢复后消失 |
| G4 | 多窗口一致 | 任一窗口存活即感知重启，所有窗口同步收到新端口 |
| G5 | 主动退出不触发重启 | app 退出（before-quit）/ 用户主动 stop 不被自动重启打断 |

### 1.3 不做（YAGNI）

- 不做重启策略运行时可配置（先硬编码合理默认，未来需要再说）
- 不做崩溃原因持久化/上报（崩溃日志走 stderr 转发已足够，不做专门的崩溃报告系统）
- 不做 runtime 自身的心跳看门狗（runtime 已经是 WS server，崩溃会直接 exit；心跳看门狗是另一个独立问题，本次不引入）

---

## 2. 关键设计决策（方案对比）

### 2.1 重启触发点：主进程自动重启 vs 前端请求重启

**决策：主进程自动重启。**

| 维度 | 主进程自动重启（选） | 前端检测后请求重启 |
|------|---------------------|-------------------|
| 发现延迟 | 即时（onExit 回调同步触发） | 慢（前端心跳 15s 才发现断连） |
| 耦合 | 重启逻辑在 supervisor 单点 | 重启逻辑分散在主进程+前端 |
| 故障窗口 | 短（仅重启耗时） | 长（15s 心跳 + 重启耗时） |
| 单一职责 | supervisor 拥有进程完整生命周期（含恢复） | supervisor 退化成被动响应器 |

理由：supervisor 的职责是「runtime 进程完整生命周期管理」，崩溃恢复是生命周期的固有部分，不该外包给前端。前端只负责「连不上就重连 + 展示状态」。

### 2.2 重启策略：有限次数 + 指数退避

**决策：最多 5 次，指数退避（1s/2s/4s/8s/16s），超限停止。**

| 维度 | 有限次数（选） | 无限重试 |
|------|--------------|---------|
| 持续性故障（配置错/资源缺失） | 重试 5 次后停止，刷日志有上限 | 无限刷日志，磁盘/日志膨胀 |
| 用户反馈 | 停止后展示错误 + 手动重试按钮 | 永远「重启中」，用户不知道是死循环 |
| 瞬时故障（OOM/panic） | 5 次足够覆盖 | 同样能恢复，但无上限是隐患 |

5 次的依据：瞬时故障通常 1-2 次恢复；连续 5 次失败基本可判定为持续性故障。总耗时 1+2+4+8+16=31s 上限，加上每次重启本身 ~2s，约 40s 内给出结论。

退避上限 16s（< ws-client 的 MAX_RECONNECT_DELAY_MS 30s）：确保 supervisor 重启节奏快于前端重连退避，避免前端在 supervisor 已放弃后还在空转重连。

### 2.3 重启上限后的行为：展示错误 + 手动重试

**决策：主进程推 `runtime-error`，前端展示不可用状态 + 重试按钮。**

- supervisor 重启用尽后，通过新 IPC 通道推 `runtime-failed`（携带已重试次数/最后错误）
- 前端收到后进入 `failed` 连接态，渲染全局错误状态条 + 「重试」按钮
- 用户点「重试」→ 前端调 `runtime-restart` IPC → 主进程 supervisor 手动触发一次 `start()` 并广播端口

为什么新增 `runtime-failed` 而非复用 `runtime-error`：`runtime-error` 现语义是「启动失败」（whenReady 时一次性），`runtime-failed` 是「崩溃后重启用尽」（运行时），语义不同混用会让前端状态机混乱。

### 2.4 通知机制：广播所有窗口 vs 单窗口

**决策：广播所有窗口。**

现状 `startAndNotify(win)` 只通知传入的单个 win。但 runtime 是全局共享单例，崩溃重启后所有窗口都要重连。方案：

- supervisor 内部持有窗口引用的获取方式：不存窗口引用（避免持有已销毁窗口的悬垂引用），重启时直接 `BrowserWindow.getAllWindows()` 广播
- 复用 `bridge-handlers.ts:66 broadcastWindowList()` 的广播模式（遍历 + `!isDestroyed()` 守卫）

### 2.5 区分「主动退出」与「崩溃」

**决策：用 `stop()` 设置抑制标志。**

崩溃重启的最大风险是误触发——app 正常退出时 `before-quit` 调 `stop()`，此时子进程退出不应触发重启。

- `stop()` 内置 `this.stopping = true` 标志
- onExit 回调检查 `if (this.stopping) return` —— 主动停止不重启
- `start()` 开头重置 `this.stopping = false`

---

## 3. 架构与不变量

### 3.1 改动范围（文件级）

| 文件 | 改动 | 性质 |
|------|------|------|
| `main/supervisor/runtime-supervisor.ts` | onExit 回调加重启逻辑；`start()` 重置 stopping；新增重启策略状态 | **核心** |
| `main/interfaces.ts` | IRuntimeSupervisor 新增 `startAndBroadcast()`（广播版）；保留 `startAndNotify` 单窗口版兼容 | 契约扩展 |
| `main/main.ts` | whenReady 改调 `startAndBroadcast()`；before-quit 依赖现有 stop() 的 stopping 标志 | 接线 |
| `preload/preload.ts` + `preload/index.d.ts` | 新增 `onRuntimeFailed` / `restartRuntime` IPC 暴露 | 契约扩展 |
| `renderer/src/lib/ipc.ts` | 新增 `onRuntimeFailed` / `restartRuntime` 封装 | 薄包装 |
| `renderer/src/lib/ws-client.ts` | 新增 `'restarting'` 连接态 | 状态机扩展 |
| `renderer/src/composables/useConnection.ts` | 监听 `runtime-failed` 进 failed 态；监听 `runtime-restarting` 进 restarting 态；重试按钮调 restartRuntime | 编排 |
| `renderer/src/components/`（全局状态条组件） | 新增 RuntimeStatusBar.vue（restarting/failed 两态） | 新增 UI |

### 3.2 supervisor 状态机扩展

现有 supervisor 状态隐式（child/port 二态）。扩展为显式生命周期：

```
stopped ──start()──▶ running ──crash──▶ restarting ──成功──▶ running
                                  │                        ──超限──▶ failed
                                  └──stop()──▶ stopped
failed ──restartRuntime()──▶ restarting（手动触发，单独计数）
```

关键不变量（违反必出 bug）：

1. **`stopping` 标志优先于一切**：onExit 回调第一行检查 `if (this.stopping) return`。主动 stop() 触发的退出绝不重启。
2. **重启计数 per-crash-cluster**：连续崩溃累计计数；一旦重启成功并稳定运行 >10s，计数清零（区分「瞬时故障簇」与「持续性故障」）。
3. **重启在途幂等**：重启定时器已存在时，新的 onExit 不叠加（同一次崩溃可能触发多次 exit 事件）。
4. **端口必须重新探测**：崩溃后旧端口可能处于 TIME_WAIT，重启用 `findAvailablePort()` 重新选，不复用旧端口。
5. **广播前校验窗口存活**：`BrowserWindow.getAllWindows()` 遍历时 `!isDestroyed()` 守卫（复用 broadcastWindowList 模式）。

### 3.3 前端连接状态机扩展

ws-client 现有 4 态：`disconnected → connecting → connected → reconnecting`。

新增 2 态：

```
disconnected / connecting / connected / reconnecting（现有）
+ restarting（新增：runtime 崩溃，主进程在拉起新实例）
+ failed（新增：runtime 重启用尽，需用户手动重试）
```

状态转移来源：

- `reconnecting`：ws-client 自身 onclose 触发（网络抖动/runtime 短暂无响应）
- `restarting`：收到主进程 `runtime-restarting` IPC（runtime 确认崩溃，主进程在重启）
- `failed`：收到主进程 `runtime-failed` IPC（重启用尽）

区分 reconnecting 和 restarting 的价值：前者是「等一下就好」，后者是「runtime 出问题了正在恢复」，用户认知不同，状态条文案不同。

### 3.4 时序：崩溃恢复全流程

```
T0: runtime 子进程崩溃，exit 事件触发
T1: supervisor onExit 回调
    ├─ if (this.stopping) return   ← 主动退出短路
    ├─ this.child = null; this._port = null
    ├─ restartCount++（若距上次成功 >10s 则先清零）
    ├─ if (restartCount > MAX_RESTARTS) → 广播 runtime-failed，进入 failed 态
    └─ else:
        ├─ delay = 2^(restartCount-1) * 1000，clamp 16000
        ├─ 广播 runtime-restarting（通知前端进 restarting 态）
        └─ setTimeout(restart, delay)
T2: 定时器到期 → this.start()
    ├─ findAvailablePort（新端口）
    ├─ spawnRuntimeProcess
    └─ waitForHealth（健康检查通过 = 重启成功）
T3: 成功 → 广播 runtime-port（所有窗口重连新端口）→ restartCount 保持（等 10s 稳定后清零）
T3': 失败（spawn 失败/健康检查超时）→ 当作又一次崩溃，回 T1 逻辑
```

---

## 4. NFR 风险分析

### 4.1 稳定性

| 风险 | 对策 |
|------|------|
| 重启风暴（runtime 启动即崩，无限循环） | 5 次上限 + 指数退避，40s 内停止 |
| 重启时多窗口同时重连造成惊群 | 前端 ws-client 已有指数退避（1s/2s.../30s），天然错峰；无需额外协调 |
| 持有悬垂窗口引用 | 广播用 `BrowserWindow.getAllWindows()` + `isDestroyed()` 守卫，不存窗口引用 |

### 4.2 并发

| 风险 | 对策 |
|------|------|
| onExit 多次触发（exit 事件重入） | `restartTimer` 存在性检查，在途不叠加 |
| start() 与重启定时器竞争（用户手动重试撞上自动重启） | start() 开头 `clearTimeout(restartTimer)`；stopping 标志 + restartCount 管理 |
| 多窗口各自请求 restartRuntime | supervisor 单例 + 幂等 start()（child 活着则复用） |

### 4.3 资源

| 风险 | 对策 |
|------|------|
| 旧 runtime 进程树残留（pi 子进程未随 runtime 退出） | 重启前 stopRuntimeProcess 清理（复用现有进程树 kill 逻辑） |
| TIME_WAIT 端口耗尽（频繁崩溃重启） | findAvailablePort 每次选新端口，不复用旧端口；5 次上限也限制了端口消耗 |

### 4.4 可观测性

- 重启全程 console.log（`[runtime] restart attempt N/M in Xms`），dev 模式可见
- stderr 已转发（process-control:140），崩溃原因可见
- 前端状态条让用户感知恢复过程（不是静默假死）

---

## 5. 测试策略（概要）

### 5.1 supervisor 单测（核心）

mock ChildProcess + electron app，验证状态机：

| 用例 | 验证点 |
|------|--------|
| 崩溃 → 自动重启 | kill mock child → onExit 触发 → restartCount=1 → start 被调 → 广播 runtime-port |
| 主动 stop 不重启 | stop() 后 onExit → restartCount 不增，无 start 调用 |
| 重启上限 → failed | 连续 5 次 start 失败 → 广播 runtime-failed，不再 start |
| 指数退避 | 记录每次 setTimeout delay：1s/2s/4s/8s/16s |
| 稳定后计数清零 | 成功后 >10s 再次崩溃 → restartCount 从 1 开始（非累计） |
| 重启在途幂等 | onExit 连续触发 2 次 → restartTimer 只排一次 |

### 5.2 前端集成测（useConnection + ws-client）

| 用例 | 验证点 |
|------|--------|
| 收到 runtime-restarting → state=restarting | IPC 事件驱动状态机 |
| 收到 runtime-failed → state=failed + 状态条渲染 | 用户可见反馈 |
| 收到 runtime-port（新端口）→ disconnect 旧 + connect 新 | 重连新端口 |
| 重试按钮 → 调 restartRuntime IPC | 手动恢复入口 |

### 5.3 E2E（browser-automation 驱动，可选）

kill runtime 进程 → 断言前端出现「重启中」状态条 → 等待恢复 → 断言状态条消失 + 文件树可操作。受限于能否在 E2E 中 kill 主进程的子进程，可能需手工。

---

## 6. 实施路径建议

分 3 个 commit（每步可独立验证）：

1. **supervisor 重启逻辑**（runtime-supervisor.ts + interfaces.ts）：onExit 加重启策略 + stopping 标志 + 状态机。单测覆盖。这步完成后崩溃已能自动恢复（前端无感知，靠 ws-client 重连死端口直到新端口广播）。
2. **多窗口广播 + IPC 通道**（main.ts + preload + ipc.ts）：startAndBroadcast + runtime-restarting/runtime-failed IPC。前端能收到准确状态。
3. **前端状态条 UI**（ws-client 状态扩展 + useConnection + RuntimeStatusBar.vue）：用户可见恢复过程 + 手动重试。

每步不破坏现有功能：第 1 步后即使没有第 2/3 步，崩溃恢复也已工作（只是前端无明确反馈，靠退避重连兜底）。
