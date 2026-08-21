# 任务 B：extensions 全领地 pi 行为假设审计报告

- 审计日期：2026-08-19
- 领地：`extensions/` 全部 14 包 + `extensions/shared/`（ask-user / cw-tool / goal / model-switch / pending-notifications / permission / plan / rename-session / scheduler / session-reader / structured-output / subagent-workflow / todo / unified-hooks + shared 三包）
- pi 权威基准：已安装 `node_modules/@earendil-works/pi-coding-agent@0.84.1` + `@earendil-works/pi-agent-core@0.84.2` + `@earendil-works/pi-ai`（dist 编译 JS / d.ts，运行时真实行为）
- 版本漂移说明：`~/Code/git-fork/pi-mono-workspace/main` 可读 TS 源实测为 **0.80.3（落后于安装版）**，非任务书所述"可能领先"。本报告所有结论以安装版 dist 为准；TS 源仅作辅助，版本敏感处已注明。

## 1. 总结论

| 判定分类 | 计数 |
|---|---|
| 错误-已致废代码/功能失效 | 2 |
| 错误-潜在 bug | 2 |
| 错误-碰巧无害（代码不依赖该错误假设，但注释误导） | 6 |
| 未验证-风险 | 3 |
| 过时-版本漂移（锚点有效但依赖临时模块/行号） | 2 |
| 正确-已锚定（已核实，见 §3） | 22 |

**最重要的 3 条**：

1. **F1（critical）model-switch 的 switch 动作从未真正切换模型**：`switchToModel` 只做存在性检查 + `pi.appendEntry("model_change", ...)`，全仓无任何 `pi.setModel` 调用，却向模型返回 "Switched to X"。且 custom entry（type:"custom"）不是 pi 原生 model_change entry（type:"model_change"），session 重载也不恢复。
2. **F2（major，跨 5 包）「execute 返回 `{isError:true}` 即标记错误」是错误契约假设**：pi-agent-core 0.84.2 只在 execute **throw** / afterToolCall 覆盖 / block 路径置 isError；result 对象里的 isError 字段被静默丢弃（不进 ToolResultMessage、不进 tool_execution_end 事件、不进 provider is_error）。session-reader/ask-user/scheduler/subagent-workflow 的错误路径全部走该模式，导致 unified-hooks 工具错误审计系统性漏报。goal-control-adapter 与 structured-output 用 throw，是正确范本。
3. **F5（minor）pending-notifications 的「EventBus 进程级单例 + reload 累积监听器」rationale 在 0.84.1 不成立**：`pi.events.on` 返回 runtime 跟踪的 unsubscribe，session 替换/reload 时 `runtime.invalidate()` 自动清理（loader.js:170-172）；且 session 替换会新建 ResourceLoader→全新 eventBus。手工清理是双重冗余（无害），但注释描述的机制是错的，会误导后续维护者模仿"必要"模式。

## 2. 发现明细

### 错误-已致废代码 / 功能失效

**F1. model-switch：switch 动作无 `pi.setModel`，假成功**
- 位置：`extensions/model-switch/src/index.ts:322-347`（switchToModel）、`:201-209`（handleSwitch）
- 假设原文：工具描述 "switch (change)"；返回文案 `Switched to ${alias} (${provider}/${modelId}).`
- pi 实际行为：切模型的唯一 ExtensionAPI 是 `setModel(model): Promise<boolean>`（dist/core/extensions/types.d.ts:953-954，"Set the current model. Returns false if no API key available"）。`ctx.modelRegistry.find(provider, modelId)` 只是查找不切换。appendEntry 写的是 `type:"custom", customType:"model_change"`（session-manager.js:819-829 appendCustomEntry），而 pi 恢复模型只认顶层 `type:"model_change"` entry（session-manager.js:146-160 getSessionContextSettings），custom entry 恢复时被忽略。
- 判定：错误-已致废代码（switch 功能从未生效）
- 影响：`switch_model action=switch` 全路径无效果却报成功；`handleList` 的 "← current" 用 `ctx.model` 判定，与"Switched"文案自相矛盾；stickiness 记录的是从未发生的切换。
- 建议：`switchToModel` 中调 `const ok = await pi.setModel(match)`，`ok===false`（无 API key）时返回错误；持久化若需 pi 原生 entry 应依赖 setModel 触发的 appendModelChange，而不是 custom entry 冒名。

**F6. goal：STALE_CONTEXT_PATTERNS 与 0.84.1 实际 stale 文案零匹配（且为死代码）**
- 位置：`extensions/goal/src/session.ts:34-46`
- 假设原文：patterns `"stale context"` / `"stalecontext"` / `"extension context no longer active"` 等
- pi 实际行为：0.84.1 stale 文案为 `"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ..."`（runner.js:352、loader.js:167-169）。5 个 pattern 无一为其子串（"ctx is stale" ≠ "stale context"）。对比：scheduler 的 `STALE_CTX_MARKER = 'stale after session replacement'`（runtime.ts:28）能匹配。
- 判定：错误-已致废代码（isStaleContextError 无非测试调用方 + 模式失配双重废）
- 影响：当前无运行时影响（无调用方）；若未来被复用会静默失效。这正是 scheduler 注释里点名的"Error message 非契约 API"教训的残留。
- 建议：删除或改用与 scheduler 相同的 marker；长期方案是代际计数（scheduler G1）。

### 错误-潜在 bug

**F2. 跨包：tool execute 返回 `{isError:true}` 不被 pi 采信**
- 位置（全部非 throw 的错误返回）：
  - `extensions/session-reader/src/index.ts:167-177`（注释明言 "execute 不抛（pi 契约）"——契约理解反了）
  - `extensions/ask-user/src/index.ts:271、277-282、308-315`
  - `extensions/scheduler/src/index.ts:133-139、157-163`；`extensions/scheduler/src/tool.ts:100`
  - `extensions/subagent-workflow/src/interface/tool-workflow.ts:434-443、496-503`；`tool-workflow-script.ts:402、432`
- pi 实际行为（一手锚点）：
  - `@earendil-works/pi-agent-core/dist/agent-loop.js:453-483` executePreparedToolCall：正常 return → `{ result, isError: false }`，result 自身的 isError 属性不被读取；只有 catch → `createErrorToolResult` + `isError:true`
  - `agent-loop.js:525-547`：`tool_execution_end.isError` 与 ToolResultMessage.isError 均取 `finalized.isError`
  - `pi-agent-core/dist/types.d.ts:316-334`：AgentToolResult 类型本就不声明 isError（ask-user index.ts:31-34 的观察是对的，但推出的用法是错的）
  - pi 自带工具全部用 throw 表错（如 bash.js:345-347 非零 exit → `throw new Error`）
- 判定：错误-潜在 bug
- 触发条件：上述工具任一错误路径（session_read 的 F1-F6 错误、ask_user 校验失败/headless、schedule 未初始化、workflow not_found/invalid_args）
- 影响：① `unified-hooks` tool-error-handler 只看 `event.isError`（tool-error-handler.ts:79-81）→ 这些错误全部漏出审计；② 持久化 toolResult message 的 isError=false，session-reader/事后分析把错误轮当成功轮；③ provider 侧 is_error 标志未置。模型仍能从 content 文本看到错误信息（烈度降低但语义失真）。
- 建议：错误路径改为 throw（对齐 goal-control-adapter.ts "错误处理：用 throw new Error，不返回错误成功模式" 的既有正确规范）；或统一在 execute 末尾 `if (ret.isError) throw new Error(text)`。

**F8. subagent-workflow：「pi 不注册 SIGINT listener」在 suspend 窗口不成立**
- 位置：`extensions/subagent-workflow/src/index.ts:654-680`（sigintHandler re-raise）
- 假设原文："移除后无其他 SIGINT listener（pi 不注册）→ 默认行为终止进程"
- pi 实际行为：interactive-mode.js:3193-3223 `handleCtrlZ` 挂起期间注册 `ignoreSigint`（SIGCONT 时移除）。若 re-raise 恰落在挂起窗口（listener 仍在），重发的 SIGINT 被 pi 吞掉，进程不死。
- 判定：未验证-风险（窗口极窄：需 pi 挂起态 + 本 extension 收到 SIGINT；未实测可达性）
- 影响：挂起态下 Ctrl+C 收割链走完后进程可能存活。
- 建议：re-raise 前检查 `process.listenerCount("SIGINT")`，>0 时改用 `process.exit(exitCode)` 兜底。

### 错误-碰巧无害（代码不依赖错误假设，注释误导）

**F3. permission：「ExtensionUIContext 无 theme 字段」为假**
- 位置：`extensions/permission/src/index.ts:228-233`
- pi 实际：types.d.ts:174-175 `readonly theme: Theme` 在 ExtensionUIContext 内；rpc-mode uiContext 有 `get theme()`（rpc-mode.js:204-206）；goal/src/adapters/ports.ts:88-91 实际就在用 `ctx.ui.theme.fg`。
- 影响：无（该文件确实不该依赖 ctx.ui.theme，theme 来自 pi-statusline render 参数），但注释作为"类型权威"论据是错的。

**F4. unified-hooks：「headless/RPC 下 ctx.ui 可能为 undefined」为假**
- 位置：`extensions/unified-hooks/src/hooks/tool-error-handler.ts:35-41`
- pi 实际：runner.js:88-119 + createContext —— uiContext 恒为对象（默认 noOpUIContext；RPC 模式 `setUIContext(createExtensionUIContext(), "rpc")`，dialog-capable，notify 经 extension_ui_request 输出，rpc-mode.js:87-96）。
- 影响：无（`ctx.ui?.` 可选链多余）。同文件 "非法 type 降级 info" 的断言已验证正确（interactive-mode.js:2083-2092）。

**F5. pending-notifications：EventBus 单例/reload 累积 rationale 为假**
- 位置：`extensions/pending-notifications/src/index.ts:75-99`
- pi 实际：① `pi.events.on` 返回 `runtime.trackEventBusSubscription(...)`（loader.js:338-341），`runtime.invalidate()` 自动 unsubscribe 全部 tracked 订阅（loader.js:164-173）；session 替换 dispose（agent-session.js:556-568）与 reload（agent-session.js:2052-2056 invalidate 在重新 load 之前）都触发。② session 替换创建全新 DefaultResourceLoader → 全新 eventBus（main.js:581 → agent-session-services.js:63-68 → resource-loader.js:158），旧 bus 整体废弃。
- 影响：模块级 unsubscribers 手工清理是双重冗余（无害）；注释描述的"不清理会累积 N 组监听器"机制在 0.84.1 不存在，误导维护者。

**F7. session-reader parser：「custom entry 的 id 在 data.id 非顶层」描述失实**
- 位置：`extensions/session-reader/src/core/parser.ts:62-71`
- pi 实际：appendCustomEntry 恒写顶层 id（session-manager.js:820-828）；data.id 是扩展自己的业务字段（如 subagent-identity 的 payload）。fallback 分支对 pi 写出的 entry 是死分支（对历史/异构文件可能有用）。
- 影响：无（多一层兜底不改变解析结果）。

**F9. ask-user channel-handler：json/print 模式 `result.cancelled` 对 undefined 抛 TypeError**
- 位置：`extensions/ask-user/src/channel-handler.ts:106-127`
- pi 实际：noOpUIContext.custom 返回 undefined（runner.js:103），`result === null || result.cancelled` 第二项对 undefined 抛 TypeError。
- 影响：被 dialog-queue 兜底为 {cancelled:true}（channel-handler.ts:138-139 已注明该兜底）；主工具路径有 mode 守卫（index.ts:275）不会到达。属"有兜底的坏路径"。

**U3. session-pending：「triggerTurn steer 经进程内 EventBus 发送」机制描述失实**
- 位置：`extensions/subagent-workflow/src/execution/session-pending.ts:20-23`
- pi 实际：sendMessage → sendCustomMessage → `agent.steer/followUp`（agent 队列，agent-session.js:1081-1087），不经 EventBus（EventBus 只用于扩展间 pi.events）。所防御的毫秒级竞态本身真实存在（unregister entry 落盘与主进程 agent_end 判定的时序）。
- 影响：无（防御正确，机制描述错误）。

### 未验证-风险

**F10. jsonl-run-store：「首写立即可见（跨 session 重启 loadAll 从 entry 发现 run）」在首 assistant flush 前不成立**
- 位置：`extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts:26-29`
- pi 实际：`_persist` 在无 assistant message 且未 flush 时仅内存记账不落盘（session-manager.js:724-737）；首条 assistant 到达才以 openSync("wx") 全量写出（738-749）。新 session 里经 /wf 命令启动 workflow（主 session 尚无 assistant）的窗口内 crash，entry 不在盘上。
- 缓解：读序 entry > state 文件 > 空（state 文件由 store 自写，crash 恢复仍可发现 run）。
- 判定：未验证-风险（低；取决于 /wf 冷启动 + 窗口内 crash 的组合概率，未实测）

**U1. llm-shared：静态 import `@earendil-works/pi-ai/compat` 依赖显式标注为临时的模块**
- 位置：`extensions/shared/llm-shared/src/call.ts:5-10、17`
- 核实：compat.js 为真实模块且导出 completeSimple（dist/compat.js:195），探针结论对 0.84.x 成立。
- 风险：compat.js 头注释明言 "This module is deleted with the coding-agent ModelManager migration"——上游删除时本库顶层静态 import 会在加载期炸（波及所有 import 方）。判定：过时-版本漂移风险（当前正确、有明确拆除时限）。

**U2. subagent-workflow types.ts D1/R1 行号锚点绑定 0.84.0**
- 位置：`extensions/subagent-workflow/src/execution/types.ts:406-422`
- 核实：安装版 0.84.2 中 :240/:253（message_end）、:131（turn_end）、:106-113（error/aborted 先 turn_end 再 agent_end）、:546-551（emitToolResultMessage）全部对上，误差 ≤4 行；观测哨（logger.warn）设计使时序漂移可留痕。
- 判定：正确-已锚定，但行号级锚定随版本漂移需人工维护。

### 过时-版本漂移

- **F3/F4/F5/F7** 的错误认知多来自旧版 pi 行为或未验证的口头结论（同 F3 类）。
- **U1/U2** 见上。

## 3. 已核实为正确的假设（简表）

| # | 位置 | 假设 | pi 锚点 |
|---|---|---|---|
| C1 | scheduler/src/index.ts:20-27 | session 替换重跑 factory；extensionCache 只缓存 factory 对象 | loader.js:351-376（缓存 factory）、399-411（每次 `await factory(api)`） |
| C2 | scheduler/src/index.ts:31 | pi 替换前 await fire session_shutdown（teardownCurrent） | agent-session-runtime.js:102-113 |
| C3 | scheduler/src/index.ts:89-95 | turn_end 时本轮 message_end 已持久化 | agent-session.js:340-399（每事件先 emit extension 再 persist）+ agent-core 逐事件 await（agent.js:417-418） |
| C4 | scheduler/src/runtime.ts:28 | STALE_CTX_MARKER 匹配 stale 文案 | runner.js:352 文案含 "stale after session replacement" |
| C5 | subagent-workflow notifier.ts:53-84,165-178 | triggerTurn+steer 语义 / agent_end→finishRun 窄窗口丢通知 / busy steer 由 _handlePostAgentRun drain | agent-session.js:1068-1097（sendCustomMessage 分支）、758-782（hasQueuedMessages→continue）、327-335（isStreaming 在 settled 才 false） |
| C6 | structured-output workflow-hook.ts:104-105 | 同 turn tool_execution_end 先于 turn_end | agent-loop.js:113-131 |
| C7 | structured-output execute.ts + unified-hooks tool-error-handler.ts:46-48 | execute throw 时错误文本在 result.content[0].text | agent-loop.js:472-479 + 519-523（createErrorToolResult） |
| C8 | structured-output workflow-hook.ts:131 | stopReason "toolUse" 字面量 | pi-ai types.d.ts:273 StopReason 联合 |
| C9 | subagent-workflow stdin-writer.ts:94-96 / session-runner.ts:628-630 | rpc 模式只消费 stdin RpcCommand，-p/positional 被无视 | main.js:83-94（resolveAppMode）+ 741-744（rpc 直进 runRpcMode，prompt 参数只喂 InteractiveMode） |
| C10 | stdin-writer.ts:98-100 | pi 在 await rebindSession() 后才挂 stdin reader | rpc-mode.js:289（await rebindSession）先于 641-650（attachJsonlLineReader） |
| C11 | session-runner.ts:613-617 | `--session <file>` 续写原 session | SessionManager.open 路径（session-manager.js:614-644） |
| C12 | subagent-workflow index.ts:175 | 多 before_agent_start 的 systemPrompt 链式叠加 | runner.js:837-890（emitBeforeAgentStart 串联 currentSystemPrompt） |
| C13 | session-pending.ts:9-10,73 / session-reconstructor.ts:524-527 | appendEntry 同步写盘（首 assistant 前延迟）；文件不存在→error 保守不 kill | session-manager.js:724-759（_persist 延迟首写） |
| C14 | todo handlers.ts:52 / goal session.ts:53 | getEntries() 返回 filter-copy，splice 无效 | session-manager.d.ts:277-281（shallow copy） |
| C15 | rename-session pure.ts:289 | turn_end 每 iteration 一次，中间 stopReason=toolUse | agent-loop.js:88-131 |
| C16 | session-reader hash-provider.ts:159-161 | listAll('') falsy 走默认全盘分支 | session-manager.js:1289-1296 + utils/paths.js:58-79（normalizePath("")→""） |
| C17 | subagent-workflow list-component.ts:666-669 | close() 在 done 后调 component.dispose() | interactive-mode.js:2108-2121 |
| C18 | goal goal-control-adapter.ts:26-27 | pi 生产校验器 = typebox Compile(schema).Check(args) | pi-ai dist/utils/validation.js（getValidator/validateToolArguments） |
| C19 | goal agent-end.ts:170-176 | followUp 排队 → _handlePostAgentRun hasQueuedMessages → continue 新 turn | agent-session.js:758-782 + agent-core agent.js:234-256（continue 排空两队列） |
| C20 | permission index.ts:213-215 | pi 不保证 tool_call handler 跨调用串行（需自理 approvalChain） | 并行 tool_call 各自触发 emit（executionMode 默认并行）；emit 内 await 仅单事件内串行 |
| C21 | goal-control-adapter.ts（错误处理节）| 错误用 throw 不返回成功模式 | 同 F2 锚点（pi 契约即 throw） |
| C22 | ask-user index.ts:31-34 | AgentToolResult 类型未声明 isError（运行时标记） | pi-agent-core types.d.ts:316-334 |

另：extension-logger 的 appendEntry try/catch 兜 stale throw（loader.js:271-274 assertActive 抛）为正确防御；pending-notifications safeAppendEntry 同理。

## 4. 方法论声明

- **假设采集**（可复现）：
  - `grep -rn -E "(pi 会|pi 不会|pi 忽略|pi 先|pi 延迟|未确认|保守|防御|workaround|pi-mono|0\.8[0-9])" extensions --include="*.ts"`（排除 node_modules/dist；测试文件单独看）→ 181 行命中
  - `grep -rn -E "(pi 的|pi 在|pi 不|pi 先|pi 后|pi 侧|pi 层|pi 内部|pi 自己)" ...`（中文断言注释）→ 约 40 条高信号
  - `grep -rn "// " ... | grep -iE "pi (does|will|ignores|...)"`（英文断言）
  - 代码形态扫描：`appendEntry|sendUserMessage|deliverAs|getSessionFile|switchSession|setModel|isError|events.on|sessionManager.` 全领地
- **覆盖文件**：14 包 + shared 三包的全部 src/*.ts（598 个 TS 文件含测试；逐文件深读 ~45 个高信号文件，其余经上述 pattern 全量过筛）。测试文件仅用于交叉验证注释语义，不单独列 findings。
- **pi 源码核对方式**：一律读安装版 dist（0.84.1/0.84.2）的 .js/.d.ts 给行号锚点；fork TS 源（0.80.3）仅辅助理解，未作为任何结论依据。关键机制核对清单：_persist 首写延迟 / appendCustomEntry 顶层 id / getSessionContextSettings 模型恢复 / runner.emit 串行与错误隔离 / emitToolCall 无 try-catch / invalidate 与 trackEventBusSubscription / loader factory 缓存语义 / AgentSessionRuntime.teardownCurrent / rpc-mode stdin 时序 / interactive SIGINT-挂起与 showExtensionCustom.dispose / agent-loop 事件序与 steer/followUp 排空 / validateToolArguments(Compile+Check) / createErrorToolResult。
- **已知问题排除**：tmp 附着丢失、session_end 树索引污染、W16/W17 收敛项、closeChatIdle、ADR-0062（appendEntry 由 pi 持久化——本报告 C13 与其一致并补充了"首 assistant 前不落盘"边界 F10）。
