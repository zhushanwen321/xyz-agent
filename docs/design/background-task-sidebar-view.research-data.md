# background bash 任务数据源全景（explorer: sa-bad1cd34）

路径前缀：`E=` extensions/universal/base-tool-enhance，`R=` packages/runtime，`S=` packages/shared

## 1. extension 进程内实时数据

**task-store：纯 Map、无订阅机制。** 模块级 `taskTable = new Map<string, BackgroundTask>()`（E/src/background/task-store.ts:28）。API：`registerSpawnedTask`(:35，唯一入口)、`getTask`(:39)、`getAllTasks`(:44)、`getActiveTasks`(:49)、`countActiveTasks`(:53)、`oldestActiveTask`(:58)、`markKillingIntent`(:66)、`finalizeTask`(:89，唯一终态写入口，outcome 含 exitCode/reason/endedAt/tailSummary)。**没有任何 on-change/emit**——进程内感知状态变化只有两条路：poller 每 tick 拉 `getActiveTasks`，exit 边沿经 `setOnTaskExit` 回调（E/src/background/poller.ts:34，index.ts load 时挂 `handleTaskExit`）。

**notify：两条通道，均非 GUI 推送。** ① `pi.events.emit("pending:register"|"pending:unregister")`（E/src/background/notify.ts:107,130）给 peer extension（pending-notifications）；② agent 消息注入 `pi.sendMessage({customType:"background-bash",...},{deliverAs:"steer",triggerTurn:true})`（notify.ts:154-157）。触发时机：spawn 成功 / 轮询 exit 边沿（reason==="killed" 不 sendMessage，notify.ts:145——kill 调用方就在当前 turn）。reason 映射 `toPendingReason`（notify.ts:76）：natural+0→completed、natural+非零→failed、timeout→time_limited、killed/process-exit→cancelled。

**spawn 登记顺序**（E/src/background/spawn-background.ts:212-221）：`registerSpawnedTask` → `writeRegistryEntry`（写失败不阻断）→ `emitPendingRegister` → `ensurePollerRunning()`。taskId = `bt-<ts>-<rand6>`(:55)。进程 `spawn(shell,["-c",cmd],{detached:true, stdio:["ignore",fd,fd]})` + `unref()`(:153-166)；**父进程 spawn 后即 closeSync fd，输出由子进程直接写文件**。tailSummary 不是 spawn 算的——poller exit 边沿调 `readTailSummary`（poller.ts:82）= 尾部 5 行 / 800 字符（E/src/background/output-tail.ts:21-22,79）。

**工具返回形状（AI 视角上界参考）**：
- `bash_output` list（E/src/bash-output-tool.ts:61-70）：`{tasks:[{task_id, command(80字符截断), state, exitCode?, reason?, startedAt, durationMs?}]}`，startedAt 升序
- `bash_output` detail（:88-102）：`{task_id, state, exitCode?, reason?, startedAt, durationMs?, output(tail 2000行/50KB), truncated, outputFile}`；文件丢失 → `output:"<lost>"`
- `bash_kill`（E/src/bash-kill-tool.ts:45-47,131-142）：失败 `{killed:false, reason, hint?}`（含跨进程拒绝）；成功 `{killed:true, reason:"kill signal sent; poll bash_output..."}`

**output 文件**：`<getAgentDir()>/base-tool-enhance/<sessionId>/<task_id>.log`（spawn-background.ts:150）。stdout/stderr **混流同一 fd、无标记**（:161）。追加写（子进程持 fd），运行中可随时 tail 读——`readOutputTail` 从文件末尾按字节窗口 `readSync`（output-tail.ts:34-74），不锁不整读。

## 2. registry.json 写入时机与读取者

**Extension 侧统一写入口** `writeRegistryEntry`（E/src/background/registry.ts:179，锁内 RMW：read→覆盖同 id→LRU 裁剪→tmp+rename 原子写）。调用点：
| 迁移 | 位置 |
|---|---|
| running（spawn） | spawn-background.ts:218 |
| killing（timeout 到点） | spawn-background.ts:248 |
| killing（bash_kill） | bash-kill-tool.ts:126（intent 先落盘再 kill） |
| exited（轮询收尾） | poller.ts:85 |
| exited（进程退出兜底 process-exit） | process-exit-guard.ts:92 |

**Runtime 侧唯一写者** `writeOrphanedTerminal`（R/src/services/session/background-task-reaper.ts:308，只写 `state:'orphaned'` 不写 reason）。LRU 50 两处对称实现：extension registry.ts:187-191 / runtime reaper :314-318；常量在 S/src/background-task.ts 的 `MAX_TERMINAL_REGISTRY_ENTRIES=50`(:31)。

**reaper：纯事件触发，无 interval。** 入口 A `reapSessionBackgroundTasks`(:530) 挂 session-service `removeSessionEntry`（session-service.ts:846，fire-and-forget）；入口 B `reapAllSessionsBackgroundTasks`(:547) 挂启动 5s 定时器。三分支 `reapEntrySync`(:379)：①ownerPiPid 活→跳过；②属主死+任务 pid 活（有 pid start-time 复用防御）→ killProcessTree + orphaned；③任务 pid 死→仅 orphaned。**无任何 WS/event 广播**——观测面只有 console.log（:520）+ 返回统计结构（:335），无人消费。

**startup-background-init.ts:81-92**：启动 5s 后先 `reapOrphanPiProcesses`（杀孤儿 pi）再链式 `reapAllSessionsBackgroundTasks(getPiAgentDir())`（硬序理由 :72-80：扫描先行会把活 pi 的任务误判）。不 attach 遗留任务。

**runtime 侧无任何「读 registry 展示」消费者**——引用面仅 reaper、startup-init、session-service（只调触发面 A）。extension 侧读者：`pending-reconcile.ts:109`（session_start 对账）、bash-kill-tool.ts:67、bash-output-tool.ts:118。

**ephemeral 附着**：`withEphemeralPi`（R/src/infra/pi/process-manager.ts:214-237）——临时 sessionId spawn pi → attach 既有 sessionFile → 一次性 RPC → destroy。临时 pi 若加载本 extension 会并发写同 sessionId registry，故写侧用跨进程文件锁（registry.ts:11-13）；process-exit-guard.ts:70-72 明确 ephemeral 退出只清单例表不碰 registry，防误杀属主任务 [Inferred 关联，代码注释明示]。

## 3. runtime ↔ renderer 现成通道

**broadcast 消息域 SSOT** = `ServerMessageType` 联合类型（S/src/protocol.ts:681-808），payload 昁射 `ServerMessageMapBase`(:876 起)。主要域：`session.*`（created/deleted/switched/fullHistory/…）、`message.*`（start/delta/tool_call_*/bashStart/bashResult/…）、`plugin:*`、`extension:widget|widgetGui|status|notify|setEditorText`（:748-749）等。

**widget/gui 推送**：EventAdapter 翻译 pi `setWidget` → `extension:widget {sessionId, widgetKey, lines}` / `extension:widgetGui {sessionId, widgetKey, gui}`（R/src/infra/pi/event-adapter.ts:429 附近；契约 protocol.ts:963-965）。renderer 接收：`packages/renderer/src/composables/shell/useExtensionHostBridge.ts:76-130`（白名单 + 双订阅喂全局 ExtensionHost）。

**按 sessionId 拉取 RPC 范式**（`session.getCommands`）：
- 请求/回复类型登记：protocol.ts:304 / :736+1006
- runtime handler：R/src/transport/session-message-handler.ts——class `handles: ClientMessageType[]`(:44-66) + `handleSessionMessage` 大 switch，典型形状（:443-449）：`case 'session.getCommands': { ... return this.ctx.reply(ws, msg.id, 'session.commands', {sessionId, commands}) }`
- renderer 调用：`packages/renderer/src/api/domains/session.ts:127-130` `command('session.getCommands',{sessionId})`；pending 按 id resolve 在 api/pending.ts:115/129；消费示例 useCommandSync.ts:64-80 + stores/command.ts

**broadcast 本体**：全局 = R/src/transport/message-broker.ts:80-113（序列化一次遍历 clients）；session 级 push 应走 `IMessageBus.publish(sessionId, msg)`（R/src/services/message-bus/message-bus.ts:180-186，per-session seq/订阅过滤）。

## 4. 进程拓扑

进程链：**Electron main → runtime（Node sidecar，WS server，ELECTRON_RUN_AS_NODE）→ N × pi 子进程（每 session 一个）**。
- runtime spawn pi：R/src/infra/pi/rpc-client.ts:170-289，args `['--mode','rpc','--no-extensions','--approve']`(:216) + `--extension <path>` 逐个注入(:228-232)；数据隔离 `PI_CODING_AGENT_DIR = getPiAgentDir()`(:198)。base-tool-enhance 属打包 builtin extension，经 extension-service 提供 path 注入 [Inferred，由 mandatory-extensions 机制]。
- 每 session 独立 pi 进程（process-manager.ts:47-50 类注释 + `processes: Map<sessionId,...>`(:52)）→ **多 session 并行时 task-store 单例互相不可见**，跨进程只能靠 registry.json（带文件锁）+ output 文件。
- runtime ↔ pi 通信 = stdin/stdout JSONL RPC（sendCommand rpc-client.ts:489-539；response 按 id resolve :431-435，其余作事件广播 :440-444）。**runtime 读不到 pi 内存**——只能 RPC / pi 落盘文件（session JSONL、registry、output log）。
- runtime 本身是 Electron main 的子进程（apps/electron/main/supervisor/process-control.ts:188 `spawnRuntimeProcess`），supervisor 管 crash-restart。

## 数据可得性矩阵

| UI 想展示 | 来源 | 新鲜度 |
|---|---|---|
| 任务列表（id/command/state/时间） | registry.json（含终态 LRU 50，跨进程权威） | 写时更新：spawn/killing/exited 写即落盘；但**无变更事件，UI 需轮询或 runtime mtime watch** |
| 运行中任务实时状态翻转 | registry.json（extension 每次迁移原子写） | 同上，无 push；extension 进程内的 task-store 事件不出进程 |
| exit 边沿事件（含 reason/tailSummary） | pi 进程内 poller 回调 / pending:register 事件 | 只在 pi 进程内 + pending-notifications；桌面端需新链路（EventAdapter 翻译或 runtime 读 registry 对账） |
| 完整输出流 | outputFile `<piAgentDir>/base-tool-enhance/<sid>/<taskId>.log` | 实时（子进程直写，随时可 tail；混流无 stderr 标记） |
| 尾部摘要 | tailSummary（registry 终态条目内，5 行/800 字符） | 终态时写入 |
| kill 能力 | bash_kill 工具（extension 进程内）或 reaper killProcessTree | UI 侧需新通道触达（pi RPC 或 runtime 代杀——reaper 已有 killProcessTree 范式） |
| orphaned 任务 | runtime reaper 写 registry | 仅启动 5s + session 删除两时机，无广播 |
| 按 session 拉取列表 | 可新增 RPC：仿 session.getCommands（runtime 读 registry） | 请求时读，权威准确 |

**关键设计约束**：① registry 是唯一跨进程 SSOT，但全链路无任何变更广播——侧边栏要实时，要么 runtime watch registry 文件（fs.watch/mtime 轮询）再走 message-bus `publish(sessionId,…)`，要么给 extension 加 notify 钩子走 EventAdapter 翻译；② output 是混流纯文本，UI 分流 stdout/stderr 不可得；③ runtime 直接读文件即可（registry/output 都在 `getPiAgentDir()` 下），无需经 pi RPC。
