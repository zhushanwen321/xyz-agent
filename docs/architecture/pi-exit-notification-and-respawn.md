# pi 子进程异常死亡的通知传播与自愈（respawn）

> **一句话结论**：pi 异常死亡后 session 变僵尸的根因不是「缺 respawn 机制」——respawn 基础设施（`restoreSession` + `ensureActive` + 前端 dead UI）完整存在——而是 `ProcessManager.createSession` 的 `onExit` 闭包在 `rekey(tempId → 真实 piSessionId)` 后持有过期 sessionId，导致 create 路径的死亡信号**整条传播链断裂**（不清理、不广播 `session.exited`、前端不知道）。本设计修复传播链（含两个伴生缺陷：stream error 路径不发死亡通知、`onExit` 单槽覆盖语义），并补一层消费端防御（`ensureActive` 校验 `exited`），让现有的三条恢复路径（切回自动 restore / dead UI 重新打开 / 发消息兜底 restore）全部生效。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 桌面工作台中，每个聊天 session 对应一个 runtime（Node.js 子进程）管理的 pi CLI 子进程（`pi --mode rpc`，stdin/stdout JSONL 通信）。session 历史持久化在磁盘 JSONL，进程只是无状态的运行时载体。
- **C（冲突）**：pi 子进程被 kill -9（或崩溃）后，用户在该 session 发新 prompt 报 `pi process is not running`，切走再切回无效，只有重启应用才恢复。侧栏该 session 看起来一切正常——用户不知道它已经死了。
- **Q（问题）**：为什么 pi 死后 runtime 既不通知前端也不自愈？respawn 应该怎么做、有哪些副作用？
- **A（答案）**：修复死亡信号的传播链（根因），让既有的 lazy respawn 设施真正被触发；不做 proactive 自动重启（crash-loop 风险，无增量收益）。

## 1. 背景：被设计的系统是什么

**本章结论**：本设计聚焦 runtime 层「pi 进程死亡检测 → 通知 → 恢复」链路，涉及三个模块。

xyz-agent 的 Electron 主进程拉起 runtime 子进程（WebSocket 服务），runtime 为每个活跃 session spawn 一个 pi 子进程并持有 `RpcClient`（JSONL RPC 封装）。三个关键模块：

| 模块 | 文件 | 职责 |
|---|---|---|
| RpcClient | `packages/runtime/src/infra/pi/rpc-client.ts` | 单个 pi 进程的 RPC 封装：spawn、`sendCommand`、`_exited` 死亡标志、`exitCallback` 死亡通知 |
| ProcessManager | `packages/runtime/src/infra/pi/process-manager.ts` | 进程表（`processes: Map<sessionId, ManagedProcess>`）：创建/销毁/`rekey` 改键、`onSessionExit` 多播给上层 |
| SessionService | `packages/runtime/src/services/session/session-service.ts` | session 业务层：持有 `sessions Map`、构造函数里消费 `pm.onSessionExit` 做「detach adapter + 广播 `session.exited` + 删 Map + 写 stopped 终态」 |

session 的创建有**三条 spawn 路径**，这是理解本 bug 的关键：

1. **create 路径**（`session-lifecycle.ts` `create()`）：先用随机 `tempId` spawn pi → `client.getState()` 问 pi 要真实 sessionId → `pm.rekey(tempId, piSessionId)` 改键。日常「新建 session」都走这条（含 hidden 公共 session——`options.hidden` 同走 create/rekey 链路，本修复覆盖）。
2. **restore 路径**（`restoreSession()`）：用扫描到的真实 sessionId 直接 spawn + `switchSession` 附加历史。冷启动恢复、以及**本设计要打通的自愈路径**。
3. **fork 路径**（`forkSession()`）：用 fork 出的新文件 sessionId 直接 spawn，无 rekey。

## 2. 设计目标

**本章结论**：让「pi 死了」这件事被正确感知，且用户不重启应用就能继续对话。

1. **死亡可感知**：pi 异常死亡后，前端收到 `session.exited`，session 标记 dead、聊天流插入错误消息、streaming 状态收口（不卡「思考中」）。
2. **session 可自愈**：用户切回该 session 或点「重新打开」后，runtime 自动 respawn pi（`restoreSession` 附加磁盘历史），对话可继续、历史不丢。
3. **无残留**：死亡后 `processes`/`sessions`/`clientToId` 三个 Map 无死条目残留（残留死 client 是 `pi process is not running` 僵尸态的直接来源）。
4. **回归无损**：restore/fork 路径现有的死亡处理行为（原本就正确）不劣化；正常删除/退出流程不受影响。

**In-scope**：死亡信号传播链修复（rpc-client / process-manager）、消费端防御（session-service `ensureActive`）、相关单测与 dev 实测验收。附带修复：stream error handler 补 SIGKILL，回收「管道断裂但未退出」的孤儿进程（§6.3 副作用 #9，与传播链修复同文件，不拆分）。
**Out-of-scope**：
- **pi 假死检测与主动 kill**（进程活着但不响应 RPC 的场景）——当前系统完全无此机制，涉及心跳/超时策略设计，独立立项；
- crash-loop 自动重启策略（proactive respawn 及其退避）——见 §6.2 裁决；
- 死亡时在途生成内容的恢复——pi 已 flush 到 JSONL 的部分经历史重建可见，未 flush 部分接受丢失（错误消息已告知用户）。

## 3. 现状：使用者眼里是什么样的

**本章结论**：restore/fork 创建的 session 死了有完整的感知+恢复体验；create 创建的 session（绝大多数）死了以后是「看起来正常但永远报错」的僵尸。

### 3.1 现状的真实样子（代码事实）

死亡信号的既有传播链（restore/fork 路径，行为正确）：

```
pi 进程异常退出（kill -9 / 崩溃）
  → RpcClient: proc.on('exit') 置 _exited=true、rejectAll 在途 RPC     [rpc-client.ts:235-249]
  → RpcClient: exitCallback(code, stderr)                              [rpc-client.ts:245-247]
  → ProcessManager: processes.delete + clientToId.delete               [process-manager.ts:207-216]
      + 遍历 exitCallbacks 多播 onSessionExit
  → SessionService 构造函数注册的回调：                                 [session-service.ts:205-250]
      adapter.detach() → bus.publish(session.exited) → removeSessionEntry
      → 写 stopped 终态 → broadcast config.sessions
  → 前端：markSessionError（streaming 收口 + 错误消息）+ markDead + toast  [useMessageEffects.ts:35-41]
  → Panel.vue 渲染 dead 占位 UI（「进程已退出」+「重新打开」按钮）
```

前端已有的恢复入口（无需本设计新增）：

- **侧栏点击 dead session** → 自动走 `session.restore` RPC + `revive`（`useSidebarSessionActions.ts:66-79`）；
- **dead 占位 UI 的「重新打开」按钮** → 同上；
- **切回 session**（`session.switch`）→ runtime 侧 `getSummary` miss（Map 已清）时自动 `ensureActive`（`session-message-handler.ts:217-246`）→ `restoreSession`；
- **发消息**（`session.sendMessage`）→ dispatcher `sendPrompt` 第一步就是 `ensureActive`（`message-dispatcher.ts:105`）。

`ensureActive`（`session-service.ts:525-541`）是现成的 lazy respawn：无 client 则 `restoreSession`（重新 spawn pi + `switchSession` 附加磁盘 JSONL 历史），并发用 `restoringSessions` Set 去重。

### 3.2 怎么出错（真实失败模式）

**失败模式 A（主症状）**：create 路径创建的 session，pi 被 kill -9 后变僵尸。

1. `createSession(tempId)` 注册 `client.onExit(cb)`，**cb 闭包捕获 tempId**（`process-manager.ts:207`）；
2. pi 返回真实 sessionId 后 `pm.rekey(tempId, piSessionId)`（`session-lifecycle.ts:223`）——只改 Map 键，**cb 闭包里的 tempId 不会跟着变**；
3. pi 死 → cb 执行 → `this.processes.has(tempId)` 为 **false**（键已是 piSessionId）→ **直接 return**（`process-manager.ts:209`）；
4. 后果链：`processes`/`clientToId`/`sessions` 三个 Map 残留死条目 → `session.exited` 不广播 → 前端不知道（无 dead UI）→ `session.switch` 里 `getSummary` 命中死条目直接 reply（不 restore）→ 发消息时 `ensureActive` 里 `getClient` 返回**死 client** → `client.prompt()` 抛 `pi process is not running`（`rpc-client.ts:391`）；
5. 该 session 从此永远报这个错，直到重启应用。

> 术语锚定：**「僵尸 session」** = 上面第 4 步的状态——进程已死但 runtime 各层 Map 残留死条目、前端无感知、所有 RPC 入口拿到死 client。就是 §3.2 场景里用户看到的那个「看起来正常但发消息报错」的 session。

**失败模式 B（伴生缺陷 1）**：pi stdout/stderr 管道断裂（EPIPE/ECONNRESET）但进程尚未退出时，stream error handler 只置 `_exited` + `rejectAll`，**不调 `exitCallback`**（`rpc-client.ts:271-295`）——同样的 Map 残留，且真进程可能还活着（孤儿进程泄漏）。

**失败模式 C（伴生缺陷 2）**：`RpcClient.onExit` 是单槽覆盖语义（`this.exitCallback = callback`，`rpc-client.ts:439-441`）。ProcessManager 是唯一注册者所以当前没炸，但 handoff-service 已被迫用 2s 轮询 `client.exited` 绕开（`handoff-service.ts:63-70` 注释明确记录）。任何未来的第二个注册者会静默覆盖 PM 的清理回调，复刻失败模式 A。

### 3.3 消费端缺口

`ensureActive` 拿到 `existing` client 时不校验 `existing.exited`（`session-service.ts:526-527`）——只要 Map 有条目就返回。这是僵尸态的最后一道未设防线。

## 4. 根因 + 物理数据流

**本章结论**：三条失败模式共用一个根因类别——**死亡信号的产生与传播没有单一事实出口，且各持有者对「session 身份」的认知不同步**。

```
pi 进程死亡（OS exit 事件 / 管道断裂）
   │
   ├─ [信号产生] RpcClient：_exited 置位（3 处：proc exit / stdout err / stderr err）
   │     ✅ 产生侧完备            ❌ 只有 proc exit 走 exitCallback（B 断点）
   │
   ├─ [身份解析] ProcessManager onExit 闭包捕获创建时 sessionId
   │     ❌ rekey 后闭包过期 → has(tempId)=false → return（A 断点，根因）
   │
   ├─ [信号分发] RpcClient.exitCallback 单槽
   │     ❌ 后注册者覆盖先注册者（C 断点，结构性隐患）
   │
   ├─ [消费] SessionService.onSessionExit 回调 → 清理 + session.exited 广播
   │     ✅ 消费侧完备（restore/fork 路径验证过）
   │
   └─ [兜底] ensureActive 不验 exited → 死 client 直通 prompt
         ❌ 最后防线缺失（§3.3）
```

对照：restore/fork 路径无 rekey，身份解析不断，整条链工作——这解释了「为什么部分场景的自愈已经是对的」。

物理数据流（respawn 时的历史恢复路径，已存在，本设计复用）：

```
~/.xyz-agent/pi/agent/sessions/<cwd-encoded>/<ts>_<sessionId>.jsonl（磁盘历史，唯一事实源）
  → restoreSession: readFileSync + stripSessionEndEntries → 写 tmpdir 副本
  → 新 pi spawn（preset sidecar 解析启动参数，缺失时 builtin:full 兜底）
  → client.switchSession(tmpFile)（pi 从文件加载 entry 树到内存）
  → initializeManagedSession（新 adapter attach、sessions Map 新条目）
  → 前端 postLoadSession 重新订阅 MessageBus session 通道
```

## 5. 终态：使用者眼里将是什么样的

**本章结论**：pi 死后 1 秒内用户收到明确死亡提示，随后两种方式（切回 / 点重新打开）都能继续对话且历史完整。

### 5.1 成功路径（前台死亡恢复）

用户在 session S（create 创建）正在跑任务，外部 kill -9 该 pi 进程：

1. 聊天流立即出现错误消息 `Session process exited (code: null)`，streaming 中的回复收口为 error 态（不卡「思考中」）；
2. toast 提示进程退出；切到该 session 时显示「进程已退出」占位 + 「重新打开」按钮；
3. 用户点「重新打开」（或切走再切回）→ runtime `restoreSession` 重新 spawn pi 并从磁盘 JSONL 恢复历史 → 历史消息完整显示（含死亡前 pi 已 flush 的部分生成内容）；
4. 用户发新 prompt `继续上面的任务` → 正常生成。**全程无需重启应用。**

### 5.2 失败路径（respawn 本身失败，带恢复指引）

respawn 失败的典型原因：model 配置失效（如 provider 下架）、pi 二进制损坏。现状 `session.restore` 失败已回 `restore_failed` 错误（`session-message-handler.ts:96` 附近），错误信息包含 pi stderr 尾部。终态要求错误信息可操作（规则：错误 → 权威源 → 重试闭环），最低要求：保留 stderr 尾部 + 指引用户到 Settings 检查模型配置后重试「重新打开」。此路径为既有行为的文案校验项，非新机制。

## 6. 关键决策与权衡

**本章结论**：5 个决策——修传播链而非加 respawn 新机制；lazy 而非 proactive；死信号单一出口；onExit 改多播；ensureActive 加 exited 防御。

### 6.1 总路线：修复传播链 vs 新增 respawn 机制

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 修复传播链（rekey 闭包 + stream error 出口 + onExit 多播）+ ensureActive 防御 | 高：死信号是所有自愈的前提，一处修复三路（切回/重开/发消息）全通；无新概念 | 低：3 个文件各改一小块 | 低：行为对齐已验证的 restore 路径 | ✅ |
| B. 不修 rekey，只在 ensureActive/prompt 处检测死 client 强制 restore | 低：症状补丁，`session.exited` 永远不发，前端 dead UI 永远不出现，用户只看到反复报错后「莫名恢复」 | 中 | 中：Map 残留仍会随时间累积（clientToId/adapter 监听器） | ❌ |
| C. proactive respawn（exit 回调里立即重建） | 低：pi 因配置错误死亡时无限 crash-loop，需额外退避/上限机制 | 高 | 高：与本设计目标 2 无增量收益（无 pending 操作需要新进程立即接手） | ❌ |

**被否若用 B**：§5.1 场景变成——用户看到报错但侧栏 session 始终「正常」，不知道要切走再切回；`session.exited` 的 streaming 收口不触发，聊天流卡「思考中」。**被否若用 C**：model auth 过期时 pi spawn 即退，runtime 无限重启进程打满 CPU，且用户没有任何输入窗口。

### 6.2 respawn 时机：lazy（现状设施）+ 用户显式动作

裁决：保持 lazy。三条既有触发路径（`session.switch` auto-restore / dead UI 重新打开 / `sendPrompt` 的 `ensureActive`）在传播链修复后全部生效。**不新增** proactive 定时检测。理由：死亡时没有需要新进程接手的在途操作（在途 RPC 已被 rejectAll），立即重建无收益；lazy 由用户动作触发天然防 crash-loop。

### 6.3 死信号单一出口：proc.on('exit') 是唯一通知点

裁决：stdout/stderr stream error handler **不再直接触发通知**，只做「置 `_exited` + `rejectAll` + `proc.kill('SIGKILL')` 加速进程死亡」，让 `proc.on('exit')` 作为死亡通知的**唯一出口**（其中 `_killing=true` 的主动 kill 流程仍不通知，语义不变）。理由：单一出口消除「stream error 先通知、exit 又通知」的双触发面；SIGKILL 保证管道断裂但未退出的进程被回收（修失败模式 B 的孤儿泄漏）。幂等性：exit 回调里 PM 以 `clientToId` 为准做一次性清理，二次触发自然 no-op。

### 6.4 ProcessManager 身份解析：onExit 回调内反查 `clientToId`

裁决：onExit 回调不再用闭包 sessionId，改为执行时 `this.clientToId.get(client)` 反查当前 id；`undefined`（已被 destroySession/rekey 清除）则 return。理由：`clientToId` 与 `processes` 由 createSession/destroySession/rekey 成对维护，互为镜像（不变量：`clientToId.has(client) ⟺ processes 命中其对应 id`），执行时反查天然与 rekey 同步。原 `processes.has(sessionId)` 守卫的语义（「intentionally destroyed 则跳过通知」）由 `clientToId` 无条目覆盖，destroySession 先删 Map 的竞态保护保持不变。

### 6.5 RpcClient.onExit 单槽 → 多播

裁决：`exitCallback` 单字段改 `Set<callback>`，`onExit` 返回 unsubscribe（与 `onEvent` 同模式），`IPiEngine` 接口签名同步。理由：消除「第二个注册者静默覆盖 PM 清理」的结构性隐患（失败模式 C）；handoff-service 的 poll 可迁移为 onExit 订阅（本设计不改它，留作后续清理项）。

### 6.6 消费端防御：ensureActive 校验 `existing.exited`

裁决：`ensureActive` 中 `existing && !existing.exited` 才直返，死 client 视同无 client 走 `restoreSession`（其内部对残留 sessions 条目已有 detach + safeDestroy + removeSessionEntry 清场逻辑）。理由：纵深防御——即使上游清理出现未知竞态，消费端也不会把死 client 交给 prompt。`getClient` 本身不改语义（handoff-service 等依赖裸 client 观察 `exited`），文档注释标明「调用方必须自行处理 exited 死 client，业务入口应走 ensureActive」。

**影响面声明**：本防御仅覆盖 `ensureActive` 入口（`sendPrompt` / `sendSubagentMessage` / `session.switch` auto-restore）。其余直接调 `pm.getClient` 的路径（`switchModel` / `setThinkingLevel` / `getCommands` / `fetchContext` / `workflowAction` / `subagentAction` / `promptReload`）拿到死 client 时仍抛 `pi process is not running`——这不是回归（当前即此行为），且传播链修复后这些入口理论上不会再拿到死 client（Map 已清）。留作后续统一治理，不在本设计强行收敛。

### 6.9 首 turn 无文件死亡：session 终结语义（显式裁决）

**状态组合**：create 路径首 turn streaming 中 pi 死亡，session 文件尚未 flush（AGENTS.md 规则 #6 的延迟写入窗口）。此时代码事实：`removeSessionEntry` 删 sessions Map 条目 → scanner 扫不到磁盘文件 → **session 从侧栏消失**；`session.exited` 在 clearSession 前发布，panel 收到并短暂显示 dead 态；`config.sessions` 列表广播刷新后 session 消失，panel 落到空态（`isSessionDead` 依赖 `sessionStore.list.find(id)`，list 无此 session 时为 false，dead 占位 UI 与 ghost session UI 均不可达——前端 Panel.vue:22-41 已核实）。toast 全局可见。

**裁决**：接受「首 turn 无文件死亡 = session 终结（从列表消失）」语义，显式化而非改变行为。**含用户首条 prompt 的丢失**：pi 可能在首 turn 工具调用中间死亡（用户 prompt 已发、无 assistant 消息），显式裁决为接受丢失——toast 已告知死亡原因，用户重发一条 prompt 的成本低于为其引入恢复机制的成本。被否方案：

| 方案 | 裁决 | 理由 |
|---|---|---|
| (a) `removeSessionEntry` 前 runtime 写最小 session 文件 | ❌ | 违反 [HISTORICAL] 规则 #6「禁止任何代码在 pi 首次 flush 前创建/触碰 session 文件」的架构约定方向；为无内容的 session 引入 runtime 写 pi 文件的新路径，长期看是新的 EEXIST 风险面 |
| (b) 保留 sessions Map dead 条目不删 | ❌ | 与 §2 目标 3（无残留）直接矛盾；引入「Map 中 dead 态条目」的新状态管理（谁复活它、何时清、与 scanner 合并逻辑的交互），改动面远超收益 |
| (c) session 终结语义 + 可感知（选） | ✅ | 无内容的 session 无历史可恢复——「自愈」对它没有意义，恢复出来也是空 session；用户损失仅为一条未回复的 prompt，toast 已告知死亡原因，重开 session 成本 ≈ 恢复成本 |

**配套要求**（错误信息可操作，规则 16）：`ensureActive` → `restoreSession` 在 `findScannedSession` 找不到时抛的 `SESSION_NOT_FOUND`，其文案补恢复指引：「该会话无已保存内容（进程在首次保存前退出），请新建会话」。dispatcher 包装层（`Failed to restore session: ...`）透传即可。

### 6.7 respawn 副作用清单（用户问题的正面回答）

| # | 副作用面 | 分析 | 结论 |
|---|---|---|---|
| 1 | **pi session 文件 EEXIST 禁区**（首 flush 前触碰文件 → session 永久卡死） | `restoreSession` 走「readFileSync 原文件 → tmpdir 副本 → switchSession」，**不写原文件**；文件不存在时 `findScannedSession` 找不到直接报错，不会走到创建文件的路径 | 安全 ✅ |
| 2 | **spawn 参数漂移**（respawn 后 preset/model 与死亡前不一致） | preset 从 `.preset.json` sidecar 恢复；首 turn 前死亡（sidecar 未写，内存态已随 Map 清理丢失）→ fallback `builtin:full`，工具集可能变宽 | 可接受：首 turn 前无对话内容，影响仅为下次 prompt 的工具集；文档明示 |
| 3 | **在途任务丢失** | 死亡时 streaming 内容：pi 已 flush 的在 JSONL，respawn 后历史重建可见；未 flush 的丢失。前端 `session.exited` → `markSessionError` 收口 + 错误消息 | 接受丢失，已有用户可见性 ✅ |
| 4 | **subagent 级联** | 父 pi kill -9 → subagent 子进程经 stdio EOF 级联死亡（实测结论，handoff §4.5）；extension 侧孤儿终态恢复已由前序分支收敛 | 无需 runtime 参与 ✅ |
| 5 | **crash-loop** | lazy + 用户显式触发，单次失败报错给用户，无自动重试 | 无此风险 ✅ |
| 6 | **消息订阅/缓存一致性** | 死亡时 `removeSessionEntry` 清 historyCache + `bus.clearSession`；respawn 后前端 `postLoadSession` 重新订阅 | 已有机制覆盖 ✅ |
| 7 | **并发 restore** | `restoringSessions` Set 去重已有（`session-service.ts:528-531`） | 已有 ✅ |
| 8 | **`onSessionExit` 与 destroySession 竞态** | destroySession 先删 Map 再 kill；exit 回调反查 `clientToId` 无条目 → no-op | 保持原语义 ✅ |
| 9 | **stream error 后进程仍活的孤儿** | 本设计 §6.3 的 SIGKILL 兜底回收 | 本设计修复 ✅ |

### 6.8 「如何判断 pi 需要 kill」——现状评价（用户问题的正面回答）

分两问：

- **「如何判断 pi 已死」**（本设计的前提）：`proc.on('exit')` OS 级事件 + `_exited` 标志。机制本身合理（零误判、零轮询成本）；缺陷不在判定而在传播（本设计修复）。
- **「如何判断 pi 假死需要主动 kill」**：**当前系统不存在此机制**——RPC 60s 超时只 reject 调用方不 kill pi；abort 失败只广播终态。pi 假死（进程活着不响应）时 session 卡住，唯一出路是重启应用。这是真实缺口，但涉及心跳/超时/熔断策略，**out-of-scope 独立立项**（本设计 §2 已声明）。

## 7. 实现机制

**本章结论**：3 个文件、4 处改动，全部为既有结构的收敛，无新模块。

### 7.1 `rpc-client.ts`

1. `exitCallback` 单字段 → `exitCallbacks: Set<(code, stderr) => void>`；`onExit` 返回 `() => void`（unsubscribe，与 `onEvent` 对称）；`proc.on('exit')` 中遍历 Set 调用（`_killing` 时跳过的语义保留）。签名变更影响面已验证：grep 确认仅 `RpcClient` 正式 implements `IPiEngine`（pi-engine.ts:193 / rpc-client.ts:96）；测试 mock 均用 `as unknown as` 强转，不走接口签名检查，不受影响。此为接口契约变更（`void` → 返回 unsubscribe），编译安全（void 接受任何返回值，现有调用方返回值均被丢弃），未来调用方可依赖 unsubscribe。
   时序说明：`start()` 在 STARTUP_DELAY_MS 窗口内失败时，永久 `proc.on('exit')` 监听器仍会触发 exitCallbacks——但此时 PM 尚未注册 onExit（`createSession` 的注册在 `start()` resolve 之后），故为 no-op；若未来把 PM 的 onExit 注册提前到 start() 之前，需评估双通知风险。
2. stdout/stderr stream error handler（W2 注释块）：置 `_exited` + `rejectAll` 后，补 `proc.kill('SIGKILL')`（try/catch 包裹，进程可能已死）——死亡通知统一由后续 exit 事件发出。**注意：此处是 `proc.kill()`（Node.js ChildProcess 原生方法），不设 `_killing`；勿用 `this.kill()`（RpcClient 方法，会置 `_killing=true` 导致 exit 回调跳过通知——整条修复失效）**。
3. `IPiEngine.onExit` 签名同步（`services/ports/pi-engine.ts`）：返回 unsubscribe。

### 7.2 `process-manager.ts`

`createSession` 中 `client.onExit` 回调改为：

```ts
client.onExit((code, stderr) => {
  // 反查当前 id：闭包捕获的 sessionId 在 rekey 后过期（create 路径 tempId → piSessionId）
  const currentId = this.clientToId.get(client)
  if (currentId === undefined) return  // 已被 destroySession 清理（intentional destroy）
  this.processes.delete(currentId)
  this.clientToId.delete(client)
  // 命名消歧：此处 this.exitCallbacks 是 ProcessManager 的字段
  // Set<(sessionId, code, stderr) => void>（上层多播，process-manager.ts:123），
  // 与 RpcClient 改造后的 exitCallbacks: Set<(code, stderr) => void> 是不同类、不同签名的字段
  for (const cb of this.exitCallbacks) cb(currentId, code, stderr)
})
```

（示意，实际以实现为准；`clientToId` 的镜像不变量在三类操作点成对维护已成立。）

### 7.3 `session-service.ts`

`ensureActive`：

```ts
const existing = this.pm.getClient(sessionId)
if (existing && !existing.exited) return existing   // 新增 exited 校验
```

死 client 落入下方 `restoreSession` 路径（内部清场逻辑已处理残留条目）。另在 `getClient` 的接口注释上标注「可能返回已死 client（exited=true），业务入口应走 ensureActive」。

配套：`restoreSession` 的 `findScannedSession` 失败分支（首 turn 无文件死亡，§6.9）错误文案补恢复指引——`Persisted session X not found` → 追加「该会话无已保存内容（进程在首次保存前退出），请新建会话」（保持 `SESSION_NOT_FOUND` code 不变，`errorWithCode` 签名不变）。文案是**追加**（非替换）：两个现有测试用 `toThrow` 子串匹配原文案（`packages/runtime/test/session-service.test.ts:754` / `session-pool-restoresession.test.ts:258`），追加兼容；若未来改为替换需同步更新。文案消费点说明：该错误经 `ensureActive` → dispatcher 包装（`Failed to restore session: ...`）走 message.error 气泡与 error envelope；§6.9 场景下 panel 已切空态，用户主要经 toast + 新建 session 恢复，文案面向的是「文件存在但 TTL 窗口外消失」等能到达 restore 的路径。

## 8. 验收（真实场景，非单测非 mock）

**本章结论**：改动规模中等（行为修复，3 文件），用 5 个真实场景 + 三视角验证。

### 8.1 改动规模

中等：runtime 行为修复（不新增功能面），但有用户可见行为变化（僵尸 → 可恢复），需要完整场景验收 + 回归。

### 8.2 验收场景

前置（全部场景共用）：`pnpm dev` 单实例（确认 1420/3310 端口归属），dev 数据目录 `~/.xyz-agent-dev`，模型 `MiMo-V2.5-Pro`；定位目标 pi PID 用 `ps -o pid,lstart,command` 按 sessionDir + 启动时间精确匹配（禁「最新 pi」启发式，会误杀 workflow 子进程）。runtime 改动后必须重启 `pnpm dev`（tsx 非 watch）。

| # | 场景 | 回溯目标 | 真实流程 | 通过标准 |
|---|---|---|---|---|
| V1 | create 路径 kill -9 → 感知 + 重开恢复 | 目标 1、2、3 | 新建 session → 跑一个短任务至完成 → kill -9 该 pi → 观察前端 → 点「重新打开」→ 发新 prompt `1+1=?` | 死后 ≤2s 聊天流出现 `Session process exited` 错误消息 + dead 占位 UI；重开后历史完整（死亡前对话全在）；新 prompt 正常生成回复；侧栏该 session 的 `status` 为 `idle`（非 `active`）、label 保留 |
| V2 | create 路径 kill -9 → 切走切回恢复 | 目标 2、3 | 同 V1 死亡后不点按钮，切到 session B 再切回 A → 发新 prompt | 切回后 session 恢复对话能力（`session.switch` auto-restore 生效），历史完整，prompt 正常回复 |
| V3 | streaming 中 kill -9 | 目标 1 | 新建 session → 发一个长任务（streaming 中）→ kill -9 → 观察 → 点「重新打开」 | streaming 消息收口为 error 态（不卡「思考中」、isGenerating 复位）；错误消息可见；重开后已 flush 的部分生成内容在历史中可见 |
| V3b | 首 turn 无文件死亡（session 终结语义） | 目标 1、3 | 新建 session → 首条 prompt 发出后立即 kill -9（确认 `~/.xyz-agent-dev/pi/agent/sessions/<cwd-encoded>/` 无该 session 的 .jsonl = 未 flush）→ 观察 toast 与侧栏 → **新建另一个 session 正常对话**（用户的恢复路径） | toast 告知进程退出；session 从侧栏列表消失（scanner 扫不到 + Map 已清，§6.9 裁决的终结语义）；`ps aux | grep 'mode rpc'`（按 cwd/sessionDir 过滤）确认无残留 pi 进程；新 session 对话正常（恢复路径可用）。SESSION_NOT_FOUND 恢复指引文案由单测断言覆盖（见白盒表），不依赖本场景触发 |
| V4 | restore 路径死亡回归 | 目标 4 | 重启应用 → 侧栏点击旧 session（走 restore 激活）→ kill -9 → 点「重新打开」 | 行为与修复前一致（dead UI + 恢复成功），无劣化 |
| V5 | 正常流程回归 | 目标 4 | 新建 session 正常对话 → 用户主动删除该 session；再新建 → 正常退出应用 | 删除干净（无 PROCESS-LEAK-RISK 日志）；退出时无孤儿 pi 进程（`ps` 复核）；全程无异常日志 |

观察者形态补充断言（每场景执行时检查 runtime 日志）：
- 死亡时出现 `[process-manager] session <piSessionId> process exited unexpectedly`（真实 id，非 tempId）；
- `~/.xyz-agent-dev/logs/` 下 pi stdout tee 日志（`pi-<date>-<sessionId>.jsonl`）在死亡时刻停止增长。

构建者白盒（单测，`packages/runtime` vitest，从子包目录运行）：

| 单测 | 断言 |
|---|---|
| process-manager rekey 后 exit | createSession → rekey → 模拟 exit → `processes`/`clientToId` 无残留、`onSessionExit` 收到 **rekey 后的 id** |
| process-manager intentional destroy 不通知 | destroySession → 模拟 exit → `onSessionExit` 不触发 |
| rpc-client onExit 多播 | 两个订阅者都收到；unsubscribe 后不再收 |
| rpc-client stream error 加速回收 | stdout error → handler 调 `proc.kill('SIGKILL')`（mock proc 验证 kill 被调用）+ exitCallback 恰好触发一次（防双通知；与 §11 检查点 1 一致，mock 层验证调用次数，不依赖 OS 时序假设） |
| ensureActive 死 client 防御 | getClient 返回 exited client 时走 restoreSession 而非直返 |
| SESSION_NOT_FOUND 恢复指引文案 | `restoreSession` 对不存在 id 抛错消息含「请新建会话」子串；注意两个现有测试（`packages/runtime/test/session-service.test.ts:754`、`session-pool-restoresession.test.ts:258`）用 `toThrow` 子串匹配 `Persisted session X not found`——文案是**追加**故兼容，若改为替换需同步更新这两个测试 |

## 9. 实施

**本章结论**：两个开发 wave（可并行）+ 一个验证 wave，串行验收。

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| Wave 1 | 传播链修复：rpc-client（多播 + stream error SIGKILL）+ process-manager（反查 id）+ 各自单测 | §5.1 步骤 1-2（感知）+ 步骤 3 的前置（清理正确） |
| Wave 2 | 消费端防御：session-service `ensureActive` exited 校验 + `restoreSession` 找不到 session 时的恢复指引文案（§6.9/§7.3）+ 单测；`IPiEngine.onExit` 签名同步（与 Wave 1 有接口耦合，实施时先合 Wave 1 或同分支顺序提交） | §5.1 步骤 4 的兜底（死 client 永不直通 prompt）+ §6.9 终结语义的错误可见性 |
| Wave 3 | 验证：三连（typecheck/lint/test）+ V1-V5 实测 + 日志形态检查 | §8 全部通过标准 |

依赖关系：Wave 1 与 Wave 2 的**实现文件**不相交（rpc-client/process-manager vs session-service），但 `pi-engine.ts` 接口文件是共享编译依赖——Wave 1 变更 `onExit` 签名，Wave 2 的 session-service 编译依赖新签名 → **同分支串行提交（Wave 1 先），单测各自 mock 可并行编写**。Wave 3 依赖 W1+W2 完成。

## 10. 下一层拆分（subagent 任务单元）

| 单元 | wave | 说明 | justification |
|---|---|---|---|
| U1 | 1 | `rpc-client.ts`：onExit 多播 Set + unsubscribe；stdout/stderr error handler 补 SIGKILL；`pi-engine.ts` 接口签名；单测 | 死信号产生侧收敛，单一出口原则（§6.3/6.5） |
| U2 | 1 | `process-manager.ts`：onExit 回调反查 `clientToId`；单测（rekey-exit / destroy-no-notify） | 根因修复（§6.4），与 U1 同文件耦合面小但接口耦合，串行 |
| U3 | 2 | `session-service.ts`：`ensureActive` exited 校验 + `getClient` 注释 + `restoreSession` not-found 文案恢复指引；单测 | 纵深防御（§6.6）+ 终结语义可见性（§6.9），独立可验收 |
| U4 | 3 | 验证：单测全绿 + 三连 + V1-V5、V3b dev 实测（browser-automation 连 9222）+ 日志断言 | 三视角缺一不可（TEST-STRATEGY §3） |

每个开发单元验收标准：对应单测通过 + `pnpm extensions:typecheck` 不受影响（不涉及 extensions）+ 从 `packages/runtime` 目录跑 vitest 全绿。U4 验收标准：§8.2 全表通过 + 修复过程发现的偏差回写设计文档。

## 11. 待验证检查点

1. **V8 引擎下 exit 事件与 stream error 的时序**：stream error handler 里同步 `proc.kill('SIGKILL')` 后 exit 事件的到达时机（实现期用单测验证「exit 通知恰好一次」即可，不依赖时序假设）。
2. **`session.exited` 在 MessageBus 清理前发布**的既有顺序约束（`session-service.ts:216-221` 注释）——修复不触碰该顺序，但 V1-V3 实测确认 toast/错误消息必达。
3. **fork 路径死亡**：本设计推理其行为与 restore 路径一致（无 rekey，`createForkedSessionFile` 生成的 `forkedId` 直接传 `createSession`，无后续 getState/rekey），V4 只实测 restore 路径；fork 路径由 process-manager 单测（rekey-exit / destroy-no-notify）覆盖 createSession 原语义分支，端到端正确性由 V4 回归保证（restore 路径已验证，fork 同构）。
4. dev 实测中 `MiMo-V2.5-Pro`（注意非 `mimo-v2-pro`，已下架）的可用性——若 provider 侧变化导致 spawn 即退，恰好构成 §5.2 失败路径的实测样本。

## 12. 实施与验收结果（2026-08-20 回写）

实施 commit：`baafd553e`（Wave 1 传播链）、`61d2d63fe`（Wave 2 消费端防御）、`0e3052b20`（实测发现的前端缺口补修）。单测：runtime 全量 268 files / 3104 tests、core 952、renderer 3055 全绿；tsc / vue-tsc / lint 全过。

### 12.1 实测结果对照

首轮实测（V1-V5 + V3b + 二次死亡，共 7 次 kill -9）：

| 场景 | 结果 | 说明 |
|---|---|---|
| 修复核心断言（真实 piSessionId 的 exited 日志） | PASS | 7/7 次全部为 uuidv7 真实 id，零 tempId；pi tee 日志死亡时刻停止增长 |
| V3b 首 turn 无文件死亡（终结语义） | PASS | toast 3ms 级到达、session 消失、无残留进程、新建 session 恢复可用 |
| V5 正常流程回归（删除） | PASS | 无 PROCESS-LEAK-RISK、无残留 pi |
| V1/V2/V3/V4 | PARTIAL（后转 PASS） | runtime 层全过；失分点全部来自下述两个前端缺口，补修后复测 4/4 PASS |
| 僵尸 session 核心症状 | 已消除 | 死后发消息不再报 `pi process is not running`，respawn 后对话可继续 |

补修（`0e3052b20`）后复测 4/4 PASS：dead 占位 UI + 「重新打开」按钮可达且持续保持（90s+ 不被 config.sessions 覆盖）、respawn 后回复实时流式显示（不卡「进行中」）、同 session 二次死亡 dead UI/错误消息再次出现、正常对话零回归（无重复消息/无渲染报错）。

实测还确认一个优于设计的路径：**侧栏点击 dead session 即自动 revive**（runtime 侧 ensureActive → restore 链路），「重新打开」按钮与它等价，双入口可用。

### 12.2 实测发现并已修的两个前端缺口（设计盲区，回写）

1. **dead 态被列表刷新覆盖**：onSessionExit 回调先 publish `session.exited`（前端 markDead）随后 broadcast `config.sessions`（磁盘 outcome），数十 ms 内 dead 被冲回 done/stopped，§5.1 的 dead 占位 UI 实际不可达——§6.7#6 与 §3.1 对「前端 dead UI 已有」的判断在「到达后保持」这一环不成立。修复：前端 `setGroups` 保留已知 dead 态，仅显式 revive 清除。
2. **respawn 后事件订阅断裂**：死亡时服务端 `bus.clearSession` 清订阅集合，但客户端三层订阅簿记（模块级 unsub map / subscriptionStates / in-flight 去重）不清，respawn 后 `ensureStreamSubscription` 幂等 no-op，新 turn 全部 `message.*` 事件丢失（回复已生成但 UI 卡「进行中」；二次死亡无感知）。§6.7#6「respawn 后前端 postLoadSession 重新订阅 | 已有机制覆盖」判断不成立——postLoadSession 确实调用，但幂等短路。修复：`handleSessionExited` 内 `invalidateStreamSubscription` 清三层，下次 ensure 重发 subscribe（message-bus subscribe 已核实为 Set 幂等语义，重订阅无副作用）。

### 12.3 登记的 follow-up 缺口（本设计范围外，未修）

1. **respawn/restore 后新 turn 持久化到 tmpdir 副本而非原 session 文件**（中等，数据丢失面）：`restoreSession` 拷贝原 JSONL 到 tmpdir 后 `switchSession(tmpFile)`；pi 的 `_setSessionFile` 会把 sessionFile 直接切到 switch 目标路径（pi 源码 session-manager.ts:908/926 `preserve explicit path` 语义），后续 flush 写到 tmpdir 路径（unlink 后重建），原 session 文件不增长——respawn 后的新 turn 在应用重启后丢失。**既有行为**（restoreSession 的 tmpdir 隔离设计引入以来如此，非本设计引入），正常冷启动 restore 同样受影响。正确修法需重新评估「switchSession 直接用原文件路径」当初的保守前提（「pi 写回行为未确认」现已确认：pi 就是写回 switch 目标），独立立项。
2. **`session.exited` 错误消息不持久**（轻微）：死亡时插入聊天流的错误消息是 renderer 本地态，revive 后被文件历史覆盖消失；感知链路实际依赖 dead UI + toast。
3. **侧栏无 dead 视觉标记**（轻微）：dead 态只在主区占位体现，列表项与正常 session 无区别。
4. **`[rename-session] model not available, skipping` 以 ERROR 级刷日志**（轻微，extension 降噪）。

## 附录：变更历史

- v1（2026-08-20）：初版。基于 handoff（fix-subagent-workflow-sidebar-sync worktree 的 E2E 发现）+ 本仓代码复核；修正 handoff「runtime 无 respawn 逻辑」的判断为「传播链断裂」（§3.2 失败模式 A）。
- v2（2026-08-20）：第一轮对抗式审查（0 must-fix / 6 suggestion）修复：V1 通过标准证伪化、`proc.kill()` 与 `this.kill()` 区分警示、wave 依赖关系精确化（pi-engine.ts 共享编译依赖）、hidden session 覆盖声明、fork 路径验证措辞、onExit 签名变更影响面结论补录。
- v3（2026-08-20）：第二轮对抗式审查（1 must-fix / 6 suggestion）修复：must-fix = 首 turn 无文件死亡的状态组合——新增 §6.9 显式裁决「session 终结语义」（被否审查者建议的写文件/留 dead 条目两方案，理由：HISTORICAL 规则 #6 / 与目标 3 矛盾）+ V3b 验收场景 + not-found 错误恢复指引；suggestion：start() 失败与 exitCallback 的 no-op 时序说明、exitCallbacks 命名消歧、ensureActive 影响面声明（未覆盖入口清单）、SIGKILL 附带修复 scope 声明、stream error 单测断言措辞对齐 mock 层、接口契约变更标注。
- v4（2026-08-20）：第三轮对抗式审查（1 must-fix / 6 suggestion）修复：must-fix = v3 引入的 V3b「再发 prompt」验收不可执行（session 从 list 消失后 composer/dead UI 均不可达）——改为「新建 session 正常对话」恢复路径 + SESSION_NOT_FOUND 文案改由单测断言覆盖；suggestion：§6.9 补前端 Panel 实际渲染分析（isSessionDead 依赖 list 命中，终结态 dead UI 不可达）+ 用户首条 prompt 丢失显式裁决、toThrow 子串兼容性说明（两个既有测试）、§6.6 补 setThinkingLevel、V3b 补未 flush 判定手段与 ps 检查命令、文案消费点说明。
- v5（2026-08-20）：实施完成，新增 §12 回写：实测结果对照（runtime 层 7/7 全过、复测 4/4 PASS）、两个实测发现的前端缺口（dead 态覆盖 / 订阅断裂，已修）与设计盲区反思、follow-up 登记（tmpdir 持久化缺口等 4 项）。第四轮审查 0 must-fix / 0 suggestion 收敛。
