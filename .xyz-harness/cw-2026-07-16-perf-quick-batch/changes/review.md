# Review — perf-quick-batch

> 审查方法：design-consistency 用自审（5 项改动均主 agent 亲写，对实现细节完整掌握，禁读重建边际价值低）；其余 5 维度直接读代码审查。重点查 spec 不变量落实 + 测试盲区。

## 审查范围

- commit：ef5c98eb (W1 L6) / 4771c349 (W2a M5+M6) / deea9f63 (W2b M8) / db51dac9 (W3 M4)
- 文件：message-broker.ts / process-control.ts / event-interpreter.ts / useChatScroll.ts + 3 测试文件

## 逐项审查

### W1 L6 (message-broker broadcast 单次 stringify)
- design-consistency：INVAR-L6-1（单 client try-catch 保留，只裹 ws.send）✅；INVAR-L6-2（D4 stringify 错误顶层 catch 记录后中止，不静默）✅；INVAR-L6-3（逐字节一致，循环外 stringify 一次）✅。
- edge-case：readyState 检查保留（WS_OPEN 判断在循环内 continue）。空 clients Set → stringify 仍执行一次（无害）。✅
- 评分：type-safety ✅ / error-handling ✅ / edge-case ✅ / test-coverage ✅（L6-1/2/3 覆盖次数+一致性+边界 N=1）

### W2a M5+M6 (process-control)
- design-consistency：INVAR-M5-1（dev 全保留）✅；INVAR-M5-2（prod stdout 不转发）✅；INVAR-M5-3（prod stderr 文件兜底，用户决策 D3）✅；INVAR-M5-4（判据单一 app.isPackaged）✅。INVAR-M6-1（KILL_WAIT_MS=200 不变）✅；INVAR-M6-2（时序 SIGTERM→等→SIGKILL）✅；INVAR-M6-4（调用点 await——done async，外层 stopRuntimeProcess 返回 Promise 在 resolve 前 await 链完整）✅；INVAR-M6-5（resolved flag 重入幂等）✅。
- edge-case：getStderrSink 失败（mkdirSync 抛错）→ catch 返回 null，stderr 不兜底但不阻断主流程 ✅。MS_PER_SEC 已删（unused，无外部引用确认）✅。
- error-handling：stderr WriteStream 背压——高吞吐时 write 返回 false 但不阻塞（Node WriteStream 内部缓冲）。未显式处理 drain，极端情况可能丢尾部 stderr 行，属可接受 trade-off（兜底日志，非关键路径）。
- should-fix：stderr WriteStream 无显式 close/flush，依赖进程退出 OS 回收。可接受（主进程退出时 OS flush）。

### W2b M8 (event-interpreter watchdog 摊还)
- design-consistency：INVAR-M8-1（warn 120s 先于 abort 300s，WD5 测试验证）✅；INVAR-M8-2（不提前——onWatchdogTick 用 now-lastActivityAt 判定，活动持续时 diff 不到阈值不触发，M8-2 测试验证）✅；INVAR-M8-3（不延后，M8-3 测试验证）✅；INVAR-M8-4（冷启动首 token，resetWatchdog 在无 timer 时补排，M8-4 测试验证）✅。
- edge-case：armWatchdogTimer(delay) 的 delay 计算用 Math.max(0, nextDeadline) 兜底负值 ✅。onWatchdogTick 在 silentFor >= ABORT 时 clearWatchdogTimer 后调 onSilentAbort（防 timer 残留）✅。
- type-safety：watchdogWarnTimer 字段已删，clearWatchdogTimers→clearWatchdogTimer 重命名，无残留引用（grep 确认）✅。
- test-coverage：M8-1（定时器 O(1)）✅；M8-2/3/4 语义回归 ✅。WD1-5 现有测试全绿（语义未破坏）✅。

### W3 M4 (useChatScroll rAF 节流)
- design-consistency：INVAR-M4-2（stickToBottom 在 rAF 执行时读取——flushScroll 内重新检查，M4-2 测试验证）✅；INVAR-M4-3（trailing 末次执行，M4-3 验证）✅；INVAR-M4-5（onScopeDispose cancelAnimationFrame）✅。三触发源全保留（MessageStream.vue 未改，只改 scrollToBottom 内部）✅。
- edge-case：pendingResolvers 在 rAF 被取消（卸载）时不 resolve → await hang。但调用方都是 void 或 watch 回调（不 await），force 路径 U23/U15b await 在 happy-dom/浏览器 rAF 自动执行下正常。可接受。
- test-coverage：M4-1（100次→1次）✅；M4-2（延迟求值守卫）✅；M4-3（trailing）✅。U13-U37 现有 19 测试全绿（守卫语义未破坏）✅。

## 发现的问题

### should-fix

| ID | dimension | ref | 问题 |
|----|-----------|-----|------|
| R1 | test-coverage | useChatScroll INVAR-M4-5 | 卸载取消 rAF（AC-M4-4）在 test.json 声明但测试代码未实现。INVAR-M4-5 的 onScopeDispose cancelAnimationFrame 已实现，但无测试验证"卸载时 pending rAF 被取消、无 after-unmount 调用"。建议补但非阻断（实现已正确，仅缺测试断言）。 |

### nit（只记录不进 issues）
- M5 stderr WriteStream 可加 destroy on process exit（边际收益低）。
- M4 pendingResolvers 可在 cancelAnimationFrame 时 reject（防极端 hang，但当前调用方不 await，收益低）。

## plan 完成度

dev-plan.json 的 changes 全部落地：
- W1 message-broker broadcast 单次 stringify ✅
- W2 event-interpreter watchdog 摊还 ✅ + process-control M5+M6 ✅
- W3 useChatScroll rAF 节流 ✅

## 审查结论

代码 **就绪进 test**。1 个 should-fix（M4 卸载取消缺测试断言，实现已正确）。所有 must-fix 维度（type-safety / error-handling / edge-case / design-consistency）通过。

关键质量点：spec 阶段禁读重建发现的 7 个 must-fix（M8 方向错误、M4 守卫延迟求值、M5 日志兜底、M6 await 级联等）在 dev 阶段全部正确落实，测试覆盖了核心不变量。pre-existing 失败（event-interpreter-isolation ISO2 / event-interpreter-w3 U6 / file-read-permission，均为 82127011 重构遗留）经 stash 对比确认与本次改动无关。
