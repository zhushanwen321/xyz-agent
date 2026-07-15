# Code Review — error-handling-robustness

> 对抗性审查。结论先行：修复方向正确，多数核心路径（watchdog 阈值 / compact 互斥 / 瞬态收口 / 半活清理）实现质量高、注释扎实；但有 **2 个 must_fix（含 1 个回归测试失败、1 个类型检查失败）**，以及若干 plan 条目未落地。

## 审查范围
- base: `e60633c4`
- commits: `5057740c`(W7-electron) `544ca0aa`(W1+W2-runtime) `78813d2d`(W2+W5-electron) `80a6ca60`(W1+W3+W4+W6-renderer) `02174a6c`(W3+W6-runtime)
- 27 files changed, +1134 -116

## 验证手段
- 逐 commit 读 diff（`git show`）
- 类型检查：`apps/electron && npx tsc --noEmit`（**报错**）；renderer `vue-tsc`（测试文件被 tsconfig 排除，不报）
- 测试执行：runtime `1396 passed`；electron-main `76 passed`；renderer **`35 failed`**（其中 1 个为本次回归，见 F1）
- 在 base `e60633c4` 复跑 useChat.test.ts：`25 passed` → 确认回归由本次引入
- 读 4 份设计文档（A2/A4/A5/A6）逐条核对 plan 落地情况

---

## 发现的问题

| # | 维度 | 问题 | 严重度 | 位置 |
|----|------|------|--------|------|
| F1 | 测试覆盖 | **W6 streaming 超时 24h→10min 的改动未更新旧测试，回归失败**。`useChat.test.ts:250-264` 仍断言 `advanceTimersByTime(86_399_000)` 后 `isGenerating===true`，但 W6 已把 `DEFAULT_STREAMING_TIMEOUT_MS` 改为 600_000，推进 86_399_000ms 时消息早已在 10min 处被 timer finalize，`isGenerating` 实际为 false，断言失败。W6 新增了 `chat-streaming-timeout.test.ts` 锁定新行为，却没改/删旧的 24h 断言。base 通过、HEAD 失败 → 引入回归。 | must_fix | `packages/renderer/src/__tests__/useChat.test.ts:250-264` |
| F2 | 类型安全 | **失效的 `@ts-expect-error` 导致 tsc 报 TS2578**。`supervisor-health-liveness.test.ts:28` 注释「W5 待创建模块，当前不存在（红灯预期）」，但 `liveness-probe.ts` 已创建并导出 `checkHealthEndpoint`/`LIVENESS_FAIL_THRESHOLD`，被抑制的错误已不存在 → tsc 报 `TS2578: Unused '@ts-expect-error' directive`。electron tsconfig `include: ["main/**/*.ts"]` 含测试文件，`strict: true` → CI 类型检查会失败（vitest 用 esbuild 剥类型所以测试本身能跑过，掩盖了此问题）。 | must_fix | `apps/electron/main/test/supervisor-health-liveness.test.ts:28` |
| F3 | 边界条件 | **存活探针定时器漏调 `.unref()`**。设计文档 A6 §3.4 与测试策略明确要求「断言 livenessTimer.unref() 被调」，`LivenessMonitor.start()`（`liveness-probe.ts:107-111`）`this.timer = setInterval(...)` 后未调 `this.timer.unref()`。后果：30s 周期的 setInterval 会阻止 Electron main 进程正常退出（如 app.quit 期间若 supervisor 未先 stop，定时器句柄延长进程存活）。supervisor 的 `stop()`/`destroyAll()` 会清 timer，但 quit 竞态窗口下仍有泄漏风险。 | should_fix | `apps/electron/main/supervisor/liveness-probe.ts:110` |
| F4 | 业务正确性 | **watchdog WARN 广播的 payload 与前端消费契约不匹配，用户永远看不到「长时间无响应」**。WARN 分支（`event-interpreter.ts:380`）广播 `{ sessionId, kind: 'silent' }`，但前端消费侧 `chat-message-effects.ts:241-248` 读的是 `readString(payload, 'content') ?? 'Stream error'`——payload 里没有 `content` 字段，恒降级为字面量 `'Stream error'`，`kind:'silent'` 的语义被丢弃。根因：`message.stream_error` 只在 `ServerMessageType` 联合里有（`protocol.ts:234`），**未进 `ServerMessageMap`**（`protocol.ts:424` 的兜底把它当成 `Record<string, unknown>`，故 runtime 构造侧无字段校验）。WARN 的设计目的（A2 §3.2「前端可显示长时间无响应提示」）未达成。修法二选一：(a) 统一 payload 形状为 `{sessionId, content}` 并在 Map 收紧类型；(b) 前端按 `kind` 分支文案。 | should_fix | runtime: `packages/runtime/src/services/session/event-interpreter.ts:378-385`；renderer: `packages/renderer/src/stores/chat-message-effects.ts:241-256`；类型: `packages/shared/src/protocol.ts:234`（补 Map 条目） |
| F5 | 边界条件 | **watchdog 在 session 中途销毁（无 agent_end）时不清理**。设计文档 A2 §3.3 把「session 销毁 → clearWatchdog(sessionId)」列为生命周期事件之一。当前 `clearWatchdog` 只在 `handleTurnEnd`（agent_end 正常路径）和 ABORT 触发时调（`event-interpreter.ts:341,372`）。若 session 在 turn 进行中被 destroy（用户关窗/运行时主动关闭 session）且 pi 未发 agent_end，`watchdogTimer`/`watchdogWarnTimer` 泄漏（Node `setTimeout` 持有引用，阻止 GC 并可能在之后误触发 abort→abort 一个已销毁的 session）。`SessionService.destroyAll`/`delete` 未通知 interpreter。 | should_fix | runtime: `packages/runtime/src/services/session/session-service.ts:485 destroyAll`、event-interpreter 销毁钩子 |
| F6 | 测试覆盖 | **compact 互斥（isCompacting）核心路径无测试**。W3 的关键改动——sendPrompt 预检 `isGenerating || isCompacting` 拒绝、compact 用 try/finally 置 `isCompacting`——在 runtime 测试侧只更新了 mock 字段（`message-dispatcher-precheck.test.ts:37` 加 `isCompacting: false`），**没有任何用例断言 isCompacting=true 时 sendPrompt 被拒 / compact 抛错时 isCompacting 复位**。renderer 侧 `chat-transient-reset.test.ts` 覆盖了断连清 compacting，但 runtime 的互斥/finally 契约（U6）无保护，回归无网。 | should_fix | `packages/runtime/test/message-dispatcher-precheck.test.ts`（缺 isCompacting=true 拒绝用例 + compact finally 复位用例） |
| F7 | 测试覆盖 | **watchdog 的 WARN 后活动事件复位、session 销毁清理无测试**。`event-interpreter-watchdog.test.ts` 覆盖 WD1-WD5（正常 turn / 工具执行 / 静默 ABORT / agent_end clear / WARN 先广播），但缺：(a) WARN 广播后再来 text_delta → `watchdogWarned` 复位为 false、下一轮 WARN 能再次广播（验证 `scheduleWatchdog` 的 warned 复位）；(b) session 销毁场景（对应 F5）。设计文档 §6 测试策略明确列了这两项。 | should_fix | `packages/runtime/test/event-interpreter-watchdog.test.ts` |
| F8 | plan 覆盖 | **W4「scheduleReconnect 重连上限 setFailed」未落地**。设计 A4 §3.3 明确要求 `scheduleReconnect` 加 `MAX_RECONNECT_ATTEMPTS=20` / `MAX_RECONNECT_DURATION_MS=60s`，达其一调 `setFailed()`。当前 `ws-client.ts:186-196` 仍是无上限的指数退避，永远在 reconnecting 态循环（端口被占/URL 非法等不可恢复错误永不进 failed 态）。commit message 声称 W4 已做，但代码只做了 fast-fail（send 返回 boolean）和 visibility 重连，重连上限漏了。 | should_fix | `packages/renderer/src/lib/ws-client.ts:186-196` |
| F9 | plan 覆盖 | **W4「useSidebar onConnected 补 extensionApi.scan()」未落地**。设计 A4 §3.4 要求重连分支补拉 extensions（唯一非 server-push 同步的段）。`useSidebar.ts:509-518` 的 `onConnected` 重连分支只有 `void workspaceStore.load()`，无 `extensionApi.scan()`。后果：runtime 重启早于首次 extensions 扫描完成时断连，重连后 extensions 列表 stale 不补发。 | should_fix | `packages/renderer/src/composables/features/useSidebar.ts:509-518` |
| F10 | plan 覆盖 | **W1「MermaidRenderer 失败保留上次 SVG」未落地**。设计要求 mermaid 渲染失败时保留上一次成功 SVG（而非显示错误占位）。`MermaidRenderer.vue` 未改动（diff 为空），失败时 `status==='error'` 仍显示「渲染失败 + 源码」占位（`MermaidRenderer.vue:22-38`），上次 SVG 丢失。属 should_fix 级别降级项。 | should_fix | `packages/renderer/src/components/panel/message-stream/MermaidRenderer.vue` |
| F11 | plan 覆盖 | **W1「useExtensionUI respond 出队时机」未落地**。`useExtensionUI.ts:85-91` 未改动，当前实现先 send 再 splice 出队——若 send 抛错则不出队（与 plan 意图一致，可能已认为现状可接受），但无对应测试锁定该不变量。 | nit | `packages/renderer/src/composables/useExtensionUI.ts:85-91` |
| F12 | 代码规范 | **commit scope 蔓延：W3+W6 commit 夹带 getAgentCallHistory 重构**。`02174a6c` 标题是「compact 互斥 / pi-watchdog」，但 `session-service.ts` 的 `getAgentCallHistory` 从「全局 scan」重写为「按 mainCwd 定位 subagent 目录 + findAgentCallFile + fail-fast throw」（+77 行），与 compact/watchdog 完全无关。实现本身质量好（有专门测试 `session-service-agent-call.test.ts` 覆盖 3 个 throw 路径，调用方 workflow.ts 有 fail-fast 契约），但应独立 commit 或写入 message。 | nit | `packages/runtime/src/services/session/session-service.ts:346-391`（commit 02174a6c） |
| F13 | 类型安全 | 失效的 `@ts-expect-error`（2 处，不阻塞 CI 但属过时文档）：`chat-streaming-timeout.test.ts:37`（`DEFAULT_STREAMING_TIMEOUT_MS` 已导出）、`chat-transient-reset.test.ts:131`（`resetTransientStates` 已在 store API）。renderer tsconfig 排除 `__tests__`，故不报错，但注释已与实现不符，误导后续维护者。 | nit | `packages/renderer/src/__tests__/chat-streaming-timeout.test.ts:37`、`chat-transient-reset.test.ts:131` |

### 维度小结
- **业务逻辑正确性**：核心路径正确。watchdog 两级阈值（WARN 120s / ABORT 300s）实现准确、活动事件定义合理、agent_end 正常清除到位；compact 互斥 try/finally 覆盖成功/失败/抛错全路径；瞬态收口 candidateSids 并集遍历完整（messages ∪ compacting ∪ retry ∪ queue），未遗漏；visibilitychange 三重守卫（visible / 已连接 / 有 url）幂等性好；handleAgentEnd 空消息降级走 turn-end 路径自洽（会经 handleTurnEnd 复位 isGenerating + clearWatchdog）；forceRestartForLiveness 的 markStopping→stop→reset→scheduleRestart 顺序正确，reset 只清 stopping 不清 restartCount，半活进程不会无限重启。**唯一业务缺陷**：F4（WARN payload 与前端契约不匹配）。
- **类型安全**：`as ServerMessageType` 是项目既有惯例（subagent.stream_delta/session.subagents 同模式），非本次引入的品味问题。`checkHealthEndpoint` 两处同名不同返回类型（health-checker 版 `boolean` / liveness-probe 版 `{ok,ms?}`）已在 liveness-probe.ts 顶部注释显式说明分工理由，可接受。真问题是 F2（失效 ts-expect-error 阻塞 tsc）。onSilentAbort 签名为 `(payload: {sessionId:string}) => void`，与 index.ts 调用点 `({sessionId: sid}) =>` 匹配，类型准确。
- **边界条件**：watchdog timer 在 agent_end/ABORT 清除正确；resetTransientStates 经 finalizeSession 幂等（sealed 守卫）；forceRestartForLiveness 重入安全（stop() 先同步 stopLivenessMonitor 再 await kill，setInterval 不会在 kill 窗口期再触发）。**边界缺陷**：F3（liveness unref 缺失）、F5（session 销毁不清 watchdog）。
- **代码规范**：注释密度高、命名清晰、HISTORICAL 注释把「为什么」讲透。chat.ts setup 函数行数因本次增量略增但仍在可接受范围（finalizeAllStreaming/resetTransientStates 抽成独立 helper，未臃肿）。

---

## plan 覆盖核对

### W1（防御补丁）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| server.ts 外层 catch 防御 msg.payload undefined | ❓ 未核 | 本 commit range 未触 server.ts（需单独核 runtime/src/transport/server.ts:222，本次 diff 无此文件） |
| handleAgentEnd 空 messages 降级 | ✅ 已落地 | event-adapter.ts:190-198，降级为 turn-end{error} |
| interpret 循环 per-event try-catch 隔离 | ✅ 已落地 | event-interpreter.ts:134-152 |
| config-service 全局强制目录动态化 getConfigDir | ✅ 已落地 | config-service.ts:39-44 forcedGlobalSkillDir/AgentDir 函数化 |
| useExtensionUI respond 出队时机 | [~] 部分 | **F11**：未改代码，可能视为现状可接受，缺测试锁定 |
| MermaidRenderer 失败保留上次 SVG | ❌ 未落地 | **F10**：文件未改 |

### W2（进程/stream 兜底）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| main.ts unhandledRejection/uncaughtException 兜底 | ✅ 已落地 | main.ts:86-100，log 不 exit（避免 runtime 孤儿） |
| rpc-client stdout/stderr stream 'error' 监听 | ✅ 已落地 | rpc-client.ts:204-213(stdout)/230-235(stderr)，rejectAll + _exited |
| spawn error 入状态机（onExit(-1)） | ✅ 已落地 | process-control.ts:146-152，SPAWN_ERROR_EXIT_CODE=-1 哨兵，onRuntimeExit 已幂等 |

### W3（compact 互斥 + 瞬态收口）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| sendPrompt 预检加 isCompacting | ✅ 已落地 | message-dispatcher.ts:92 |
| compact try/finally 置 isCompacting | ✅ 已落地 | message-dispatcher.ts:229-270，finally 复位 |
| IManagedSessionView 加 isCompacting | ✅ 已落地 | types.ts:37-47 + 所有 mock 同步 |
| finalizeAllStreaming 扩展瞬态收口 | ✅ 已落地 | chat.ts resetTransientStates + candidateSids 并集 |
| compact 互斥测试 | ❌ 未落地 | **F6**：runtime 侧无 isCompacting 互斥/finally 测试 |
| getAgentCallHistory 重构 | ⚠️ scope 蔓延 | **F12**：与 W3 无关，质量好但应独立 commit |

### W4（WS 生命周期）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| useConnection visibilitychange 主动重连 | ✅ 已落地 | useConnection.ts connectWs + visibilityHandler，三重守卫 + teardown 配对 |
| ws-client send 返回 boolean | ✅ 已落地 | ws-client.ts:166-182，有 ws-client-send-boolean.test.ts |
| transport.send 透传 boolean | ✅ 已落地 | transport.ts:32-37 |
| scheduleReconnect 重连上限 setFailed | ❌ 未落地 | **F8**：仍无上限 |
| useSidebar onConnected 补 extensionApi.scan() | ❌ 未落地 | **F9** |
| api/domains/* 调用方适配 fast-fail reject pending | ❓ 未核 | diff 未见 api/domains 改动，可能未做或已在别处 |

### W5（supervisor 健康）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| waitForHealth 改 HTTP /health | ✅ 已落地 | health-checker.ts checkHealthEndpoint(boolean 版)+waitForHealth(opts)，有 health-checker-http.test.ts |
| start() 半活清理 try/catch + stop | ✅ 已落地 | runtime-supervisor.ts:104-113 |
| 存活探针 LivenessMonitor | ✅ 已落地 | liveness-probe.ts，threshold=3/interval=30s，有 supervisor-health-liveness.test.ts |
| forceRestartForLiveness | ✅ 已落地 | runtime-supervisor.ts:216-226，顺序正确 |
| stop/destroyAll 清 livenessTimer | ✅ 已落地 | runtime-supervisor.ts stopLivenessMonitor |
| isPortInUse 保留 TCP | ✅ 已落地 | health-checker.ts 文档说明分工 |
| livenessTimer.unref() | ❌ 未落地 | **F3** |

### W6（pi watchdog + streaming 超时）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| EventInterpreter watchdog 两级阈值 | ✅ 已落地 | event-interpreter.ts SILENT_WARN_MS=120s/SILENT_ABORT_MS=300s |
| 活动事件 reset / agent_end clear | ✅ 已落地 | message/tool-call-start/end reset，turn-end clear |
| index.ts createAdapter 注入 onSilentAbort | ✅ 已落地 | index.ts:185-190，**用 sessionService.abort(sid)**（非 abortSession），与设计 A2 §5 一致 |
| DEFAULT_STREAMING_TIMEOUT_MS 24h→10min | ✅ 已落地（但回归） | chat.ts:47，**F1 旧测试未更新** |
| watchdog 测试 | [~] 部分 | **F7**：WD1-WD5 有，WARN 后复位 + 销毁清理缺 |
| stream_error payload 契约 | [~] 部分 | **F4**：广播了但前端读不到 kind 语义 |

### W7（Electron 窗口/快捷键）
| changes 条目 | 状态 | 说明 |
|---|---|---|
| shortcut-registry 窗口重建（先 unregister 再 register + 检查返回值） | ✅ 已落地 | shortcut-registry.ts:39-56，warn 被占用 |
| window-factory 幽灵窗口清理（waitForVite 抛错 destroy） | ✅ 已落地 | window-factory.ts:139-161 try/catch + destroy |
| did-fail-load / render-process-gone 监听 | ✅ 已落地 | window-factory.ts:110-124（仅 log） |
| findSessionWindow 清理（window-manager updateState 删除） | ✅ 已落地 | interfaces.ts 删 updateState、window-manager.ts 删实现 |
| render-process-gone 后窗口是否真触发 closed | ⚠️ 设计依赖 | 注释称「崩溃窗口最终会触发 closed」由 window-manager.register 的 win.on('closed') 兜底清理 Map。Electron 对 OOM/crash 通常会关窗触发 closed，但 'cleanexit'（renderer 主动 cleanExit 但不关窗）场景下窗口可能存活而无清理——当前只 log，不 destroy/重载。属可接受的设计取舍（本轮目标就是诊断日志），但留有窗口存活缺口。 |

---

## 结论
- **must_fix：2 个**
  - F1：W6 streaming 超时回归测试失败（改了实现没改旧测试，base 通过 HEAD 失败）
  - F2：失效 `@ts-expect-error` 使 electron `tsc --noEmit` 报 TS2578，CI 类型检查会挂
- **should_fix：7 个**（F3-F10）：watchdog WARN 用户不可见（F4）、liveness unref 缺失（F3）、session 销毁不清 watchdog（F5）、compact 互斥与 watchdog 缺测试（F6/F7）、W4 重连上限 + extensions 补拉 + W1 Mermaid 保留 三项 plan 漏做（F8/F9/F10）
- **nit：3 个**（F11/F12/F13）：scope 蔓延 + 失效注释

**整体评价**：修复方向正确、核心异常路径（watchdog/compact/瞬态收口/半活清理/shortcut 重建）实现质量高、HISTORICAL 注释把决策理由讲得透彻，forceRestartForLiveness 的竞态处理尤其扎实。但收尾有缺口：**2 个 must_fix 都是「实现改了、测试/类型检查没收尾」的工程纪律问题**（非设计缺陷），应立即修；F4（WARN 用户不可见）是唯一影响功能正确性的设计缺陷，建议本轮一并修（补 stream_error 进 ServerMessageMap + 统一 payload 形状）；plan 覆盖约 85%，W4 的重连上限/extensions 补拉和 W1 的 Mermaid 保留明确未做，需补做或在 plan 标记延期。

**建议**：修 F1+F2 后可合；F3/F4/F6 建议同批修（成本低、影响清晰）；F8/F9/F10 若不在本轮范围，需在 dev-plan 显式标记延期并开 follow-up。
