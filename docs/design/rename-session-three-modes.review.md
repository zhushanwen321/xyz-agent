# rename-session-three-modes.md 对抗式审查报告（主审）

> **轮次索引**：第 2 轮复审（v3）见下方；第 1 轮（v1）报告原文保留在文末「第 1 轮审查（v1）」节之后。

---

## 第 2 轮复审（针对 v3，2026-09-11）

> **审查范围**：核对 v2 五条修复（第 1 轮 2 MF + 3 S）是否成立（含四个指定攻击点的实装验证）+ v3 联动修复 + 交叉引用一致性终检。不重查第 1 轮已确认项；新问题标「新发现」。证据基线同第 1 轮：pi 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（`npm ls` 复核一致），全部断言实读 dist 编译 JS 核实。

### Summary

0 must-fix, 1 suggestion.

v2 两项 must-fix 的修复不止成立，且被实装静态证据**正向加固**——D2 的 message_end 主选在载荷形态、时序、过滤完备性、首条判定全场景正确性四个面上都被实装支持，其中触发时点断言比文档声称的更强（handler 全部同步段先于 appendMessage，而非仅 debugLog 先行）。五条修复全部核实通过，文档达到可实施状态。本轮唯一 suggestion 是验收观测判据的补强（V3/V10「工具不在清单」的确定性手段），不阻塞。

### v2 五条修复核对结论

| # | 第 1 轮 finding | v3 文档落点 | 核对结论 |
|---|---|---|---|
| MF-1 | D2 主选 turn_start 事实错误 | D2 改 message_end 过滤 user + event 载荷取文本 + entries user 计数首条判定；turn_start 移被否附静态证据 | ✅ 成立（证据链见「攻击点验证」1/2，实装四面上全部支持） |
| MF-2 | V2 完成序竞态断言不可稳定执行 | V2 改触发时点断言（handler 同步段早于 assistant message_start）+ 最终态断言，完成序不做 gate | ✅ 成立且比文档声称更强（await 链全程串行闭合，见「攻击点验证」3） |
| S1 | mode 求值时点未写明 + 无反向验收 | D1 求值时点段（事件面 live / 工具面 startup + execute 守卫）+ V10 | ✅ 成立（unregisterTool 确不存在：types.d.ts grep 无命中；extensionCache 缓存 factory：loader.js:118,412，闭包级变量 per-session 推理正确） |
| S2 | 命令名前缀不一致 | `config.getRenameMode`/`config.setRenameMode`（§5.2 u5 / §5.3） | ✅ 成立（对齐 protocol.ts 既有 `config.*` 前缀惯例） |
| S3 | V9 触发手段缺失 | V9 补 pi CLI RPC 触发 + 载荷形态断言 | ✅ 成立（事件载荷取值点实装核实，见「攻击点验证」补充） |

### 攻击点验证（实装证据链）

**1. message_end 载荷取文本（D2 主选成立性）——通过**

- 发射形态：`pi-agent-core/dist/agent-loop.js:51-54`，user prompt 以 `emit({type:"message_end", message: prompt})` 发射，`message` 为完整 message 对象（非摘要）。
- content 类型：`pi-ai/dist/types.d.ts:302-306` `UserMessage.content: string | (TextContent | ImageContent)[]`——双形态与 `joinTextBlocks` 处理匹配（rename-session llm.ts:54-63 拼 text blocks 跳过图片；string 分支先例在 llm.ts:78 与 :193 两处现成）。D2「复用 joinTextBlocks 拼接逻辑」实施上无缺口。
- 过滤完备性（role==="user" 不会误收哪些）：toolResult 消息 `role:"toolResult"`（agent-loop.js:534）；custom 消息 `role:"custom"`（agent-session.js:1100-1101，sendCustomMessage 路径 ：1137-1138 也发 message_end 但 role 非 user）——均被过滤天然排除。steering/followUp 消息 `role:"user"`（agent-session.js:1053-1054、:1070）——D2 的 steering 边界声明正确：到达时首条 user 已 append（见下），计数 ≥1 不触发，守卫天然覆盖。
- turn_start 被否证据复核：agent-loop.js:50 `emit(turn_start)` 先于 ：52-53 本轮 prompts 的 message_start/message_end——成立，与第 1 轮判定一致。

**2. 「entries user 计数 === 0 = 本条是首条」的恢复/续跑场景——通过**

- `getEntries()` 实装（session-manager.js:982-984）：`fileEntries.filter(e => e.type !== "session")`——**全量 append-only 视图**，不是 compaction-aware 的 active 视图（那是 `buildContextEntries()` :960-962，只影响 LLM 上下文）。
- 恢复场景：session 文件加载 `fileEntries = preloadedFileEntries ?? loadEntriesFromFile(...)`（:619）——老文件的 user message entries 全量进内存，续跑发新 prompt 时计数 ≥1，正确不触发。
- compaction 场景：entries append-only（:979-980 注释「Entries cannot be modified or deleted」），compaction entry 只改变 LLM 上下文视图，不删 user entries——计数不归零。
- branch 场景：`fileEntries` 重建为当前树路径（:1135/:1169），路径上任何 message 的祖先必含 user（对话由 user 起）——计数 === 0 仍蕴含本条是该路径首条 user。
- 结论：首条判定在恢复/续跑/compaction/branch 全场景语义正确，无「老 session 误触发」反例。

**3. V2 触发时点断言稳定性——通过，且比文档声称更强**

await 链全程串行闭合（每一环都被 await）：

```
runAgentLoop:53  await emit(message_end user)
  → agent-session.js:360 _handleAgentEvent
  → :384  await this._emitExtensionEvent(event)
  → :514  await this._extensionRunner.emitMessageEnd(extensionEvent)
  → runner.js:665  await handler(currentEvent, ctx)      ← handler 完整 promise 被等待
  （handler 返回后才开始）
  → :398  sessionManager.appendMessage(event.message)
  → runLoop → streamAssistantResponse → assistant message_start
```

- handler 内守卫链无真异步：`pi.getSessionName()` 实装为**同步方法**（session-manager.js:848-859；extension API 面 types.d.ts:989 `getSessionName(): string | undefined`），读内存 entries 逆向找 session_info。
- `callRenameLLM` 从入口到 debugLog 之间无任何 await（llm.ts:244-273：resolveModel 同步 → extract → truncate → build → debugLog → 才到第一个 await 即 callLLM；:242-243 注释明确该顺序契约）——「LLM request messages」日志必然在 handler 同步执行栈内打出。
- 因此静态上不仅是「debugLog 早于 assistant message_start」，而是 **handler 的全部同步段（含 callRenameLLM 前置与日志）都先于 appendMessage 完成**——V2 断言的时点基础是构造性的，非概率性的。

**4. V10 可执行性——基本可执行，判据观测手段需写明（→ 本轮唯一 suggestion）**

V10 各断言分解后多数有硬判据：自动命名不发生 = JSONL 无新 rename entry / label 不变（等待窗口后可查）；B 调用成功 = session_info entry 出现 + label 变化；残留工具被守卫拒绝 = toolResult isError entry。「prompt 让 agent 调用工具」对真实模型的依赖与 V3 同构（第 1 轮已接受该形态）。唯「工具不在清单」（V3「mode 为其他值起的进程工具不在 agent 工具清单」/ V10「A 起动时未注册，应无工具」）缺确定性观测手段说明：pi RPC 无工具清单查询命令（rpc-mode.js:217-219 的 `getToolsExpanded` 是 TUI 工具面板展开状态，RPC 模式显式不支持），实施者若去找清单查询通道会扑空。等价硬判据存在（无工具 ⇒ 无 toolCall entry），但文档未写明。

**V9 载荷形态补充核实**：事件载荷取值点是 agent-session.js:2446 `name: this.sessionManager.getSessionName()`（非原始传入串）——空串 setSessionName("") → appendSessionInfo sanitize 为 ""（:836）→ getSessionName 返回 undefined（:855 `entry.name?.trim() || undefined`）→ 事件 name=undefined → JSON 序列化丢字段。V9「name 字段缺失（undefined ≠ 空串）」断言精确成立（文档未引 :2446 这一关键环节，结论无误）。

**V7 warn 留痕补充核实**（v2 新增场景，第 1 轮未审）：extension-logger 语义 `warn/error` 走 appendEntry 持久化（extension-logger/src/index.ts:170-171「warn/error = appendEntry 持久化；debug 默认 no-op」），rename-session 工厂最早期 setPiHandle 注入（index.ts:29-30 注释）——`logger.warn("model not available, skipping")` 落 session JSONL custom entry 成立。

### 交叉引用一致性终检（通过）

| 检查项 | 结果 |
|---|---|
| D2 机制 vs §5 文件地图 | 一致：§5.3 index.ts 行含「message_end(role=user) 入口 + in-flight 去重 + rename_session 工具注册（load 时 mode===agent-tool）+ execute 内 live mode 守卫」；§5.2 u1「工厂闭包级 in-flight 去重」与 D2 v3 修正一致 |
| V10 vs D1 语义方向 | 一致：事件面 live 双向（A 切走即停、B 切回即恢复）、工具面按进程起动时 mode、防覆盖闭环（agent 名不被切回后首次自动命名覆盖）——与 D1 求值时点段、D2 防覆盖守卫、D3 execute 守卫互相咬合 |
| D8 vs §4 场景构成 | 一致：D8 声明 GUI 场景集 = V4/V5/V6/V10，§4 表中四者均为 GUI dev 场景；M1 挂 V1/V2/V3/V7/V8、M2 挂 V4/V5/V9、M3 挂 V4/V6/V10，无遗漏无错挂 |
| 附录 B v2/v3 描述准确性 | 一致：v2 描述的「in-flight 去重」在 v2 时点确为模块级（v3 描述明确记录了「模块级 → 工厂闭包级」修正，自洽）；v3 描述的 V10 方向修正、失败路径表两行（「mode 切走后残留工具被调用」「切回时一次性窗口已过」均在 §3.1 表中）、D8 对齐、ext-simplify-15 载体改判（附录 A 处置声明 + u2 撤销跨 worktree 写入）逐条与正文吻合；「验收 9 → 10 场景」与 §4 实数一致 |
| 行号引用 | message_end 的 on() 重载实为 types.d.ts:933（第 1 轮已注明 933 即 message_end——v1 引 933 说 turn_start 错、v2 改主选后 933 变为正确引用）；agent-session.js:384/:398 本轮直接复核吻合 |

### Findings（本轮新增）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|---|---|---|---|---|
| SUGGESTION（新发现） | §4 V3 / V10 | P0-13/14（弱）+ P1-10 | 「工具不在 agent 工具清单 / 应无工具」缺确定性观测判据：pi RPC 无工具清单查询命令（rpc-mode.js:217 `getToolsExpanded` 为 TUI 面板状态、RPC 模式不支持），「prompt 让 agent 调用」在无工具时 agent 行为不确定（道歉/忽略均可能），实施者若寻找清单查询通道会扑空 | 把判据写明为等价硬判据：该 session JSONL 无 rename_session toolCall entry（无工具 ⇒ 必无 toolCall，与 agent 行为无关）；可选加侧证——extension load 时按 mode 打一行注册/不注册 debug 日志（XYZ_AGENT_DEBUG=1 文件日志），harness 断言日志行 |

### INFO（不计 findings）

- V2 的「rename LLM 请求已发出」观测 proxy 是 debugLog（llm.ts:272），它**先于** callLLM 打出——日志出现证明「请求内容已定且在同一同步栈内即将发起」，严格说不等于 fetch 已发出（callLLM 内部到 fetch 间若有 await，发出点可能晚于 assistant message_start）。判据本身时点稳定（静态铁定先于 message_start）且有最终态断言兜底，不构成问题；实施者理解断言语义时知悉此半步差即可。
- 纯图片首条 prompt → joinTextBlocks 返回 ""（非 null）→ 会以空 prompt 发起 rename LLM 调用。与现状 first-stop 路径同构（extractUserPromptText 对 blocks 同样返回 ""，llm.ts:80），非本设计新引入；first-prompt 落地时可顺手加「空串 skip」守卫，属可选加固非必改。
- extension-logger 的 globalPi/loggerCache 为模块级共享态（index.ts:180-186 已登记单 session 约束），与 rename-session in-flight 闭包级的隔离策略不同——两者是损害面差异驱动的真差异（logger 污染仅影响日志路由 best-effort；in-flight 污染吞命名机会），非一致性缺陷。

### 判定更新（对照第 1 轮判定明细）

| # | 第 1 轮 | 第 2 轮 | 依据 |
|---|---|---|---|
| P0-11 关键事实 | 不通过 | **通过** | MF-1 修复核实（D2 message_end 主选，攻击点 1/2 证据链） |
| P0-13 验收可测试 | 不通过 | **通过** | MF-2 修复核实（V2 触发时点断言构造性稳定） |
| P0-14 真实场景 | 不通过（局部） | **通过** | V2 改道后无竞态 gate；V9 触发手段已补；V3/V10 观测判据留 suggestion |
| P1-10 负面行为 | 不完整 | **通过** | V10 落地 mode 切换双向反向断言（S1 修复核实） |

其余条目维持第 1 轮判定（本轮无新增反证）。

---

## 第 1 轮审查（v1）

> **审查对象**：`docs/design/rename-session-three-modes.md`（v1，2026-09-11）
> **审查归口**：主审条目 P0-1~11、13~18、21 + 全部 P1（P0-12/19/20 留影响面审，本文仅 INFO 交接）
> **证据基线**：全部事实断言实读本 worktree 源码核实——pi 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（`npm ls` 版本确认）；extension / runtime / renderer 源码与 `~/.xyz-agent/` 运行数据均为 2026-09-11 实读。

## Summary

2 must-fix, 3 suggestions.

文档整体质量高：三层根因（触发侧静默失败 / 显示侧扇出缺口 / 触发时机单一）全部实锤（本机复核 flag 开 + ref 空状态与文档一致），方案对比、决策四件套、探针降级、验收回溯齐备，绝大多数行号级断言与实装精确吻合（见文末核对清单）。两个 must-fix 均属「方案成立依赖的事实断言被 pi 实装静态反驳 / 验收断言不可稳定执行」：① D2 主选 `turn_start` 取 prompt 的前提在 pi 0.84.4 实装中不成立（turn_start 早于本轮 user message 落 entries，静态代码可证，P1 探针必失败）；② V2 的「session_info_changed 先于首条 assistant 完成」是两个独立 LLM 调用的完成序竞态，非稳定可断言。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D2（探针 §3.4 P1） | P0-11 事实 | D2 主选「`turn_start` + `extractUserPromptText(entries)`」依赖的前提「turn_start 到达时 entries 已含本轮 user message」被 pi 0.84.4 实装静态反驳（证据见下），首轮 handler 内取 prompt 恒为 null → first-prompt 主路径永不触发于首轮，仅会在 error 重试轮误触发。设计虽已列 ⛔P1 探针与降级路径，但「选定 vs 被否」的排序建立在错误事实上，且被否理由②（message_end「每次消息都触发回调再过滤」是缺点）恰恰否定了静态分析下唯一可行的入口——实施者按文档先做 turn_start 路径再被探针打回 = 白付一轮返工 | 主选改为 `message_end`（`payload.message.role==="user"` 过滤，prompt 文本取 `event.message` 而非 entries——实装中 message_end 的 extension handler 执行时该条亦尚未 append，`agent-session.js:384` 先于 `:398`，故必须用 event 载荷）；`turn_start` 移入被否并附实装依据；同时补一句 steering 消息也会走 message_end(user) 的边界说明（守卫链天然覆盖，防实施者意外） |
| MUST_FIX | §4 V2 | P0-13/14 验收 | V2 断言「RPC 事件流中 `session_info_changed` **先于**首条 assistant 完成（事件序断言）」不可稳定执行：该序是 rename LLM 调用（2-30s、64-token 输出）与主模型回复（流式、长输出）两个独立调用的完成序竞态——D5 空 ref 跟随后两者常为同一 provider，并发限流/排队/网络抖动即可翻转顺序。文档自称「事件序是全序、稳定可断言」，但全序 ≠ 该对事件的顺序稳定；flaky 验收会让实施者误判功能缺陷 | 断言改稳定形态：发起时点可稳定观测（首条 assistant `message_start` 前 rename 请求已发出——debug 内省日志 / JSONL usage entry 时点），或主断言保最终态三条件（标题落库 + 仅基于 prompt 语义 + 后续 round 不再改名）、完成序降为观察记录不设 gate |
| SUGGESTION | §3.3 D1 + §4 | P1-10 负面行为 | mode 分派的求值时点未写明：事件面（turn_end/turn_start handler）live 读 config，GUI 切 mode 即时生效；工具注册面（`registerTool`）仅 extension 工厂 startup 求值——切到 `agent-tool` 后**存量** session 没有 rename_session 工具（用户说「改名」agent 无工具），切回 first-stop 后存量 session 残留工具（轻微违反互斥）。验收无「切 mode 后存量 session 行为」反向场景 | D1 补「求值时点」说明（事件面 live / 工具面 startup，存量 session 不回溯 = by design 边界）；§4 补一条切换后存量 session 的反向断言或显式声明接受 |
| SUGGESTION | §5.3 文件改动地图 | 结构/一致性 | 新 settings 命令写作 `settings.getAutoRenameMode/setAutoRenameMode`，与既有同域命令前缀不一致（`packages/shared/src/protocol.ts:135-136` 全部是 `config.setAutoRenameEnabled` / `config.setRenameModel`，`settings-message-handler.ts:123-126` 同）。协议命令名是跨三层公共契约，实施后再改成本高 | 对齐 `config.getAutoRenameMode` / `config.setAutoRenameMode` |
| SUGGESTION | §4 V9 | P0-14 验收（弱） | 「手动触发清名路径（pi RPC set_session_name 空串）」未说明在 GUI dev 验收环境从何触达——GUI 手动 rename 是改名入口，无清名 UI；`pi.getSessionName()` 对空名返回 undefined（`session-manager.js:848-858` `entry.name?.trim() \|\| undefined`），JSON 序列化后 `name` 字段消失，event-adapter `event.name` 为 undefined——该路径行为正确但触发手段缺失会让验收无法执行 | 补具体触发手段（dev 工具直发 runtime RPC 到 pi 子进程，或临时脚本），并顺带断言事件载荷形态（name 字段缺失 ≠ 空串） |

### MUST_FIX 1 证据链（实读文件与行号）

1. `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:43-57`（`runAgentLoop`）：`emit(turn_start)`（line 50）**先于** prompts 的 `message_start` / `message_end`（line 51-54）发射。
2. `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:383-399`（`_handleAgentEvent`）：`await this._emitExtensionEvent(event)`（line 384，extension handler 执行点）**先于** `this.sessionManager.appendMessage(event.message)`（line 398，user message 进 entries 的唯一时点）。
3. RPC 路径无提前 append：`agent-session.js:821-949`（`prompt()`）只构造 messages 传给 `_runAgentPrompt`，append 全靠 message_end 事件。
4. 结论：turn_start 的 extension handler 执行时，`ctx.sessionManager.getEntries()` 必不含本轮 user message（首轮 entries 为空 → `extractUserPromptText` 返回 null → `skip: no user prompt`）。§3.4 P1 探针的结果可由静态代码直接判定为失败。

## 判定明细（主审条目）

| # | 判定 | 依据 |
|---|------|------|
| P0-1 五段骨架 | 通过 | §1-§5 五段齐备，层声明与证据基线明确 |
| P0-2 delta 链 | 通过 | 附录 B 变更历史 + 附录 A 与 ext-simplify-15 的吸收/冲突裁决（V3→V7 改道记录完整） |
| P0-3 结论先行 | 通过 | 一句话结论置顶 + SCQA 开篇；抽查 §2.2/§3.3 D4/§4 首句均为该章结论 |
| P0-4 问题定义 | 通过 | 三层根因各自带实测/实码证据；本机复核 `~/.xyz-agent/pi/agent/` flag 存在 + config `enabled:false`+`ref:""` 与文档 §2.1 断言一致。问题定义忠于真实问题（三模式为用户需求侧，非方案复述） |
| P0-5 重实现轻体验 | 通过 | §2.4 使用者视角小结 + §3.1 终态三模式场景段（先体验后机制） |
| P0-6 抽象术语 | 通过 | RMW/扇出/metaCache 首次出现均有定义或链路图锚定 |
| P0-7 方案对比 | 通过 | §3.2 三方案（A 单 extension / B runtime 侧 / C 拆三包） |
| P0-8 两维评估 | 通过 | 长期架构 + 短期成本两列齐 |
| P0-9 明确推荐 | 通过 | 裁决列 ✅/❌ + 被否后果示例（B 的双触发竞态推演具体） |
| P0-10 解决根因 | 通过 | D5 ↔ 根因①、D4 ↔ 根因②、D1-D3 ↔ 根因③，因果链闭合；D4 修的是结构性缺口（扇出）非表象 |
| P0-11 关键事实 | **不通过** | 见 MUST_FIX 1。其余断言全部实读吻合（核对清单见文末）：entry_appended 不在 on() 清单（全 d.ts 仅 `agent-session.d.ts:56` union 成员）、ctx.model（types.d.ts:222-223）、_persist 缓冲（session-manager.js:726-755）、setSessionName 事件链（agent-session.js:2444-2449）、onSessionRenamed 现状（index.ts:380-386）、event-adapter 转译（event-adapter.ts:1150-1164）、手动 rename broadcast（session-message-handler.ts:671-675）、smart-context 空串跟随注释（worktree-config-helper.ts:465-466）、useChat guard（useChat.ts:407-419）、pi 内置工具无 rename（dist/core/tools/ 实查：bash/edit/edit-diff/find/grep/ls/powershell/read/write） |
| P0-13 验收可测试 | **不通过** | 见 MUST_FIX 2（V2 竞态断言）；其余 8 场景 testable 且逐条回溯目标 |
| P0-14 真实场景 | **不通过**（局部） | V2 同上；V9 触发路径弱（SUGGESTION 5）。无 mock/单测充数问题——e2e 真实 pi 进程 + 真实模型，GUI Playwright 连 dev app |
| P0-15 投入匹配 | 通过 | 大改动（三新模式 + 行为变更 + 跨 4 层）配 9 场景 + 3 探针，无敷衍 |
| P0-16 运行时断言探针 | 通过 | 3 探针全带 ⛔ 门 + 失败降级路径（P1 探针本身被 MUST_FIX 1 的静态证据取代后应删除或改写） |
| P0-17 物理数据流图 | 通过 | §2.2 ASCII 链路图标明 pi 子进程/runtime/renderer 物理位置与断点 |
| P0-18 错误恢复 | 通过 | §3.1 失败路径 5 行均配具体恢复动作（config 修正路径 / 日志定位手段 / by design 说明） |
| P0-21 宿主不变量 | 通过 | V8（env 删除后无幽灵效果）、V9（清名不破坏 label 表面）构成反向场景；D4 覆盖面声明把 pi 原生 `/name`、RPC set_session_name 一并纳入。多改名累积场景缺失 → INFO 交接 |
| P1-1 概念例子 | 通过 | mode 三值各有 §3.1 场景段 |
| P1-2 拆分 justification | 通过 | §5.2 六单元各有理由（独立验收/回滚面） |
| P1-3 受众背景 | 通过 | §1 系统是什么 + universal/taiji 分组定位 |
| P1-4 alternatives 记录 | 通过 | D1-D8 全部有被否项与理由（含 audit cut 记录） |
| P1-5 MECE | 通过 | 8 决策无重叠；三层根因与决策一一对应 |
| P1-6 减法优先 | 通过 | 吸收 ext-simplify-15 删 env 层；A4/A5/C2 显式 cut；D4 被否项含「不加 fs watch/防抖」 |
| P1-7 scope 越层 | 通过 | 技术方案层下探到文件/函数级是「紧邻下一层=可实施任务」惯例，§5 有单元拆分承接 |
| P1-9 决策条目化 | 通过 | D1-D8「采用/被否/证据」四件套 |
| P1-10 负面行为验收 | **不完整** | 见 SUGGESTION 3（mode 切换后存量 session 无反向验证）；其余负面行为覆盖良好（V6 防覆盖、V8 env 残留、V3 工具不在清单断言） |

## INFO 交接（影响面审领地，不重复判定）

- **P0-12**：D4 落地后 GUI 手动 rename 路径会产生双整表广播（`session-message-handler.ts:674` 显式调用 + `onSessionRenamed` 事件回调各一次）——幂等无害，但属「接管既有流程」的连带行为，建议影响面审确认。
- **P0-19**：多次改名交错（自动 → 手动 → agent 工具）后 JSONL 内多条 `session_info` entry 的读取一致性（pi `getSessionName()` 逆向取最后一条已核正确，runtime scanner 侧未在本次审查范围内验证）无专项验收场景。
- **P0-19**：first-prompt 在 pi 首条 assistant 前的 `session_info` entry 仅驻内存（`session-manager.js:726-755` 已核），对磁盘扫描侧（非活跃投影）无影响——活跃 session 走内存 summary 合并（`session-scanner.ts:42-57`），该点文档结论正确。

## 事实核对清单（文档关键断言 × 实读结果）

| 文档断言 | 实读位置 | 结果 |
|---|---|---|
| extension `on()` 清单无 `entry_appended`，仅 AgentSessionEvent union 成员 | `dist/core/extensions/types.d.ts:906-951`（实际路径含 `core/`；907-942 为 on() 重载清单）；全 d.ts grep 仅 `core/agent-session.d.ts:56` 命中 | 吻合 |
| `turn_start` 实存（文档引 :933） | `dist/core/extensions/types.d.ts:929`（933 实为 message_end） | 事件存在，行号偏移 4（机械性，不计） |
| TurnStartEvent 形态 | `types.d.ts:579-583` `{type, turnIndex, timestamp}`——不带 entries/prompt，D2 只能经 `ctx.sessionManager.getEntries()` 取 | 形态吻合（并构成 MUST_FIX 1 的一部分） |
| `ctx.model: Model \| undefined` | `types.d.ts:222-223` | 精确吻合 |
| `registerTool` 实存（文档引 :944） | `types.d.ts:944` | 精确吻合 |
| `_persist` 首条 assistant 前缓冲、flush 于首 assistant | `dist/core/session-manager.js:726-755` | 精确吻合 |
| `appendSessionInfo` sanitize | `session-manager.js:835-846`（`replace(/[\r\n]+/g," ").trim()`） | 吻合 |
| setSessionName → appendSessionInfo → `session_info_changed` 事件照发 | `dist/core/agent-session.js:2444-2449`（`_emit` + `_extensionRunner.emit`） | 精确吻合 |
| RPC stdout 无过滤转发 | `dist/modes/rpc/rpc-mode.js:265-266`（`session.subscribe → output(toJsonEvent(event))`） | 精确吻合 |
| runtime `onSessionRenamed` 只 `setLabelCache` 不广播 | `packages/runtime/src/index.ts:380-386` | 精确吻合 |
| event-adapter 双路转译（kind session-renamed + message 定向帧） | `packages/runtime/src/infra/pi/event-adapter.ts:1150-1164` | 精确吻合（实际路径含 `infra/pi/`） |
| 手动 rename 显式 `broadcastSessionList()` | `packages/runtime/src/transport/session-message-handler.ts:671-675`（:674 调用） | 精确吻合 |
| `persistExplicitLabel` 语义名持久化 | `packages/runtime/src/services/session/session-lifecycle.ts:351-379`（357-358 handoff/agent-managed 枚举） | 吻合 |
| basename 兜底语义 | `session-lifecycle.ts:361-365` docstring + `session-scanner.ts:74`（`s.name ?? basename(s.cwd)`） | 吻合 |
| smart-context compactModel 空串跟随注释 | `packages/runtime/src/services/worktree-config-helper.ts:465-466` | 吻合 |
| rmwExtConfigField RMW 先例 + setRenameModel 同锁 | `worktree-config-helper.ts:279-301、332-342` | 吻合 |
| metaCache 键 (mtime,size) 自然失效 | `infra/pi/session-file-external-scan.ts:85,111`、`session-file-utils.ts` 多处注释 | 吻合 |
| renderer handleSessionRenamed + 空 name guard | `packages/core/src/domain/chat/useChat.ts:407-419`（:416 `if (msg.payload.name)`） | 精确吻合 |
| `parseRef("")` → null | `extensions/shared/llm-shared/src/resolve.ts:23-27` | 精确吻合 |
| `resolveModel` null → warn 静默跳过 | `extensions/universal/rename-session/src/llm.ts:244-249` | 精确吻合 |
| `buildTitleMessages(prompt, "", instruction)` 支持空 finalText | `llm.ts:131-141` | 精确吻合 |
| 配置 4 层优先级 / env 删除范围各段行号 | `pure.ts:239-254 / 74-114 / 53-57 / 243-251` | 全部吻合 |
| `normalizeRenameConfig` 4 字段同款 | `pure.ts:187-209` | 精确吻合 |
| startupConfig 深相等守护 | `src/__tests__/startup-config-declaration.test.ts:32`（`toEqual(DEFAULT_RENAME_CONFIG)`） | 吻合 |
| 本机「flag 开 + ref 空」实测 | `~/.xyz-agent/pi/agent/auto-rename-enabled` 存在（0 字节）+ config `enabled:false`+`ref:""` | 复核一致 |
| pi 内置工具无 rename 不撞名 | `dist/core/tools/`（bash/edit/edit-diff/find/grep/ls/powershell/read/write） | 吻合 |
| registerTool 同仓 4+ 先例 | ask-user / base-tool-enhance / cw-tool / plan / scheduler / session-manager / session-reader | 吻合 |
| `ensureAutoRenameDefault` 默认开 flag | `worktree-config-helper.ts:210` + `startup-background-init.ts:29` | 吻合 |
| i18n 键 RenameModelNotSet | 实际键 `settings.system.renameModelNotSet`（SystemAutoRenameSection.vue:19,22） | 键存在，大小写不精确（机械性，不计） |
| 「16 处 broadcastSessionList 先例」 | 实数约 12 处调用点 | 量级成立（机械性，不计） |
