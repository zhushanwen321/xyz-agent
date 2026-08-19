# 任务 A：runtime pi 基建层 —— pi 行为假设全面审计报告

日期：2026-08-19 · 分支：fix-chat-flow-order · 审计人：subagent A（runtime pi 基建层）

## 1. 总结论

| 分类 | 计数 |
|------|------|
| 错误-已致废代码 | 2 |
| 错误-潜在 bug | 3（其中 2 条由版本漂移演化而来） |
| 错误-碰巧无害 | 2 |
| 过时-版本漂移 | 4 |
| 未验证-风险 | 2 |
| 正确-已锚定 | 30（见 §3 简表） |

**最重要的 3 条**：

1. **A-01（错误-已致废代码，major）**：`toolcall_start → tool-call-index → 前端 contentIndex 有序插入` 整条机制在生产 wire 上是死代码——pi rpc-mode 的 `toJsonEvent` 把 `message_update` 的顶层 `message` 字段整体剥离，event-adapter 据此提取 toolCallId 的路径恒为 noop。精心设计的「toolCall 块顺序锚点」机制从未生效过，前端一直走在注释里描述的「降级 append 尾部」路径。
2. **A-02（错误-潜在 bug，版本漂移所致，major）**：`isInvalidProvider` 沿用 pi 0.80.3 的五字段空壳判定，0.84.1 已放宽为八字段（apiKey/oauth/authHeader 任一存在即合法）。启动时 `sanitizeInvalidProviders` 会把「只配 apiKey 的自定义 provider」从 models.json **静默物理删除**——0.84.1 本可正常加载它（内置 baseModels + apiKey），用户 API key 数据丢失。
3. **A-03（错误-潜在 bug，minor-major）**：`VALID_THINKING_LEVELS` 缺 `'max'`。pi 0.84.1 CLI/pi-ai 完整值域含 max，preset/Landing Chip 传 max 会被 warn + 静默忽略，session 以默认档启动，与 pi-protocol.ts 自己声明的 `PiThinkingLevel`（含 max）自相矛盾。

整体评价：领地内绝大多数假设注释带 pi 源码锚点且经核实成立（尤其 `_persist` / `switch_session` / RPC 协议面），质量高于平均；错误集中在「RPC wire 层字段可见性」（A-01）与「0.80.3 时代结论未随 0.84.1 重验」（A-02/A-03/A-07~A-09）两个模式。

## 2. 发现明细表

判定图例：错误-已致废代码 / 错误-潜在 bug / 错误-碰巧无害 / 过时-版本漂移 / 未验证-风险 / 正确-已锚定。

### A-01 toolcall_start 的 toolCallId 提取恒失效（message_update.message 字段在 RPC wire 上不存在）

- **位置**：`packages/runtime/src/infra/pi/event-adapter.ts:111-125`（handleMessageUpdate toolcall_start 分支）；类型声明 `packages/runtime/src/infra/pi/pi-protocol.ts:186-193`
- **假设原文**：pi-protocol.ts:188 「运行时 pi 带完整 partial message（agent-session.js:462 确认）。toolcall_start 提取 toolCallId 用。」
- **pi 实际行为**：agent-session 内部事件确实带 `message: {...partialMessage}`（pi-agent-core `dist/agent-loop.js:207-215` emit 时附带）。但 RPC 出口 `pi-coding-agent dist/modes/rpc/rpc-mode.js:279-282` 对所有 session 事件过 `toJsonEvent()`，而 `dist/modes/json-event.js:3-13` 对 message_update **只输出 `{type, assistantMessageEvent}` 两个字段**——顶层 `message` 与 assistantMessageEvent 内的 `partial` 全部剥离。
- **判定**：错误-已致废代码（机制死亡）+ 潜在 bug（顺序错位回归）
- **影响**：`event.message?.content?.[contentIndex]?.id` 恒 undefined → `tool-call-index` 中间事件永不产出 → `EventInterpreter.toolCallContentIndex`（event-interpreter.ts:183/288-290/394-395/406）恒空 → `tool_call_start` WS 帧恒无 `contentIndex`/`messageId` 锚点 → 前端 toolCall 块退化为 append 尾部。当模型同一条 assistant 消息里 toolCall 块之后跟 text 块时 contentBlocks 顺序错位——恰是注释（event-adapter.ts:112-116「§11 检查点 3」）声称要修复的场景。测试未覆盖：`__tests__/event-adapter-delta.test.ts:19` 构造的 message_update 本身就不带 message 字段，测试过而生产死。
- **建议**：修复（改从 assistantMessageEvent 之外的通道取锚点不可行——wire 上无数据；需 pi 侧透出或改用 tool_execution_start 时序 + 前端 contentBlocks 排序策略重审）；最低限度先加「真实 pi wire fixture」契约测试锁定 message_update 实际字段集，并把 pi-protocol.ts:188 注释改正。

### A-02 isInvalidProvider 五字段判定已过时（0.84.1 放宽为八字段），启动时误删合法 provider

- **位置**：`packages/runtime/src/infra/pi/pi-provider-repair.ts:34-43`；调用方 `packages/runtime/src/infra/pi/pi-provider-store.ts:427-460`（sanitizeInvalidProviders，会 `writeModels` 物理改写 models.json）
- **假设原文**：pi-provider-repair.ts:18-21 「pi 0.80.3 报错原文：provider must specify "baseUrl", "headers", "compat", "modelOverrides", or "models"。五字段全缺则 pi 拒绝该 provider」；pi-provider-store.ts:408 「空壳 provider（如 {apiKey, name} 无五字段任一）导致 bundled pi 0.80.3 严格校验时整个 models.json 加载失败」
- **pi 实际行为**：0.84.1 `dist/core/provider-composer.js:80-95` applyModelsJson 的判定条件为八字段：`!models && !baseUrl && !headers && !compat && !hasOverrides && !apiKey && !oauth && authHeader===undefined` 才 throw（错误文案仍写五字段，但判定已含 apiKey/oauth/authHeader）。即 `{name, apiKey}` 条目在 0.84.1 是**合法 provider**（加载内置 baseModels 并以 apiKey 鉴权）。
- **判定**：错误-潜在 bug（根因：过时-版本漂移）
- **影响**：触发条件 = models.json 中存在「非 xyz builtin catalog 内置 id + 只配 apiKey/oauth/authHeader」的 provider。后果：启动时 sanitizeInvalidProviders 判其无效 → 不在 catalog 修复名单 → `delete draft.providers[id]` + writeModels——**用户 API key 静默物理丢失**，且无自愈路径（文件已被改写）。xyz catalog（builtinModelsById）与 pi 0.84.1 内置 provider 集合并不同步，pi 新增内置 id 最易踩中。
- **建议**：修复——isInvalidProvider 补 `apiKey`/`oauth`/`authHeader !== undefined` 三个豁免条件（对齐 0.84.1 判定），或将该函数的判定逻辑与 pi provider-composer 同步维护并注明锚点；加回归测试 `{name, apiKey}` 不被 sanitize。

### A-03 VALID_THINKING_LEVELS 缺 'max'，用户配置被静默忽略

- **位置**：`packages/runtime/src/services/session/session-lifecycle.ts:123`
- **假设原文**：「与 shared ThinkingLevel 类型对齐（pi CLI --thinking 参数值域，附录 A.4）」——隐含假设该六值即 pi 全量值域。
- **pi 实际行为**：pi 0.84.1 `dist/cli/args.js:5` `VALID_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`（七值，含 max）；pi-ai `dist/models.js:391` EXTENDED_THINKING_LEVELS 同含 max（xhigh/max 需模型 thinkingLevelMap 显式映射才可用，clampThinkingLevel 兜底）。xyz 自己的 `pi-protocol.ts:403` `PiThinkingLevel` 也含 'max'。
- **判定**：错误-潜在 bug
- **影响**：触发条件 = preset JSON 手写 `"thinkingLevel":"max"` 或 Landing Thinking Chip 传 max。后果：buildPresetClientOptions 校验失败 → console.warn + 忽略 → session 以 pi 默认档启动；对支持 max 的模型（thinkingLevelMap 有映射）用户拿不到最高档，且 UI 无强提示。
- **建议**：修复——VALID_THINKING_LEVELS 补 'max'（与 pi-protocol PiThinkingLevel 对齐，最好两处共享一个 SSOT 常量）；测试锁定七值域。

### A-04 「pi 单 bash slot」假设不成立（pi 支持并发 bash）

- **位置**：`packages/runtime/src/services/session/message-dispatcher.ts:257`
- **假设原文**：「isBashRunning：bash↔bash 互斥——pi 单 bash slot，并发会乱序。」
- **pi 实际行为**：`dist/core/agent-session.js:2199-2218` executeBash 每次调用创建**新的** AbortController 加入 `_bashAbortControllers`（**Set**，L107）；`isBashRunning = size > 0`（L2261-2263）；RPC 层 `handleInputLine` 每行独立异步（rpc-mode.js:644-660 `void handleInputLine(line)`），无串行锁——pi 明确支持多个 bash RPC 并发执行。
- **判定**：错误-碰巧无害（保守方向的自设约束）
- **影响**：xyz 拒绝并发 bash 不产生数据损坏，但功能比 pi 能力窄：bash 运行中再发 bash 被拒，报错文案「Agent 正在处理」与真实原因（xyz 自设互斥）不符，误导排障。streaming 期并发 bash 的 `_pendingBashMessages` 按**完成顺序** push（agent-session.js:2236-2240），乱序担忧只在 JSONL 回放序层面部分成立——注释的理由描述不准确。
- **建议**：仅记录 / 改注释（说明这是 xyz 自设 UI 约束而非 pi 限制）；若未来放开并发需同时评估 flush 顺序。

### A-05 pi-protocol 的 select options 类型声明仍是旧 {label,value} 形态

- **位置**：`packages/runtime/src/infra/pi/pi-protocol.ts:470`
- **假设原文**：`options?: Array<{ label: string; value: string; description?: string }>`
- **pi 实际行为**：pi 0.84.1 `dist/core/extensions/types.d.ts:70`：`select(title: string, options: string[], opts?)`——options 是 **string[]**，rpc-mode L96 原样透传。event-adapter.ts:501-503 的 [HISTORICAL] 注释已确认此事并把实现改为 `.map(String)`。
- **判定**：错误-已致废代码（死类型声明）
- **影响**：pi-protocol.ts 是 ADR-0037 认定的「协议真契约」，该声明与真契约相反。运行时无影响（event-adapter 用 `as unknown[]` 绕开），但会误导后续开发者按 {label,value} 解析（正是曾被修掉的 bug 的复燃入口）。
- **建议**：修复——改为 `options?: string[]` 并引用 types.d.ts 锚点。

### A-06 「pi _persist 期望每行以 \n 结尾」不准确

- **位置**：`packages/runtime/src/services/session/session-lifecycle.ts:80`（stripSessionEndEntries 末尾补 \n 的理由）
- **pi 实际行为**：pi 读取侧 `content.trim().split("\n")`（session-manager.js:93）——末尾换行非必须，trim 已兜底。
- **判定**：错误-碰巧无害（补 \n 是保守正确做法，与 pi 写出格式一致）
- **建议**：仅记录（可改注释为「与 pi 写出格式对齐」而非「pi 期望」）。

### A-07 spawn 失败提示指向旧 npm 包名

- **位置**：`packages/runtime/src/infra/pi/process-manager.ts:228`
- **假设原文**：「Ensure pi is installed globally (npm i -g @mariozechner/pi-coding-agent)」
- **pi 实际行为**：当前依赖为 `@earendil-works/pi-coding-agent@0.84.1`（package.json / AGENTS.md）。
- **判定**：过时-版本漂移
- **影响**：dev fallback 路径（resources/pi 缺失 + PATH 无 pi）的错误恢复指引指向错误包，用户照做会装到不匹配的旧包。违反全局规则 16（错误信息应指向正确恢复动作）。
- **建议**：修复（更新包名；严格说 dev 模式应优先引导跑 prepare-pi-resources.sh）。

### A-08 「agent-loop 在每个 turn 末尾 emit message_start{role:'user'}」机制描述失准

- **位置**：`packages/runtime/src/infra/pi/event-adapter.ts:548-551`（[HISTORICAL] user role 过滤注释）
- **pi 实际行为**：0.84.1（pi-agent-core 0.84.2 `dist/agent-loop.js`）：user prompt 的 message_start/end 在**循环开头**发一次（L52-55，紧跟 agent_start/turn_start）；steering/followUp 注入时再发（L98-101）。不在「每个 turn 末尾」。
- **判定**：过时-版本漂移（过滤行为仍正确——user message_start 确实存在且必须过滤，仅注释里的机制描述过时）
- **建议**：仅记录 / 顺手更新注释。

### A-09 KNOWN_PI_API_TYPES 白名单与 pi 0.84.1 KnownApi 联合集漂移

- **位置**：`packages/runtime/src/infra/pi/pi-config-store.ts:101-109`（消费 `packages/shared/src/constants.ts:53-57` 的 KNOWN_PI_API_TYPES，仅 3 值）
- **pi 实际行为**：pi-ai `dist/types.d.ts:14` KnownApi = 10 值（含 mistral-conversations / azure-openai-responses / openai-codex-responses / bedrock-converse-stream / google-generative-ai / google-vertex / pi-messages）。
- **判定**：过时-版本漂移（错误-碰巧无害级别：warn 不阻断）
- **影响**：用户配置上述 7 种合法 api type 时收到「pi 可能不支持」误导性 warn（日志噪声 + 排障误导）；注释「pi 只支持 3 种 api」的隐含宣称错误。附带核实：注释「pi 不支持 ollama」仍正确（KnownApi 无 ollama）。
- **建议**：修复（白名单补全或改为纯透传只 warn 完全未知形态）；至少改注释。

### A-10 agent_end{willRetry:true} 无消费者：auto-retry 窗口 xyz 视为空闲

- **位置**：`packages/runtime/src/infra/pi/event-adapter.ts:234-296`（handleAgentEnd 未读 willRetry）；声明处 `pi-protocol.ts:106-107`「pi 始终发送」
- **pi 实际行为**：agent_end 会带 willRetry（rpc-mode 订阅处 agent-session.js:365 `_willRetryAfterAgentEnd`）；willRetry=true 时 `_runAgentPrompt` 在 agent_end 后 `agent.continue()` 重试（agent-session.js:744-750），期间发 auto_retry_start/end 事件、可能再跑完整循环。pi 的 `prompt()` 只在 `isStreaming` 时要求 streamingBehavior（agent-session.js:832-834）——retry delay 窗口 isStreaming=false，新 prompt 会被 pi 直接接受，与 continue 的 `runAgentLoopContinue` 在 agent context 上并发竞争。
- **判定**：未验证-风险
- **缺什么证据**：① pi 侧 continue 与并发 prompt 的竞争后果未实测（可能 context 交错 / 事件流混淆）；② xyz renderer 是否在 auto_retry 期间禁发消息（renderer 领地外，本审计未覆盖）。xyz runtime 侧事实：dispatcher busy 预检只看 isGenerating，而它已被第一个 agent_end 的 onTurnFinalize 复位。
- **建议**：加防御——event-interpreter 消费 auto_retry_start/end（或 agent_end.willRetry）维持 isGenerating=true 直至 retry 终局；或实测 pi 并发行为后裁决。

### A-11 「bundled pi 用 process.execPath 定位资源」的探针结论来自旧 fork

- **位置**：`packages/runtime/src/infra/pi/rpc-client.ts:207-211`
- **假设原文**：「Verified: xyz-pi 0.75.5-xyz-0.1 uses process.execPath for resource resolution.」
- **判定**：未验证-风险（spawn cwd 设为用户项目目录的安全性依据是旧 fork 探针；0.84.1 upstream bundled binary 未重验。当前项目实际运行正常，说明此刻成立，但 pi 升级时此假设无护栏）
- **建议**：加测试锁定（bundled binary 在非 cwd 目录 spawn 后 theme/package.json 资源仍可加载），或升级 pi 时重跑该探针。

### A-12 event-adapter 注释引用的 pi 行号锚点漂移（语义仍对）

- **位置**：`packages/runtime/src/infra/pi/event-adapter.ts:596`「agent-session.ts:545-561」——0.84.1 dist 实际在 agent-session.js:368-378；同类：event-adapter.ts:808（appendEntry 唯一发射点现于 agent-session.js:1864-1870）。
- **判定**：过时-版本漂移（仅锚点失准，语义核实成立）
- **建议**：仅记录；后续引用 dist 编译产物行号时标注版本号（部分注释已这样做，如 bash_execution_update 条目，是好实践）。

## 3. 已核实为正确的假设清单（正确-已锚定）

以下假设均在本审计中对照 0.84.1 已安装 dist 一手核实成立（括号内为 pi 侧锚点）：

| # | 假设 | xyz 位置 | pi 锚点 |
|---|------|---------|---------|
| 1 | message_end 是 user/assistant/toolResult/custom 四种 message 持久化的唯一触发点；bashExecution/compactionSummary/branchSummary 另有持久化路径 | event-adapter.ts:595-597 | agent-session.js:368-378（含 pi 原注释 "persisted elsewhere"） |
| 2 | entry_appended 只对 extension appendEntry 发射，message entry 不发射 | event-adapter.ts:808-815 | agent-session.js:1864-1870（全 dist 唯一发射点） |
| 3 | toolResult 的 message_start/end 内部记账（emitToolResultMessage） | event-adapter.ts:554-559 | pi-agent-core agent-loop.js:549-551 |
| 4 | tool_execution_start 用 args / tool_execution_end 无 args 也不带 input/output | pi-protocol.ts:274-311、event-adapter.ts:151/182-185 | agent-loop.js:246-251 / 525-533 |
| 5 | turn_end 把 message 放顶层（pi 从不发 payload） | event-adapter.ts:307 | agent-session.js:456-464 转发 |
| 6 | _persist 的 hasAssistant 分支：首条 assistant 前不落盘；首次 flush 用 openSync("wx")（EEXIST 竞态 = 规则 #6 依据） | session-file-utils.ts:131/141、session-lifecycle.ts:327-329 | session-manager.js:724-752 |
| 7 | _buildIndex/_appendEntry 对非 session entry 无差别 byId.set + leafId 推进（session_end 行致 leafId=undefined 断链） | session-lifecycle.ts:60-63/525 | session-manager.js:671-688 / 753-758 |
| 8 | switchSession 内 assertSessionCwdExists 对死 cwd 硬拒绝（MissingSessionCwdError；RPC 无 cwdOverride） | session-lifecycle.ts:88-90/527-531 | agent-session-runtime.js:128-135 + session-cwd.js 全文 |
| 9 | switch_session 永久重绑读写目标（setSessionFile 存永久 sessionFile，_persist 按路径 append/重建） | session-file-utils.ts:512-515、session-attach-assert.ts:21-28 | session-manager.js:604-615 / 724-752 |
| 10 | 已 flush 文件的 appendSessionInfo 立即 appendFileSync 落盘（非活跃 rename 经短命 pi 的依据） | session-file-utils.ts:408-409、session-lifecycle.ts:386-390 | session-manager.js:833-844 → _appendEntry → _persist(flushed 分支) |
| 11 | compact 是 append-only（compaction entry append，旧 entry 不删 → since 增量游标不因 compact 失效） | history-rebuild-cache.ts:19 | agent-session.js:1425 appendCompaction → session-manager.js:803 |
| 12 | get_entries(since)：findIndex+slice；空增量返回 success+[]；找不到报 `Entry not found: <id>`（大小写） | history-rebuild-cache.ts:16-18、session-service.ts:1898-1907 | rpc-mode.js:493-503 |
| 13 | pi 对 extension_ui_response 不回 RPC reply（sendRaw 依据） | rpc-client.ts:375-382 | rpc-mode.js:615-626（处理后直接 return） |
| 14 | pi RPC response 全部 type:'response'（resolve 守卫只认 response 的依据） | rpc-client.ts:330-331 | rpc-types.d.ts（type:"response" ×33 处） |
| 15 | prompt RPC 在 preflight 成功后即回 response（非生成完成） | rpc-client.ts:481-483 | rpc-mode.js:291-311 |
| 16 | notify/setStatus/setWidget/set_editor_text 为 fire-and-forget（不注册 pending、不等回复） | event-adapter.ts:429-431 | rpc-mode.js:99-135 |
| 17 | pi select 原样透传 options（string[]），鸭子类型字段检测解析 ui_response（cancelled/confirmed/value） | event-adapter.ts:501-503、rpc-client.ts:627-635 | rpc-mode.js:96 + extensions/types.d.ts:70 |
| 18 | pi prompt 在 isStreaming 时强制 streamingBehavior，否则 throw（sendMessage busy 预检的 pi 侧依据） | message-dispatcher.ts:260-261 | agent-session.js:832-834 |
| 19 | bash RPC 在 streaming 时排入 _pendingBashMessages，turn 结束后按序回放（bash↔streaming 放宽并发的依据） | message-dispatcher.ts:226/254 | agent-session.js:2236-2278（recordBashResult + _flushPendingBashMessages） |
| 20 | prompt 以 / 开头直接执行 extension command handler，不经 LLM | session-service.ts:966-968 | agent-session.js:798-804（_tryExecuteExtensionCommand） |
| 21 | contextUsage 在 compact 后无新 turn 时 tokens=null（不可 fallback tokens.total） | session-service.ts:1665-1672 | agent-session.js:2542-2571（pi 原注释同语义） |
| 22 | thinking_level 同值切换不发射事件（需实例周期兜底） | event-interpreter.ts:102、replicated-state.ts:75 | agent-session.js:1275-1297（isChanging 守卫） |
| 23 | context 占用 = totalTokens（与 calculateContextTokens 同源；usage.input 是单 turn 增量不可用） | event-adapter.ts:286-291 | pi-ai estimate.js:3-5 |
| 24 | pendingMessageCount = steering.length + followUp.length（queue_update 深度公式） | event-adapter.ts:703-711 | agent-session.js:1151-1153 |
| 25 | pi session 文件名 `<ISO(:.→-)>_<uuid>.jsonl` | session-fork.ts:139-144 | session-manager.js:665-667 |
| 26 | pi get_state.sessionFile 不做 symlink realpath 展开（resolve 词法归一足够） | session-attach-assert.ts:32-36 | 探针定论（2026-08-19，已知清单） |
| 27 | entry id 用 uuidv7（碰撞 fallback randomUUID().slice(0,8)——注释未提 fallback，主体正确） | pi-protocol.ts:571-572 | session-manager.js:1/13/21-23 |
| 28 | PI_CODING_AGENT_DIR / --session-dir env 与 flag 名 | rpc-client.ts:134/203 | config.js:397 + cli/args.js:73 |
| 29 | rpc-client 所用 CLI flag 全集存在（--mode/--approve/--no-extensions/--extension/--skill/--model/--system-prompt/--tools/--exclude-tools/--no-tools/--no-skills/--no-context-files/--thinking/--session-dir） | rpc-client.ts:152-203 | cli/args.js（逐一核对在列） |
| 30 | pi 原生 fork RPC 会 rebind 当前进程（破坏源 session 活跃态）→ xyz 走 runtime 截断 + 新进程 | session-fork.ts:4-7 | rpc-mode.js:504-510（fork 后 rebindSession） |

已知清单内不再重复计入：tmp 附着数据丢失（已修复 668273adb）、session_end 行污染 leafId（已修复）、bash_execution_update 复用 RPC id（rpc-client 守卫已修复）、pi 首条 assistant 前不落盘（= 本表 #6）、switch_session 无 cwdOverride（= #8）、get_state.sessionFile 不展开 symlink（= #26）。

## 4. 方法论声明

**假设采集（可复现）**：对领地三个目录（`packages/runtime/src/infra/pi/`、`packages/runtime/src/services/session/`、`packages/runtime/src/transport/`，排除 `__tests__`/`*.test.ts`）执行两组 grep：

```bash
# 组 1（中文断言，命中 112 行）
grep -rn -E "pi 会|pi 不会|pi 忽略|pi 已|pi 先|pi 延迟|pi 再|pi 不|pi 却|pi 才|pi 只|pi 总|pi 每|pi 用|pi 把|pi 的行为|pi 实际|pi 内部|pi 侧|pi 端|pi 源码|pi-mono|0\.84|pi 0\.|pi 版本" <领地>
# 组 2（英文/形态断言，命中 18 行）
grep -rn -iE "workaround|defensive|unverified|unconfirmed|conservative|not documented|undocumented|pi ignores|pi does not|pi doesn't|pi won't|pi will |pi already|pi-?mono|upstream|matches pi|pi behavior|pi emits|pi sends|pi writes|pi flush|pi persists|pi appends" <领地>
```

去重后约 60 条独立假设；逐条读上下文（非单行判断），全部核心文件通读：event-adapter / rpc-client / pi-protocol / session-file-utils / process-manager / session-attach-assert / pi-provider-repair / pi-provider-store（sanitize 段）/ pi-config-store / pi-settings-store / normalize-tool-result / message-converter（头+假设段）/ session-lifecycle / session-service（假设密集段）/ session-fork / message-dispatcher / event-interpreter / history-rebuild-cache / subagent-extractor（头+关键段）/ subagent-status / bridge-handler / extension-message-handler（注释段）/ reload-orchestrator / replicated-state（注释段）。其余文件（entry-tree-builder / session-entry-mapper / session-scanner / session-internal / workflow-extractor / file-change-* / pi-maintenance / pi-paths / pi-enabled-models / pi-extension-settings / agent-crud / discovery-store / pi-skill-paths / session-store / transport 其余 handler）经关键词扫描无 pi 行为断言或断言已并入上表。

**pi 源码核对方式**：一律以**已安装版** `node_modules/@earendil-works/pi-coding-agent@0.84.1` 的 dist 编译产物 + 其依赖 `@earendil-works/pi-agent-core@0.84.2`（agent loop 真实实现，经 agent-session.d.ts 的 `import ... from "@earendil-works/pi-agent-core"` 定位）+ `@earendil-works/pi-ai`（thinking levels / calculateContextTokens / KnownApi）为一手依据；未使用 pi-mono clone 源码下结论（避免 main 分支领先 0.84.1 的漂移），故本报告所有锚点均为运行时真实行为。行号引用基于上述 dist 文件当前内容。

**判定纪律**：每条「错误」判定均附 pi 侧一手锚点；无从证实的标「未验证-风险」并列出缺失证据（A-10/A-11）；未做网络搜索；未修改任何代码/文档（唯一写入 = 本报告文件）。

