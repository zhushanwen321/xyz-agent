# Retrospect — pi-protocol-real-contract

## 做了什么
将 pi-protocol.ts 从「ADR-0003 的宽类型 Record<string,unknown>」深化为「镜像 pi 源码的真契约」：
- PiEvent 联合从 13 扩到 23 个成员，补全 compaction_*/auto_retry_*/thinking_level_changed/queue_update/entry_appended/session_info_changed/agent_settled/extension_error
- PiToolExecutionResult 镜像 pi AgentToolResult（content 含 image 块 + details + addedToolNames + terminate）
- PiUsage 字段名对齐 pi 源码（input/output/cacheRead/cacheWrite/totalTokens，非 xyz-agent 的 inputTokens）
- PiAgentEndEvent 补 willRetry、PiTurnEndEvent 补 message/toolResults、isError 改必填
- event-adapter 删除本地 PiEvent shadow + 15 handler 入参窄化 + 删 4 处防御性双读 fallback
- ADR-0033 推翻 ADR-0003，记录 pi 协议是稳定强类型契约的决策依据

## 做得好的
- **pi 源码核对扎实**：plan 阶段逐行读 pi-mono 的 AgentEvent/AgentSessionEvent/AgentToolResult/Usage 类型定义 + rpc-mode 序列化方式，确认「pi 发出的 JSON 与 TS 类型逐字段一致，无字段重命名」。这是推翻 ADR-0003 的事实基础。
- **对抗性 review 发现了契约深化未完全收敛**：reviewer 逐字段对照 pi 源码，发现 4 处遗漏（PiUsage 字段名 / willRetry / partialResult 类型 / args 幽灵字段），迫使 handleAgentEnd 用 as unknown as 逃逸。修复后契约真正对齐。
- **TDD 类型测试**：用赋值编译检查 + @ts-expect-error 反例验证类型契约，tsc --noEmit 作为权威裁判（vitest 因 esbuild 剥类型在运行时通过，tsc 才是类型契约的真正验证）。

## 做得不好的
- **W1 契约深化只完成 70%**：初次实现漏了 PiUsage 字段名对齐（用了 xyz-agent 命名而非 pi 命名）、willRetry、partialResult 类型、args 幽灵字段。ADR-0033 声称"真契约"但 handler 仍需 as 逃逸——名不副实。根因：写 plan 时虽读了 pi 源码事件类型定义，但没逐字段核对既有事件（agent_end/usage）的字段名，只关注了新增事件类型。**教训：深化既有契约时，既存字段的字段级核对比新增类型更重要。**
- **tool_execution_end.args 幽灵字段是历史 bug 的发现**：event-adapter 读 `event.args` 提取 write content，但 pi 从不在 tool_execution_end 发 args（只在 start 发）。双读时代 `args ?? input` 也拿不到。writeContent 恒 undefined——这是历史遗留死代码，本次标 TODO 保留（迁移到 start 是另一个改动）。**教训：删双读 fallback 时要追踪每个字段的实际来源事件，发现"字段从哪来"与"在哪读"不匹配是 bug 信号。**

## 关键决策
- **ADR-0003 推翻依据**：ADR-0003 说"pi 发送 PiEvent 联合之外的事件"=pi 协议不稳定。实际核对发现这些事件完全在 AgentSessionEvent 联合里定义——是 xyz-agent 的 pi-protocol.ts 类型定义滞后，非 pi 不稳定。pi 的类型系统完整，rpc-mode 直接 JSON.stringify 序列化无字段重命名。
- **PiUsage 字段名镜像 pi 而非 xyz-agent**：pi-protocol 是 pi 协议的契约，应镜像 pi 源码字段名（input/output）。翻译成 xyz-agent 的 inputTokens/outputTokens 是 event-adapter 翻译层的职责。这样 pi-protocol 是纯契约、event-adapter 是纯翻译，职责清晰。
- **tool_execution_end.args 保守处理**：删字段 + writeContent 标 TODO，不迁移到 start。迁移涉及 PiTranslatedEvent 结构变更 + EventInterpreter 消费方调整，范围超出本 topic。
- **handler 内超契约字段的 as 保留**：agent_end.message 含 pi 声明之外的运行时字段（responseModel/diagnostics/errorMessage），这些字段 pi 类型用 `any`/泛型不可静态声明。handler 用 as 提取 + 注释说明，是合理的边界处理（非契约深化失败）。

## 架构影响
pi-protocol.ts 从「近乎 dead module」（408 行类型仅 message-converter 用 2 个）变成「真契约」：
- event-adapter 15 handler 入参用窄类型，字段访问编译期校验
- 删除 4 处防御性双读 fallback（pi 从不发 output/input/payload）
- pi 升级时新增事件类型 → 编译器 exhaustive check 提示（leverage）
- ADR-0033 记录决策，ADR-0003 标记推翻

## 代码统计
- 3 个 commit（W1 e1a74ef4 + W2 1c561f6e + review 修复 1c3ece7e）
- pi-protocol.ts PiEvent 联合 13→23 成员，修正 5 处过窄字段
- event-adapter.ts 删 37 行 shadow+注释，15 handler 窄化，删 4 处双读
- 测试：runtime 99 文件/1307 passed，tsc exit 0
- ADR-0033 新建，ADR-0003 标记推翻
