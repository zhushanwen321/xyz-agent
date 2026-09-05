# 插件 intercept 注入生产端定案（plugin intercept injection）

> **层声明**：本文档 = 机制层设计；下一层产物 = 可实施的接口/数据模型变更（plugin-sdk 契约 + hook-pipeline 透传 + bridge-interop 映射），拆分见 §5。tech-design 红线 5/6/7（运行时断言/数据流/错误规格）全适用。
>
> **来源**：bridge-rewrite-pi-0.84.md §3.2 登记的上游缺口（「transformedData → injectedMessages 映射未实施，属 01-plugin-hook-fix §5 检查点 2 的未定案空间」；01-plugin-hook-fix 原文档已不在仓内，其未定案空间由本设计收口）。关联：pi-boundary-reliability.md（插件 hook 体系）· bridge-rewrite-pi-0.84.md（承载通道，已落地）。

## 1. 背景目标

**一句话结论**：给插件补上「在 agent turn 前向 LLM 上下文注入内容」的端到端契约——SDK 返回 `injectedMessages`，经 hook-pipeline 透传，由 bridge-interop 映射进 intercept 回包，最终以 pi 原生 CustomMessage 进入 LLM 上下文；同时诚实定案 `blocked` 在 pi 链路的语义边界。

**SCQA**：

- **S（情境）**：xyz-agent 插件系统的 hook 体系有一条 intercept 链路：插件可注册 `onBeforeAgentStart` hook，在每个 agent turn 开始前被调用，可返回 block 决策或数据改写。pi 侧对应能力是 `before_agent_start` 事件的 result 槽位——扩展可返回 `{message?, systemPrompt?}` 向本轮 LLM 请求注入一条 custom 消息。
- **C（冲突）**：承载通道已经打通（bridge 重写 2026-09-05 落地，V6 通道级验收过）：pi 侧 bridge extension 发 `bridge:intercept` → runtime `handleBridgeIntercept` 执行插件 hook → 回包 `{injectedMessages}` → bridge extension 映射为 CustomMessage 注入。但**生产端断开**——runtime 侧 `handleBridgeIntercept` 恒返回 `{injectedMessages: []}`（bridge-interop.ts:258-260 自述：映射未实施），插件 hook 无论返回什么都不产生注入。
- **Q（问题）**：插件「在 agent turn 前注入 LLM 上下文」的能力，端到端契约该怎么定义？
- **A（答案）**：见 §3——SDK hook 返回新增 `injectedMessages` 字段（注入语义，与既有 `modifiedData` 的改写语义分域），管线透传，bridge-interop 映射回包；`blocked` 在 pi 链路不可表达（pi 无 block 槽位），语义边界显式定案为「runtime 侧终止 hook 链 + 留痕，不阻止 turn」。

**系统是什么**（受众假设：会用 xyz-agent 但不懂插件内部机制的开发者）：xyz-agent 是 Electron 桌面 agent 工作台；插件（PluginService 体系，跑在 Worker/沙箱进程）通过 plugin-sdk 注册工具和 hook。hook 分两类：**intercept**（可影响流程，如 `onBeforeAgentStart`）与 **observe**（纯观察，如 `onPiEvent`）。agent 对话由 pi 子进程承载——插件不直接进 pi，runtime（WebSocket 服务）是插件与 pi 之间的中转：pi 侧有 bridge extension（`@zhushanwen/pi-plugin-bridge`）经 select marker 通道与 runtime 往返。

**设计目标**（从插件作者体验倒推）：

- **G1 注入生效**：插件作者在 `onBeforeAgentStart` hook 里返回注入内容后，下一轮 agent 回复可证明内容进入了 LLM 上下文（行为断言，非日志断言）。
- **G2 契约清晰**：注入与改写（`modifiedData`）、阻止（`proceed:false`）三个语义域互不混淆；SDK 类型自解释。
- **G3 失败诚实**：插件返回畸形注入（非字符串/空数组）时有明确的行为（丢弃+留痕，不炸 turn），错误消息指向恢复动作。
- **G4 不倒退**：bridge 通道既有行为零回归（V6 通道级验收过的链路不因生产端接入而变化）。

**In-scope**：plugin-sdk `InterceptorResult` 契约演进；hook-pipeline 的注入透传；bridge-interop `handleBridgeIntercept` 的注入映射与 blocked 语义定案；plugin-sdk 主线程侧 hook 入口（plugin-service.ts）的对应塑形；测试与端到端验收。

**Out-of-scope**：`systemPrompt` per-turn 覆盖能力的开通（pi 槽位已支持，但零调用方需求，减法原则不开通，§3.3-D4 登记）；pi 侧 bridge extension 改动（映射机制已实现并验证，本设计不动）；observe 链路；插件 UI。

## 2. 现状与问题分析

### 2.1 现状：一次注入尝试的完整旅程（今天会发生什么）

以一个最小插件为例——作者想让 agent 每轮回复首行带固定 token（这正是 V6 验收场景的形态）：

```ts
// 插件代码（plugin-sdk @proposed API 面）
sdk.hooks.onBeforeAgentStart(async (ctx) => {
  return {
    proceed: true,
    // 作者期望：把这条指令注入 LLM 上下文
    modifiedData: { inject: '回复首行包含 MY_TOKEN' },
  }
})
```

物理数据流（现状，每一步均已行级核实 ✅）：

```
插件 Worker                 runtime 主线程                          pi 子进程
─────────                 ─────────────                          ─────────
onBeforeAgentStart
返回 {proceed:true,
      modifiedData:{...}}
        └─plugin.hooks.invoke─→ HookPipeline.execute()            bridge extension
                            ({blocked:false,                      before_agent_start
                              transformedData:{...}})             handler 触发
                                  │                               └─bridge:intercept─→
                                  │                          handleBridgeIntercept()
                                  │                          ⛔ transformedData 被丢弃
                                  │                          回包 {injectedMessages:[]}
                                  │                                  │
                                  │                                  ↓
                                  │                          bridge extension 收空数组
                                  │                          → 不注入，turn 照常进行
```

**结论：作者拿到的是沉默失败**——hook 正常执行、无任何报错，注入从未发生。

### 2.2 根因：三个断点 + 一个语义错位

**断点 1（SDK 契约层）**：`InterceptorResult`（plugin-sdk/src/types.ts:418-422）只有 `{proceed, reason?, modifiedData?}`——**没有表达「注入」的字段**。作者只能误用 `modifiedData`（唯一能塞内容的地方）。

**断点 2（管线透传层）**：`HookPipeline.execute`（hook-pipeline.ts:77-127）把 Worker 响应映射为 `HookResult {blocked, blockedBy, reason, transformedData}`——即使 SDK 有了注入字段，`HookResult` 也无处承载。

**断点 3（映射层）**：`handleBridgeIntercept`（bridge-interop.ts:233-261）拿到 `HookResult` 后：`blocked` → 回包 `{blocked:true, reason}`；`transformedData` → **直接丢弃**，恒回 `{injectedMessages:[]}`（:258-260 注释自述）。

**语义错位（为什么不能直接把 transformedData 映射成 injectedMessages）**：`modifiedData → transformedData` 在整个 hook 体系里的既定语义是「**改写当前事件的数据**」——`onAfterToolResult` 用它改写工具输出（D2-3 设计），下游消费方（event-interpreter 等）按此语义读取。而注入是「**新增一条 LLM 上下文消息**」。两个语义域不同：若把 `before_agent_start` 场景下的 transformedData 重新解释为「注入内容」，同一字段跨 hookType 有两种含义，违反契约单一语义。且管线对多插件是**链式覆盖**（`transformedData = result.modifiedData` 取链上最后一个 ✅核实 hook-pipeline.ts:113），注入内容若走此路径，多插件会互相覆盖而非累积——与注入的直觉语义（可叠加）冲突。

### 2.3 pi 侧槽位的真实能力面（契约约束）

pi 0.84.4 `BeforeAgentStartEventResult`（core/extensions/types.d.ts:845-849 ✅核实）：

```ts
{
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">
  systemPrompt?: string   // per-turn 覆盖，多扩展链式
  // ⚠️ 无 block/cancel 槽位
}
```

消费点 agent-session.js:915-939（✅核实）：`result.messages`（含注入 custom 消息）与本 turn user 消息同批进入 context；`result.systemPrompt` 覆盖本 turn。

两个关键约束：

1. **blocked 不可表达**：bridge extension 侧已登记（收到 `blocked:true` 时 log「unsupported by pi result contract」，注入路径照常评估）。也就是说 runtime 今天回包 `blocked:true` 到 pi 是**无效决策**——turn 照常进行。
2. **消息收窄形态**：pi result 机制只有单 message 槽位。bridge extension 已实现的映射（bridge 设计 §3.2 对比三 a，V6 验证）：多条注入收窄为**单条 CustomMessage 的 content 数组**（`content: (TextContent|ImageContent)[]`），消息边界变化对 LLM 上下文等价。

### 2.4 现状调用方盘点

插件 hook 的 `onBeforeAgentStart` 注入能力现状**零真实调用方**（dsh-test playground 插件未用注入——bridge 设计 §3.2 登记项）——契约可以干净定义，无兼容性包袱。既有调用方语义不受影响：`proceed:false`（block）与 `modifiedData`（改写）的行为保持现状。**复核步骤（r1 审查 SG-3）**：本登记是二手链（本仓无 plugins/ 目录），实施前对 dsh-test playground 仓库 grep `onBeforeAgentStart` / `injectedMessages` 直接确认一次（分钟级）。

## 3. 解决方案

### 3.1 终态（插件作者视角）

**成功路径**——注入生效的最小插件：

```ts
sdk.hooks.onBeforeAgentStart(async (ctx) => {
  return {
    proceed: true,
    injectedMessages: ['用户偏好：所有代码注释用中文'],
  }
})
```

实现后：agent 下一轮回复遵守注入内容（若插件注入「回复首行包含 MY_TOKEN」，回复首行即含该 token——行为断言）；pi session 文件里可见 customType 为 `plugin-inject` 的 custom 消息（`display:false`，不渲染进用户对话流——注入面向 LLM 不面向用户）。

多插件叠加：A、B 两个插件各注入一条 → LLM 上下文收到**两条内容**（收窄为单条 CustomMessage 的 content 数组两段，顺序 = hook priority 执行序）。

**失败路径**——插件返回畸形注入：

```ts
return { proceed: true, injectedMessages: '不是数组' as never }  // 或 [{ foo: 1 }]
```

行为：畸形条目被丢弃 + runtime warn 日志留痕（含插件 id 与收到的形状摘要），turn 照常进行（**注入失败不应吃掉本轮 prompt**——与 bridge 侧「回包失败不拦截」的既有语义对称）。日志示例：

```
[plugin-service] drop malformed injected message from plugin dsh-compact-model: entry 0 is not a string ({foo:1})
```

**block 路径（语义定案，非新增）**：插件返回 `{proceed:false, reason}` → runtime 侧 hook 链终止（后续插件不执行）+ 回包 `{blocked:true, reason}` → pi 侧 log 留痕、**turn 照常进行**（pi 无 block 槽位，本设计不改变也不掩盖这一点）。SDK 层 `proceed:false` 对 `onBeforeAgentStart` 的 JSDoc 更新为诚实描述：「终止后续插件 hook 链；当前 pi 集成不阻止 agent turn」。

### 3.2 多方案对比

| | 方案 A：string-only 注入 | 方案 B：结构化注入（旧 bridge 契约 {role, content}） | 方案 C：复用 modifiedData 重载语义 |
|---|---|---|---|
| 形态 | `injectedMessages?: string[]` | `injectedMessages?: Array<{role?: string, content: string \| object}>` | 不加字段，`before_agent_start` 下 transformedData 解释为注入 |
| **长期架构合理性** | 高：注入语义单一（文本进 LLM 上下文）；SDK 面简单自解释；pi 侧 CustomMessage content 数组天然承载（bridge 已支持 string 与 JSON 序列化两种 content ✅核实 forwarding 实装） | 中：`role` 在 pi 链路无去处（CustomMessage 无 role 概念，最终被丢弃或塞进 details）；结构化 content 到 pi 侧也要 JSON.stringify 收窄成 text——结构信息在终点不保留，契约却承诺了它 | 低：同字段跨 hookType 双语义（改写 vs 注入），且链式覆盖语义与注入可叠加语义冲突（§2.2）——审查级缺陷 |
| **短期实现成本** | 低：SDK +1 字段、pipeline +1 透传、bridge-interop +映射（全链路 <60 行 + 测试） | 中：同 A 的改动量，另加形状守卫与 role 丢弃的文档负担 | 最低（不加字段）——但省的成本会在语义债上加倍偿还 |
| **风险** | 结构化内容需作者自己 JSON.stringify（string 化后信息不丢，LLM 可读 JSON 文本） | 契约承诺结构化但终点拍平——作者误以为 role/结构生效，产生「为什么我的 role 没用」类支持负担 | 语义冲突回归：onAfterToolResult 的 transform 读者可能误读 before_agent_start 的返回 |
| **被否反例**（若用它，§2.1 的例子会怎样） | — | 作者注入 `{role:'system', content:'...'}`，期待 system 语义 → pi 侧收窄为普通 text 段，role 静默丢失 → 沉默失败换了个地方 | 作者返回 modifiedData（改写语义）→ 被解释为注入 → onAfterToolResult 同款用法的插件作者看到两个 hookType 下同一字段完全不同的效果 |

**推荐 A（长期方案）**。理由：契约只承诺终点真正保留的东西（文本进 LLM 上下文）；结构化注入的真实需求出现时再演进为 `content: string | object`（届时 pi 侧 bridge 已支持 object 的 JSON 序列化透传，扩展点已留）。B 的 `{role, content}` 形态来自旧 bridge 历史契约，但旧契约的 role 在 pi 0.84.4 链路本就无落地——不复制死语义。

### 3.3 关键决策与权衡

**D1 注入字段定义：`InterceptorResult.injectedMessages?: string[]`**

- 选择：SDK `InterceptorResult` 新增可选字段 `injectedMessages?: string[]`（`@proposed` API 面演进）；`HookResult`（runtime 内部）同步新增同名字段。
- **契约边界显式声明（r1 审查 MF-2）**：`InterceptorResult` 是全部 7 个 intercept hookType 共享的返回类型（plugin-sdk types.ts:392-399），但 `injectedMessages` **仅 `onBeforeAgentStart`（bridge intercept 链路）被消费**——其他 hookType（onBeforeToolCall / onBeforeSendMessage / onAfterToolResult 等）返回该字段类型合法但**被忽略**（已核实各消费点：onBeforeSendMessage 消费点 plugin-service.ts:419-429 与 event-interpreter :406/:468 只读 blocked/transformedData，observe 快捷路径 :734-737 恒返 `{blocked:false}`）。该边界写入 SDK JSDoc；管线对非消费 hookType 返回了非空 `injectedMessages` 时 warn 留痕（与 D5 畸形注入 warn 对称）——防「沉默失败换入口重现」。
- 被否：方案 B/C（见 §3.2）。
- 证据：pi CustomMessage content 数组承载 TextContent（bridge forwarding 实装已支持 string 原生 + 非 string JSON.stringify 收窄——本设计在 SDK 面只开 string，非 string 留给未来演进）；零现状调用方（§2.4，实施前按其复核步骤再确认），无迁移成本。
- 效果：注入与改写/阻止三分域清晰（G2）。

**D2 管线聚合语义：逐插件校验 + 跨插件累积拼接（非覆盖）**

- 选择：`HookPipeline.execute` 的 handler 循环内（r2 审查 MF 修正：**形状守卫在管线层逐插件执行**，聚合前天然持有 pluginId 与条目序号）：每个插件响应到达时先校验 `injectedMessages`——非数组整体丢弃 + warn（含 pluginId + 收到类型，**Array.isArray 判定在 push 之前**，字符串值不会被 spread 拆条）；数组内非 string 条目丢弃 + warn（pluginId + 条目序号 + 形状摘要）；合法 string 条目按 priority 执行序 push 进收集数组（累积拼接），与 `transformedData` 的「链上最后一个」覆盖语义显式区分。
- 被否：链上最后一个覆盖（与 transformedData 同款）——多插件注入会静默互吃，且 block 终止链时被 block 前的注入也被吃掉（语义怪异）；守卫落位 handleBridgeIntercept（聚合后）——聚合产物无插件归属，「warn 含插件 id」不可实现（r2 审查击穿）；注入条目携带 pluginId（改 HookResult 形状）——守卫上移更简（减法）。
- 证据：pi 侧 bridge 映射已支持多条收窄为单条 CustomMessage 的 content 数组（§2.3 约束 2）；注入的直觉语义是叠加（两个插件各注入偏好，都应生效）。
- block 交互定案（r3 审查 MF 补执行顺序与组合行为）：**校验先于 block 判定**——每个插件响应到达的统一处理序：①形状校验（D5 行 1/2，**覆盖所有返回组合**——block 插件的畸形注入同样 warn + 丢弃，G3 无组合限定）→ ②合法条目 push 进累积 → ③block 判定（`proceed:false` → 终止链）。由此两个组合定案：`{proceed:false, injectedMessages:<畸形>}` → 畸形 warn + 丢弃，block 决策照常生效；`{proceed:false, reason, injectedMessages:<合法>}` → **block 插件自身的合法注入进已累积**（push 在 block 判定之前完成），回包 `{blocked:true, reason, injectedMessages:<含 block 插件的注入>}`——理由：与 pi 侧行为闭环（pi 收到 blocked 回包时 blocked 只 log、注入照常评估 ✅核实 plugin-bridge :450-457），「阻止后续插件 + 向 LLM 留言解释」是类型合法且语义自然的形态，注入生效与阻止生效互不吞没。链上某插件 `proceed:false` → 终止链（后续插件不执行），**已累积的注入保留**（含 block 插件自身，已执行插件的决策应生效），行为闭环。
- 效果：多插件语义可预测（G1/G2）。

**D3 映射与回包：handleBridgeIntercept 纯映射组装终态回包**

- 选择：`handleBridgeIntercept` 尾部把管线透传的 `injectedMessages`（**管线层已逐插件校验（D2），此处输入恒为合法 string[]**）纯映射为回包条目 `{content: <string>}` 组装 `injectedMessages` 数组——本层无校验无日志职责。
- **协议层形状（r1 审查 MF-1 修正）**：现状协议两端均为 `injectedMessages: unknown[]`（runtime 侧 plugin-types.ts:254-258；pi 侧协议 SSOT extension-protocol plugin-bridge/types.ts:54-58），协议层**不收紧**——`{content}` 条目形状由 pi 侧 bridge extension 的 `isInjectedMessage` 运行时守卫收窄（plugin-bridge :90-92，要求对象含 content 键）。不收紧的理由：收紧需动 extension-protocol + runtime plugin-types 两个协议文件，收益仅是类型文档化（运行时守卫已承担实际约束），成本大于收益；runtime 侧组装仍按 `{content}` 单键形态产出（与守卫预期对齐）。**依赖登记（r2 审查 INFO）**：pi 侧该守卫为无留痕过滤，仅在 runtime↔bridge 版本失配（runtime 产出偏离本设计）时触发——排查链依赖 runtime 侧管线守卫日志（D5），pi 侧无信号。
- 既有行为保持：无映射事件名 → `{injectedMessages:[]}`（ERR2 协议兼容）；**blocked 分支回包组装 `{blocked:true, reason, injectedMessages:<管线累积>}`（r1 审查 SG-2 补清单——现状 bridge-interop blocked 分支恒空注入，按 D2 block 交互定案改为透传已累积注入）**。
- 被否：把 string[] 直接塞回包（pi 侧 `isInjectedMessage` 守卫只认含 content 键的对象条目，string 条目会被过滤 ✅核实 extension 实装）；收紧协议类型为 `Array<{content: unknown}>`（见上）。
- 效果：通道层零改动（G4）——bridge extension 的既有映射机制原样消费。

**D4 systemPrompt 不开通（减法登记）**

- 选择：pi 的 `systemPrompt` per-turn 覆盖槽位本设计不开通（SDK 无字段、runtime 不透传）。
- 理由：零调用方需求（§2.4）；系统提示词改写是比消息注入敏感得多的能力（影响所有工具选择与行为），开放前应有独立设计（权限面/叠加语义/与 system-prompt extension 的关系）。**演进点登记**：未来开通时走 SDK 新字段（如 `systemPromptOverride`）+ 管线 chained 语义（pi 侧多扩展本就链式），通道层仍零改动。

**D5 形状守卫与错误规格（守卫落位管线层 = HookPipeline.execute，r2 审查 MF）**

| 错误场景 | 行为（执行层） | 恢复指引 |
|---|---|---|
| 插件返回 `injectedMessages` 非数组（消费 hookType，r3 INFO 补限定——非消费 hookType 走行 3 不做形状校验） | **管线层**整体丢弃 + warn 日志（含插件 id + 收到类型）；Array.isArray 判定在 push 前——字符串值不被 spread 拆条；**先于 block 判定执行，覆盖所有返回组合（含 block 插件）** | 日志指向插件 id；作者改返回 `string[]` |
| 数组内混入非 string 条目（消费 hookType） | **管线层**丢弃该条目 + warn 日志（插件 id + 条目序号 + 形状摘要），其余条目照常注入；同上先于 block 判定 | 同上 |
| `{proceed:false, injectedMessages:...}` 组合（r3 审查 MF 新增） | 按 D2 统一处理序：畸形 → 行 1/2 warn+丢弃；合法 → push 进已累积**后**再终止链——block 插件的注入进 blocked 回包（与 pi 侧「blocked 只 log、注入照常评估」闭环） | —（合法组合非错误；畸形部分见行 1/2） |
| 非 `onBeforeAgentStart` 的 **intercept** hookType 返回了非空 `injectedMessages`（D1 契约边界） | **管线层**忽略 + warn 日志（hookType + 插件 id）——防沉默失败换入口重现。**范围限定（r2 审查 SG-1）**：仅 intercept hookType 可实现（observe 链路走 notifyObservers，响应在 Worker 侧丢弃、主线程不可见 hook-pipeline.ts:134——observe 误用只能靠 D1 JSDoc 约束，无运行时信号）；本行不做形状校验（误用整体忽略，畸形叠加是无意义的双重 warn——r3 INFO 澄清） | 日志指向插件 id；该字段仅 onBeforeAgentStart 消费，作者移除误用 |
| 空数组 / 全部被过滤 | 回包 `{injectedMessages:[]}`（等价不注入），无日志（非错误） | — |
| Worker crashed / hook 超时（5s 既有） | 该插件跳过（既有语义），其注入不产生 | 查 runtime 日志 worker 状态 |
| 管线异常 | 既有 catch 语义（放行），回包空注入，turn 不受影响 | 查 runtime 日志 |

- 量级校准（超时默认原则）：hook 级 5s 超时是既有 HOOK_HANDLER_TIMEOUT_MS，本设计不新增计时器。
- **延迟面登记（r1 审查 INFO 采纳）**：bridge:intercept 回包最坏延迟 = N 插件 × 5s 串行（hook-pipeline 逐 handler 超时；pi 侧 select 不传 timeout——D5 通道分档既有定案）。既有机制非本设计引入，但注入能力落地会提升 `onBeforeAgentStart` 注册动机、放大每 turn 前延迟面；多插件高延迟场景的可观测性依赖既有 hook 超时 warn 日志，不为此新设计聚合预算（真实需求出现时独立设计）。

**D6 探针与运行时断言**

| 断言 | 探针 | 状态 |
|---|---|---|
| pi `BeforeAgentStartEventResult` 无 block 槽位、message/systemPrompt 两槽位 | node_modules types.d.ts:845-849 直读 | ✅ 已核（本文 §2.3 引用即证据） |
| bridge extension 对 `injectedMessages:[{content}]` 的映射消费 | V6 通道级验收（bridge 设计 §4，2026-09-05 Gate B 已跑） | ✅ 已测 |
| 管线 transformedData 链式覆盖语义 | hook-pipeline.ts:113 直读 + 既有单测 | ✅ 已核 |
| 注入端到端生效（SDK 字段 → LLM 行为） | V6 端到端场景升级版（§4 W 场景，实施期跑） | ⛔ 实施期门 |

### 3.4 终态数据流（实现后）

```
插件 Worker                runtime 主线程                          pi 子进程
─────────                 ─────────────                          ─────────
onBeforeAgentStart
返回 {proceed:true,
      injectedMessages:[
        '回复首行含 MY_TOKEN']}
        └─plugin.hooks.invoke─→ HookPipeline.execute()
                            ① 逐插件形状守卫（D2/D5）
                            （非数组整体丢 / 非 string 条目丢，
                              warn 含 pluginId+序号）
                            ② 累积拼接合法条目
                            （transformedData 覆盖语义不变）
                            HookResult{injectedMessages:[...]}
                                  │
                                  ↓
                            handleBridgeIntercept()
                            纯映射（输入恒合法 string[]）
                            回包 {injectedMessages:[
                              {content:'回复首行含 MY_TOKEN'}]}
                                  │                          bridge extension
                                  │                          ←─bridge:intercept 回包
                                  │                          映射 CustomMessage
                                  │                          (plugin-inject, display:false)
                                  │                          content:[{type:'text',...}]
                                  │                                  ↓
                                  │                          agent-session 组装 turn
                                  │                          LLM 上下文含注入段
                                  │                          → 回复首行含 MY_TOKEN
```

## 4. 验收

| 场景 | 回溯目标 | 真实流程 | 通过标准 |
|------|---------|---------|---------|
| **W1 注入端到端生效** | G1 | standalone runtime（:3311 + 隔离数据目录）+ 测试插件注册 `onBeforeAgentStart` 返回 `injectedMessages:['回复首行包含 INJECT_TOKEN_X']`；WS 发起一轮对话 | agent 回复首行含 `INJECT_TOKEN_X`（行为断言）；pi session 文件含 customType `plugin-inject` 的 custom 消息（display:false）；runtime 日志无 warn |
| **W2 多插件叠加** | G1/G2 | 两个测试插件各注入一条（不同 token）；一轮对话 | 回复同时体现两条注入（如首行 token-a、次行 token-b，prompt 明确要求分别输出）；session 文件 custom 消息 content 数组两段、顺序 = priority 执行序 |
| **W3 畸形注入与契约边界误用不炸 turn** | G3 | 测试插件两形态：①`onBeforeAgentStart` 返回 `injectedMessages:['正常条目', 42 as never]`；②同插件（另一轮）在 `onBeforeToolCall` 返回非空 `injectedMessages`（D1 契约边界误用，r2 审查 SG-2 并入；**该轮 prompt 明确要求调用任一工具（如 read）保证 onBeforeToolCall 触发**，r3 审查 SG 补）；各一轮对话 | ①turn 正常完成；'正常条目' 照常注入生效；warn 日志含插件 id 与 `entry 1` 字样。②turn 正常完成且无注入；warn 日志含 hookType `onBeforeToolCall` 与插件 id |
| **W4 block 语义边界** | G2 | 两形态：①插件 A 注入 `['回复末行包含 TOKEN_A']` + 插件 B（更高 priority）返回 `proceed:false`；②插件 B 返回 `proceed:false, reason, injectedMessages:['回复首行包含 TOKEN_B']`（block 携带注入组合，r3 审查 MF 补）；各一轮对话（r4 审查 SG 补 token 判据） | ①turn 照常进行；回复末行含 `TOKEN_A`（已累积保留）；block 留痕。②turn 照常进行；回复首行含 `TOKEN_B`（push 先于 block 判定，D2 统一处理序——行为断言非 session 文件检查）；runtime 日志 block 留痕 + pi 侧 extension log「unsupported by pi result contract」 |
| **W5 通道零回归** | G4 | 重跑 bridge 设计 §4 V6 通道级场景（既有测试插件 + observe hook） | 与 Gate B 验收时行为一致（事件到达/无异常延迟/无 unhandled rejection） |

> W1-W4 环境基准同 bridge 设计 §4（standalone runtime 优先，dev 全链备选）；W1 复用 V6 的 BRIDGE_TOKEN_X 模式（token 更名避免与既有证据混淆）。单测层（实施期）：SDK 形状守卫、pipeline 累积拼接与逐插件校验（含 block 保留语义/非数组不 spread）、bridge-interop 纯映射矩阵——单测只验代码符合设计假设，不替代上表真实场景。

## 5. 下一层拆分

| 单元 | 内容 | justification | 领地 |
|------|------|--------------|------|
| I1 SDK 契约 | `InterceptorResult.injectedMessages?: string[]` + JSDoc（三分域语义 + D1 契约边界声明 + block 诚实描述 + observe 误用无运行时信号注记）；`HookResult.injectedMessages?: string[]`（runtime 内部塑形）——**注意 HookResult 双定义镜像**：plugin-sdk types.ts:456-461 与 runtime 侧 `plugin-types/hook-types.ts:76-81`（hook-pipeline 实际 import 后者，经 plugin-types.ts re-export），**两份同批改动**（r1 审查 MF-3） | 契约先行——I2/I3 都依赖此形状；纯类型 + 文档，无运行时 | packages/plugin-sdk/src/types.ts + packages/runtime/src/services/plugin-service/plugin-types/hook-types.ts |
| I2 管线校验与透传 | HookPipeline.execute **逐插件形状守卫（r2 审查 MF：守卫在本层——非数组整体丢弃（Array.isArray 在 push 前，字符串不 spread）+ 非 string 条目丢弃，warn 含 pluginId+序号）** + 累积拼接（与 transformedData 覆盖语义分叉）；**统一处理序：校验 → push → block 判定（r3 审查 MF 定案——校验覆盖含 block 插件的所有返回组合，block 插件自身合法注入进已累积）**；非 `onBeforeAgentStart` 的 intercept hookType 误用 warn（D5 行 3）；单测（校验矩阵含 `block×畸形`/`block×合法注入` 两格/累积序/覆盖分叉/block 保留/误用 warn）。**含原 I4 定案（r1 审查 SG-1）**：plugin-service.ts 的 `executeHooks` 已核实为 observe 分流 + 纯委托 HookPipeline.execute（:733-739），Worker 响应 → HookResult 映射唯一收口在 hook-pipeline（D2-3 :76-96）——无独立主线程塑形点，I4 裁撤并入本单元 | 守卫与聚合都在本层（唯一持有插件归属的位置）；独立可测；塑形收口核实完毕无需独立单元 | packages/runtime/src/services/plugin-service/hook-pipeline.ts + 同目录测试 |
| I3 纯映射与回包 | handleBridgeIntercept **纯映射**（r2 审查 MF：守卫职责移除——输入恒合法 string[]）非 blocked 路径 `{injectedMessages:[{content}]}` 组装 + **blocked 分支回包 `{blocked:true, reason, injectedMessages:<管线累积>}` 透传（r1 审查 SG-2，现状恒空需改）**；映射矩阵单测（含 blocked×注入组合）；bridge-interop.ts:258-260 未定案注释替换为本设计引用 | 生产端落点；注释自述的未定案空间由本设计收口（C-proc-10 回写） | packages/runtime/src/services/plugin-service/bridge-interop.ts + 测试 |

实施顺序：I1 → I2 ∥ I3（I2/I3 无领地交集可并行）；全部完成后跑 §4 W1-W5。

**待验证检查点（实施期门）**：

1. W4 的「已累积保留」在 pi 侧的实际表现（bridge extension 对 `blocked:true + injectedMessages 非空` 的组合处理——实装核实：blocked 只 log、注入照常评估 ✅设计期已核，实施期端到端确认）。
2. ~~plugin-service.ts 独立塑形点~~ 已设计期关闭（r1 审查 SG-1：executeHooks 纯委托，无独立点，I4 裁撤并入 I2）。

---

## 变更历史

- v1（2026-09-05）：初版。Step 0 事实重钉（四层断链 + transformedData 语义错位 + pi 槽位能力面 + 零调用方盘点）；方案对比 A/B/C（推荐 A：string-only 注入）；决策 D1-D6（含 block 语义诚实定案 + systemPrompt 减法登记）；验收 W1-W5（W1 复用 V6 行为断言模式）。
- v2（2026-09-05）：**第 1 轮对抗式审查修复**（3 MF / 3 SG / 2 INFO 全修，报告 .review/plugin-intercept-injection-design-review-r1.md）。①MF-1（D3 协议形状事实错误）：两端协议实为 `unknown[]` 非本文声称的 `Array<{content}>`——改为「协议层不收紧 + `{content}` 条目形状由 pi 侧 isInjectedMessage 运行时守卫收窄」定案，被否栏补「收紧协议类型」候选及成本论证；②MF-2（D1 契约边界）：`InterceptorResult` 为 7 个 intercept hookType 共享，新字段在其他 hookType 被各消费点静默丢弃（消费点已逐一行级核实）——D1 补显式契约边界声明 + SDK JSDoc 要求 + 管线非消费 hookType warn（D5 新增行 3），堵「沉默失败换入口重现」；③MF-3（I1 领地遗漏）：HookResult 双定义镜像（plugin-sdk types.ts + runtime plugin-types/hook-types.ts，后者为 hook-pipeline 实际 import）——I1 领地补第二份 + 同批改动纪律；④SG-1：executeHooks 纯委托已核实（无独立主线程塑形点），I4 设计期定案裁撤并入 I2，检查点 2 关闭；⑤SG-2：I3 清单补 blocked 分支注入透传（现状恒空需改）；⑥SG-3：零调用方登记补 dsh-test 仓库 grep 复核步骤；INFO 采纳：D5 补「N 插件 × 5s 串行延迟面」登记（既有机制，注入落地放大动机）。
- v3（2026-09-05）：**第 2 轮聚焦复审修复**（1 MF / 2 SG 全修，报告 .review/plugin-intercept-injection-design-review-r2.md；r1 全部 6 条修复经复审验证成立，点名攻击面「协议 unknown[] × pi 侧守卫新静默丢弃」不成立）。①MF（守卫层位置，P0-12 规格矛盾）：形状守卫从 I3（handleBridgeIntercept）上移 I2（HookPipeline.execute 逐插件校验）——聚合产物无插件归属，「warn 含插件 id」在 I3 不可实现（D5 行 1/2、§3.1 日志示例、W3 断言三处承诺连带落空）；且 D5 行 1「非数组整体丢弃」原未落位任何单元，I2 若 spread 实现会把字符串拆成多个合法 string 条目全部注入。修复：D2 改「逐插件校验 + 累积拼接」（Array.isArray 在 push 前），D3 改「纯映射（无校验无日志职责）」，D5 表标注执行层=管线层，§3.4 图守卫标注移位，I2/I3 清单同步；被否栏补「守卫落位聚合层」「条目携带 pluginId」两候选。②SG-1：D5 行 3 限定「非 onBeforeAgentStart 的 **intercept** hookType」（observe 链路 notifyObservers 响应在 Worker 侧丢弃、主线程不可见，无运行时信号——仅 JSDoc 约束）；③SG-2：D5 行 3 负面行为并入 W3（②onBeforeToolCall 误用形态）；INFO 采纳：D3 补「pi 侧守卫无留痕过滤仅在版本失配触发，排查依赖 runtime 侧守卫日志」依赖登记。
- v4（2026-09-05）：**第 3 轮聚焦复审修复**（1 MF / 1 SG / 1 INFO 全修，报告 .review/plugin-intercept-injection-design-review-r3.md；r2 的 1 MF / 2 SG / 1 INFO 修复全部验证成立，主 agent 点名攻击面被审查者命中）。①MF（block 判定与校验/累积的相对顺序未定案，P0-12）：两个类型合法组合行为不可预测——`{proceed:false, injectedMessages:<畸形>}` 的 warn 与否依赖实施者把守卫加在 block return 前还是后（现状 hook-pipeline.ts:99-104 block 检查在循环体最前直接 return）；`{proceed:false, reason, injectedMessages:<合法>}` 的注入进不进 blocked 回包两种读法都通。修复：D2 定案**统一处理序「校验 → push → block 判定」**——畸形 warn 覆盖含 block 插件的所有返回组合（G3 无组合限定）；block 插件自身合法注入**进已累积**（与 pi 侧「blocked 只 log、注入照常评估」行为闭环，阻止与留言互不吞没）；D5 新增组合行 + 行 1/2 补「消费 hookType」限定；I2 单测矩阵补 `block×畸形`/`block×合法注入` 两格；W4 补②形态（block 携带注入生效断言）。②SG：W3 ② 补「该轮 prompt 明确要求调用任一工具」（无工具调用则 onBeforeToolCall 不触发、断言假失败）。③INFO：D5 行 3 补「本行不做形状校验」（误用整体忽略，畸形叠加是双重 warn 无意义）——与行 1/2 的适用域重叠消除。
- v4 终态补记（2026-09-05）：**第 4 轮聚焦复审 0 must-fix / 1 suggestion，设计就绪**（报告 .review/plugin-intercept-injection-design-review-r4.md；四轮收敛轨迹 3 MF → 1 MF → 1 MF → 0 MF）。复审确认：plugin-bridge 当前 HEAD（含准入闸版本）:450-456 blocked 分支只 log 无 return、:457 起注入照常消费——D2/W4② 依赖的实装断言不变。r4 suggestion 当轮修：W4 ①② 断言补 token 判据（TOKEN_A 末行 / TOKEN_B 首行行为断言，弃「session 文件检查」弱判据）。INFO（§3.4 图补 block 分支标注）未采纳：成功路径图不含 block 属 v1 既有形态，W4 验收已覆盖。
