# Code Review — close-rpc-escape-hatch

## 审查范围
- commits: 4 个（W1 `d788b4ff` + W2 `6ffaca5c` + W3 `06684876` + W3 修正 `7a6ef75d`）
- 审查方式：1 个对抗性 reviewer subagent（完整 diff 逐行对照 + pi 源码核验 + bridge 扩展源码核验）

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 | 状态 |
|------|------|--------|------|------|
| 业务逻辑 | bridge:event 的 response=null 经 sendExtensionUiResponse 发 {cancelled:true}（旧代码发 {response:null}），格式变化 | should_fix | bridge-handler.ts:61 | **已修**（commit 7a6ef75d 加注释标注，pi bridge 扩展 void 丢弃响应无功能影响） |
| 业务逻辑 | getHistory 消费方残留 `result.data?.messages ?? result.payload?.messages` 死代码（sendCommand 已内部归一） | should_fix | session-service.ts:298-300 | **已修**（commit 7a6ef75d 简化为 `result.data?.messages ?? []`） |
| 测试覆盖 | U7（IPiEngine 不暴露 sendCommand）无显式编译期测试，靠 tsc 全量隐式覆盖 | nit | — | 可接受（tsc --noEmit EXIT 0 是有效验证，且 mock 用 `as unknown as IPiEngine` 故不报错） |
| 测试覆盖 | U6（bridge 不再 await）无 fake timer 回归测试（若误改回 await void 仍过） | nit | bridge-sync/reconnect.test.ts | 可接受（sendExtensionUiResponse 返回 void，await void 无害） |
| 代码规范 | 4 个测试文件 mock 残留 sendCommand/sendRaw/SendCommandFn 死字段 | nit | session-service/session-service-w3/data-flow/server-extension.test.ts | 不阻断（因 `as unknown as IPiEngine` 双断言，tsc 不报错；后续清理） |
| 代码规范 | W1 plan 要求 sendCommand/sendRaw 改 private，实际保持 public | nit | rpc-client.ts:272,286 | 语义目标达成（W2 从 IPiEngine 删了声明，外部类型层面无法访问），tsc 全量通过 |

## plan 覆盖核对

### W1（4/4，2 个字面未落地但语义达成）
- [x] changes[0] sendCommand 归一：落地（rpc-client.ts resolve handler）。sendCommand/sendRaw 改 private：字面未落地（保持 public），但 W2 从 IPiEngine 删声明后语义达成
- [x] changes[1] compact/getCommands/getSessionStats 删 readRpcData 改 .data：落地
- [x] changes[2] 新增 switchSession/getState/sendExtensionUiResponse：落地
- [x] changes[3] sendRaw 改 private：同 changes[0]，字面未落地语义达成

### W2（2/2 全落地）
- [x] changes[0] IPiEngine 删 sendCommand/sendRaw + 加 3 语义方法：落地
- [x] changes[1] 删 readRpcData/readPiState/PiRpcResponse/PiStateResponse + 更新注释：落地

### W3（4/4 全落地）
- [x] changes[0] bridge-handler 7 处迁移 + catch 简化：落地
- [x] changes[1] extension-message-handler 删 buildExtensionUiResponse + 2 处迁移：落地
- [x] changes[2] session-lifecycle readPiState→getState + 2 处 switchSession：落地
- [x] changes[3] session-service readPiState→getState：落地

## 关键正确性核验（reviewer 逐项确认）
- sendCommand 归一 `data === undefined && payload !== undefined`：data 优先 payload 语义正确
- sendExtensionUiResponse 四分支优先级（null > bridge对象 > confirm > value）：confirm response=false 不误判 null
- bridge:sync/tool_execute/intercept/default/error 的 {response} 包裹格式与旧代码一致（对象+无method→分支2）
- bridge-handler 7 处全部不 await（修复白等 60s bug 确认）
- switchSession 返回 Promise<void>：调用方不依赖返回值
- getState 返回类型：消费方 as 窄化是 pi 动态响应的既有模式

## 结论
- must_fix: 0
- should_fix: 2（均已修）
- nit: 4（不阻断）
- plan 覆盖率：10/10 changes（W1 的 private 字面未落地但语义达成）
- runtime 99 文件/1298 测试全绿，tsc EXIT 0
- **可进入 test 阶段**
