# Code Review — pi-protocol-real-contract

## 审查范围
- commits: W1 `e1a74ef4` + W2 `1c561f6e`
- 审查方式：对抗性 reviewer subagent，逐行对照 pi 源码（AgentEvent/AgentSessionEvent/AgentToolResult/pi-ai Usage 类型）

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 | 状态 |
|------|------|--------|------|------|
| 类型契约 | PiUsage 字段名用 xyz-agent 命名(inputTokens)而非 pi 命名(input/output/cacheRead/cacheWrite/totalTokens)。pi-protocol 应镜像 pi 源码字段名，翻译在 event-adapter 做。这是 handleAgentEnd 必须 `as unknown as` 的根因。 | should_fix | pi-protocol.ts:514-518 | **已修**（commit 1c3ece7e） |
| 类型契约 | PiAgentEndEvent 漏 willRetry: boolean（pi AgentSessionEvent agent_end 有此字段） | should_fix | pi-protocol.ts:102-106 | **已修** |
| 类型契约 | PiToolExecutionUpdateEvent.partialResult 声明 string，实际 pi 发 any（可能是 string 或 AgentToolResult 对象）。handler 已按两种形态处理但类型未对齐 | should_fix | pi-protocol.ts:276-281 | **已修**（改 unknown） |
| 业务逻辑 | tool_execution_end.args 是幽灵字段——pi 源码从不在此事件发 args。event-adapter:159 读它提取 write content 是历史 bug，应移到 handleToolExecutionStart（有 args） | should_fix | event-adapter.ts:158-163 | **已修**（删 args 字段 + writeContent 标已知限制 TODO） |
| 类型安全 | handleAgentEnd/handleMessageStart 用 `as unknown as` 双重断言，暴露 PiAgentEndMessage/PiMessageStartEvent.message 契约声明过窄。修好 PiUsage 字段名后这些断言可移除 | should_fix | event-adapter.ts:184,442 | **已修**（PiUsage 对齐后删 usage 强转；超契约字段保留 as + 注释） |
| 测试 | event-adapter-gui.test.ts makeToolEndEvent 缺必填 isError 字段，靠 as PiEvent 绕过 tsc | should_fix | event-adapter-gui.test.ts:37-44 | **已修**（补 isError: false） |
| 测试 | U1-U3 是 shape smoke test，非真正契约字段对齐验证 | low | pi-protocol-contract.test.ts | 可接受 |
| 代码规范 | ADR-0033 说"强类型契约"，handler 注释说"动态协议宽窄混合"——措辞矛盾（修好上述后注释应更新） | low | event-adapter.ts:181-183 | 待修 |
| 类型安全 | PiExtensionUiRequestEvent 索引签名 [key:string]:unknown 过宽，窄化名存实亡（历史遗留） | low | pi-protocol.ts:441 | 不阻断 |
| 类型安全 | DISPATCHER .set() 处 16 处 as Handler 断言——TS 逆变标准处理，运行时安全 | 无问题 | event-adapter.ts:654-670 | — |

## plan 覆盖核对
- W1 changes[0-3]: 全部已落地（10 事件类型补全 + 字段修正 + 注释清理 + ADR）
- W2 changes[0-4]: 全部已落地（删 shadow + 窄入参 + 删双读 + attach cast + NULL_EVENTS）
- 覆盖率: 9/9

## 结论
- must_fix: 0（tsc exit 0，1307 测试全绿，运行时无回归）
- should_fix: 6 已全部修复（commit 1c3ece7e），2 个 low 不阻断
- 可进入 test 阶段
