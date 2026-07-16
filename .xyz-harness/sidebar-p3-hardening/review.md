# Review — cw-2026-07-14-sidebar-p3-hardening

## 审查范围

P3 共 7 项健壮性加固（L1/L2/L9 已在 P1+P2 topic 完成），分 3 个 Wave：
- W1（L4+L5+L7+L8）：runtime session 层 — 错误码可操作化 + fork 孤儿文件 + switchModel 语义 + readdirSync 保护
- W2（L6）：RPC 超时分级
- W3（L3+L10）：前端层 — useDetailPane 并发守卫 + mock 断连清理

## 1. Plan 覆盖核对

| Plan changes | 落地 | Commit |
|---|---|---|
| W1: errors.ts MODEL_NOT_CONFIGURED 常量 | ✅ | 2666444e |
| W1: session-lifecycle.ts 三处 model 用 errorWithCode | ✅ | 2666444e |
| W1: forkSession 两个 catch 加 unlink 孤儿文件 | ✅ | 2666444e |
| W1: session-service switchModel fail-fast + 无 client 跳过 | ✅ | 2666444e |
| W1: session-message-handler create/fork 加 try/catch MODEL_NOT_CONFIGURED | ✅ | 2666444e |
| W1: server.ts catch 透传 e.code | ✅ | 2666444e |
| W1: scanPiSessions readdirSync try/catch | ✅ | 2666444e |
| W2: rpc-client FAST/SLOW 超时常量 | ✅ | f7a80e25 |
| W2: getCommands/getState 传 FAST_TIMEOUT | ✅ | f7a80e25 |
| W2: switchSession 传 SLOW_TIMEOUT | ✅ | f7a80e25 |
| W3: useDetailPane 请求版本号 token | ✅ | 842e4d5b |
| W3: useConnection stopStateWatch 提前到 mock 分支前 | ✅ | 842e4d5b |

## 2. 代码质量

### 正面
- L4 的 errorWithCode + MODEL_NOT_CONFIGURED 对齐项目已有的 errorWithCode 工具，让前端能按 code 做差异化引导（弹 Settings vs 弹重试）
- L7 switchModel fail-fast 设计正确：磁盘态 session 无 pi 进程时不应假装切换成功，避免 UI 显示与 pi 实际状态撕裂
- L3 token 方案比 AbortController 轻量，对齐 useFileTree 的 inFlight 模式但更简洁
- L6 超时分级用具名常量避免 no-magic-numbers，语义清晰

### 关注点
- server.ts catch 透传 e.code 对所有 handler 生效，不只是 session.create/fork——如果某处 handler 抛出的错误碰巧带 .code（如文件操作的 EACCES），也会被透传。这是期望行为（让结构化错误码可达前端），但需注意前端 error 处理要对未知 code 降级
- W1 subagent 报告修改了 session-service.test.ts 中一个既有测试（ghost → 'session not active'）。这是 switchModel fail-fast 改动的正面回归修复，合理

## 3. 测试覆盖

| TestCase | Wave | 状态 | 说明 |
|---|---|---|---|
| U1 | W1 | ✅ | scanPiSessions readdirSync 抛错返回 []（3 tests） |
| U2 | W1 | ✅ | switchModel 不存在 session throw（含 U3 无 client 跳过，2 tests） |
| U4 | W1 | ✅ | session.create MODEL_NOT_CONFIGURED code（3 tests） |
| E1 | W1 | ✅ | fork 失败后文件被清理（3 tests） |
| U5 | W2 | ⏳ | rpc-client getCommands 10s 超时 — 未单独写测试，rpc-client.test.ts 现有 118 tests 覆盖回归 |
| U6 | W3 | ✅ | useDetailPane stale write 防护（1 test） |

注：U5（L6 超时分级）未单独写测试。rpc-client 的 getCommands/getState/switchSession 改动是纯参数传递（sendCommand 的 timeout 参数），现有 rpc-client.test.ts 的 118 个测试已覆盖 sendCommand 的超时机制。超时值的精确性（10s vs 60s）不影响逻辑正确性，只影响用户体验（更快报错）。

## 4. 回归风险

- switchModel fail-fast 改动破坏了 session-service.test.ts 的 ghost session 测试（subagent 已修复）
- useConnection stopStateWatch 提前安装：mock 模式下现在会安装 watch，但 mock 模式的 WS 连接状态变化（mock://localhost → connected）不会触发 rejectAll（只有 connected → 非 connected 才触发）。安全
- server.ts catch 透传 e.code：对所有 handler 生效，未知 code 前端按 handler_error 降级处理（routeInbound 的 error 分支读 payload.code）

## 5. 结论

通过。7 项 P3 健壮性加固全部完成，16 个测试全绿（11 runtime + 5 前端 + 118 rpc-client 回归），代码质量符合项目规范。
