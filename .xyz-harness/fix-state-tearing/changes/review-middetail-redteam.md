---
verdict: pass-with-conditions
reviewer: 红队·反过度编排（necessity & proportionality 单维度）
date: 2026-07-08
scope: decisions.md / execution-plan.md / code-architecture.md / non-functional-design.md / code-skeleton/*.ts
upstream_verdict: code-architecture=pass, nfr=pass, execution-plan=(未单独标，继承上游)
---

# 红队审查报告 — fix-state-tearing（反过度编排 / deletion test）

> 认知帧：站在「这个 Wave / 测试 / 骨架 / 枚举过度」的反方立场质询。
> 每条做 deletion test —— 删掉它 / 简化它会怎样？若「没怎样」或「更清晰」，则判定过度。
> 不修改任何文件。结论仅供主 agent 裁决。

## Verdict

**pass-with-conditions** —— 整体方案不过度编排（refactor 模式 + 8 issue 拆分合理，核心根因修复方向正确），但存在 **2 处 P0 过度设计**（pendingSend Set 化、骨架 dispatcher 漏检）+ **2 处 P1 比例性失衡**（finalizeSession 7-reason 行为折叠、sealed guard 测试覆盖冗余），必须修改后放行 dev。

核心判断：方案主体是「删代码」(chat.ts 删 8 加 6、resetActive 删除收口) —— 这是反过度编排的同盟，不是敌人。过度集中在两处「为未来铺路 / 为完整性铺路」的增项上。

---

## 过度编排发现（deletion test）

### 🔴 P0-1：pendingSend 用 `Set<string>` 是孤立的过度设计 [REVISIT D-002 scope]

**deletion test**：把 `pendingSend: Ref<Set<string>>` 降级为 `pendingSessionId: Ref<string | null>`，会怎样？

**会更好。** 理由：

1. **D-002 scope 误读**。D-002「L3 一次到位」原文语义 = 「派生模型 + send.rejected + 统一收口全做」。**不包含「多 session 并发流式」**。现有 `dispatchingSessionId` 就是单值 `ref<string | null>`（chat.ts:62，注释明写「单值，与 streamingSessionId 对称（双 panel 并发 DEFERRED）」）。pendingSend 接管的是 dispatching 的语义空窗，单值足够。

2. **Set 化与 streamingTimer 不对称 = 孤立升级的铁证**。骨架 `chat-store-skeleton.ts` 里 `streamingTimer` / `streamingTimerSid` 仍是 **单值**（`let streamingTimerSid: string | null`）。如果真的为多 session 并发铺路，timer 必须同步升级为 `Map<sid, timer>`。只升 pendingSend 不升 timer = 「以为在铺路，其实只铺了一半」。真到多 session 并发那天，timer 单值会被后一个 session 覆盖，pendingSend 的 Set 化反而掩盖问题。

3. **响应式开销反向**。不可变 Set 每次 add/delete 都 `new Set(prev).add(sid)`（骨架 addPendingSend 注释自述）——单值 ref 只需 `pendingSessionId.value = sid`。为「未来可能的多 session」付出每次 send 的 Set 拷贝，是负优化。

4. **测试侧连带膨胀**。T9.9「pendingSend Set delete 幂等 + per-session sid 隔离」整条用例的存在前提就是 Set 化。降级单值后，sid 隔离天然成立（单值只可能是当前 sid），该用例可删。

**裁决建议**：降级 `pendingSend` 为 `pendingSessionId: Ref<string | null>`，与 streamingTimer 单值对称。add/clear 改为赋值/置 null。`isActive` 改为 `isGenerating(sid) ∨ pendingSessionId.value === sid`。多 session 并发是独立 ticket（和 #9 P3 一起），届时 timer + pending 一起升 Map。

**若主 agent 坚持 Set**：必须在骨架里同步把 streamingTimer 升级为 `Map<sid, timer>`，否则承认 Set 化是半成品，标注 `// TODO: multi-session concurrent streaming (P3)` 且不得在单流场景宣称「L3 一次到位」。

---

### 🔴 P0-2：骨架 dispatcher 标 N/A 是漏检，非「改动小」

**code-architecture.md §7 核验表** 最后一行：

| dispatcher.sendPrompt 预检 | （骨架未单列…） | **N/A** | runtime 侧改动小，实现期直改；非新签名（私有方法加分支） |

**这是自相矛盾**。§2 签名表模块 F/G 明确：

- `sendMessage` / `sendSubagentMessage` 返回类型 **从 `{ blocked: boolean }` 扩展为 `{ blocked: boolean; rejected?: boolean }`** —— 这是**公开方法签名变更**，不是「私有方法加分支」。
- `session-message-handler.ts` 要新增 `rejected` 消费分支（reply `message.status{status:'rejected'}` vs sendError）——跨文件契约协作。
- NFR SV-4 自己标了「**catch 分类策略待 code-arch 决定**」（pi 拒绝走 send.rejected 还是所有 prompt 失败都走？）—— 这正是骨架该拍板的，却标 N/A 推给实现期。

**deletion test**：删掉 dispatcher 骨架，实现期靠什么保证 catch 路由分类正确？靠 issue #4 的文字描述？issue 描述和签名表已有矛盾（issue 说「预检」，签名表说「catch 也要分流」），没有骨架 tsc gate 兜底，实现期必然漏掉 catch 分支或返回类型扩展。

**裁决建议**：补 `dispatcher-skeleton.ts`，至少 stub：
1. sendPrompt 入口 `activeSession.isGenerating` 预检分支（return `{blocked:true, rejected:true}`）
2. catch 路径分类 stub（pi already-processing → broadcast send.rejected；其他 → broadcast message.error）—— **在骨架里就把 SV-4 的「catch 分类策略」拍死**，不得留给实现期
3. sendMessage/sendSubagentMessage 返回类型扩展签名
4. session-message-handler.ts rejected 消费分支 stub（可合并进同一骨架文件）

---

### 🟡 P1-1：finalizeSession 7-reason 行为实际只 3 类，映射表是「日志标签」非「行为分支」

**code-architecture.md §2 reason → 终态映射表**：

| FinalizeReason | Message.status | ToolCall.status |
|---|---|---|
| normal | complete | completed |
| aborted | complete | completed | ← 与 normal **行为完全相同**（D-008 拍板 abort 保持 complete）
| stream_error | error | error |
| error | error | error | ← 与 stream_error **行为完全相同**
| timeout | error | end_not_received |
| disconnect | error | end_not_received |
| restart | error | end_not_received | ← 三者 **行为完全相同** |

**deletion test**：finalizeSession 内部 switch 若按 7 值写，会有 7 个 case，其中 4 个是重复 body。若按「终态映射类」写，只有 3 个 case。

**这不是要求砍枚举**（7 值对日志/可观测/未来 abort→error 语义改进有用，D-008 已留口子），而是要求**骨架/实现指引明确**：

- `finalizeSession(sid, reason)` 内部第一步：`reason → {messageStatus, toolCallStatus}` 映射（3 类输出）
- 实体收口逻辑只分支 3 类，不分支 7 类
- `reason` 原值透传给 logger（可观测精度）

**风险**：若实现者照着 7 值映射表写 7 个 switch case（很自然的照表实现），会产生重复代码 + 未来加 reason 要改 7 处。骨架应在 `finalizeSession` 的 throw 注释里写明「行为按终态类分 3 支，reason 透传日志」，消除照表实现的歧义。

---

### 🟡 P1-2：sealed guard 6 handler 合理，但其测试覆盖（T4.7 + T9.5 + T9.6）冗余

**先肯定 sealed guard 本身不过度**。源码核实：现有 `text_delta` / `thinking_*` / `tool_call_start` handler（chat-message-effects.ts:255-340）**全部只检查 `findLastAssistantIndex >= 0`，不检查 status**。意味着 `setStreaming(false)` 后到达的 delta 会 append 到已 complete 的 message —— 这是真 bug。sealed guard 修的就是它。6 个 `if (!isLastAssistantStreaming(...)) return` 成本极低（O(1) status 查找），保留合理。

**过度的是测试覆盖**。同一 guard 被三条用例覆盖：

| 用例 | 断言 | 实质 |
|---|---|---|
| T4.7 | finalizeSession 后注 text_delta → 实体不变 | guard 行为 |
| T9.5 | delta sealed，tool_call_end 覆盖 | guard **边界**（M8 关键点，独立保留） |
| T9.6 | sealed 丢弃时 logger.debug 调用 | guard **日志**（dev-only，logger 实现细节） |

T9.5 必须保留（tool_call_end 不 sealed 是 SV-2 核心边界，且回灌 M8 高严重度风险）。T4.7 + T9.6 可合并进 T9.5：一条用例断言「finalizeSession 后 text_delta 丢弃（含 debug 日志）+ tool_call_end 覆盖」，三个断言一条用例。

**额外**：T9.6 断言 logger.debug 调用是**脆弱测试** —— 依赖 logger 实现细节（是 logger.debug 还是 console.debug？带什么前缀？），且 prod 默认 info 级不输出。dev-only 的日志断言投入一条独立用例，比例失当。

---

### 🟡 P1-3：finalizeSession 幂等性被 3 条用例重复测（T1.3 + T4.5 + T9.2）

| 用例 | 断言摘要 | 实质 |
|---|---|---|
| T1.3 | idle→streaming→complete 终态不可逆，再注 complete → no-op | sealed 幂等 |
| T4.5 | 两次 finalizeSession 同 sid，第二次 no-op | sealed 幂等 |
| T9.2 | (= T4.5 同断言) | 已自标重复 |

T9.2 已标注「= T4.5」，等于自认重复 —— 那就删 T9.2（回灌表保留映射关系即可，不产生独立用例）。T1.3 和 T4.5 可合并：T1.3 的「再注 complete → no-op」本质就是 T4.5 的「第二次 finalizeSession no-op」（complete handler 内部调 finalizeSession）。合并为一条「终态不可逆 + finalizeSession 幂等」多断言用例。

---

### 🟢 P2：以下质询项 deletion test 后判定**合理保留**（记录质询过程，非问题）

1. **2 Wave 结构 / W1 装 6 issue**：质询「W1 太重该拆」。核实后判定**不过度**。refactor 模式文件间强数据依赖（protocol 类型 → store API → effects handler → dispatcher 预检 → useConnection），拆 Wave 会产生「chat.ts 删了 setStreaming 但 effects 还调它」的编译失败中间态。execution-plan「内部执行序」已分 6 步，coding-execute 按步派串行 subagent 即不违反「5 文件/subagent」约束（项目 CLAUDE.md Subagent 约束 #2）。Wave 是逻辑分组，subagent 粒度是物理执行，两者解耦。**W1 不拆。**

2. **sealed guard 触发场景极窄**：质询「24h 默认下 timer 几乎不触发，guard 是死代码」。核实后判定**保留**。触发场景 = 「用户调小 XYZ_STREAMING_TIMEOUT_MS + pi 仍在 emit + timer 误触发」交叉，极窄但非零。且 D-003 明确让用户可调小阈值。6 个 if 守卫防的是「终态实体被 delta 污染」（数据完整性），成本收益比合理。死代码批评不成立。

3. **perf-chaos T8.1（scan n=1000 <1ms）**：质询「验证常识」。判定**保留但改断言阈值**。<1ms 在 CI 噪声下 flaky（GC 抖动、机器负载）。建议改为 `<< 50ms`（仍远低于 P99 感知阈值）+ 结构性断言「scan 限定 `messages.value.get(sid)` 不遍历全 Map」（这才是 per-session 隔离的本质保证，非绝对耗时）。

4. **骨架 4 文件密度**：质询「是否过度」。判定**不过度**。4 文件覆盖核心契约 + 去环 seam（effects ctx 注入）+ adapter 真引 SDK（usechat 真引 chatApi）。protocol-skeleton 1.8KB / chat-store 8KB / effects 8KB / usechat 7KB —— 密度合理，无空壳。**唯一缺口是 dispatcher（见 P0-2）。**

5. **D-001 / D-003 / D-004 / D-006~D-010**：逐条 deletion test，均未发现过度。D-003 timer 24h 是用户拍板的 UX 妥协（非过度，是「实质禁用超时兜底」的诚实表达）；D-008 abort 保持 complete 是行为等价基线（非过度）；D-009 runtime 预检优于字符串匹配（非过度）。**不逐条展开。**

---

## 必须修改

> 主 agent 裁决后落地。不修改任何源文件，只改设计文档/骨架。

### M1 [P0] pendingSend 降级单值（或同步升级 timer 为 Map）

**二选一**：

- **方案 A（推荐，长期合理）**：`pendingSend: Ref<Set<string>>` → `pendingSessionId: Ref<string | null>`。骨架 `chat-store-skeleton.ts` 改：pendingSend 字段、addPendingSend/clearPendingSend 改赋值/置 null、isActive 改 `pendingSessionId.value === sid`。execution-plan 删 T9.9（sid 隔离天然成立）。
- **方案 B（若主 agent 坚持 L3 含多 session 并发）**：保留 Set，但骨架同步把 `streamingTimer` / `streamingTimerSid` 升级为 `Map<string, {timer, startedAt}>`，并在 D-002 补记「L3 scope 含多 session 并发流式」。否则半成品。

**D-002 标记 [REVISIT]**：需向用户确认「L3 一次到位」是否含多 session 并发流式。若不含（现有 dispatchingSessionId 单值 + DEFERRED 注释强烈暗示不含），走方案 A。

### M2 [P0] 补 dispatcher-skeleton.ts

新增 `code-skeleton/dispatcher-skeleton.ts`，覆盖：
1. sendPrompt 入口 `activeSession.isGenerating` 预检分支（return `{blocked:true, rejected:true}` + broadcast send.rejected）
2. **catch 路径分类 stub**（SV-4 待决项在此拍板：pi already-processing → send.rejected；其他 prompt 错误 → message.error）—— 不得留给实现期
3. sendMessage/sendSubagentMessage 返回类型 `{blocked:boolean; rejected?:boolean}` 签名
4. session-message-handler.ts rejected 消费分支 stub（reply `message.status{status:'rejected'}`）

code-architecture.md §7 核验表「N/A」行改为 ✅ 并指向新骨架。

### M3 [P1] finalizeSession 实现指引：行为 3 支 / reason 透传日志

骨架 `chat-store-skeleton.ts` 的 `finalizeSession` throw 注释补充：
```
// 实现约束：行为按终态映射类分 3 支（complete/error/end_not_received），
// reason 值原样透传 logger（可观测精度），不按 7 值写 7 个 switch case。
```
非强制砍枚举（7 值保留），只约束实现期不照表写重复代码。

### M4 [P1] 测试用例瘦身（净删 3 条）

| 操作 | 用例 | 理由 |
|---|---|---|
| 删 | T9.2 | 自标「= T4.5」，重复 |
| 合并 | T4.7 + T9.6 → T9.5 | 三测 sealed guard，合并为一条三断言用例（delta 丢弃 + debug 日志 + tool_call_end 覆盖） |
| 合并 | T1.3 + T4.5 | 「终态不可逆」与「finalizeSession 幂等」同一不变式，合并多断言 |
| 改阈值 | T8.1 | `<1ms` → `<<50ms` + 结构性断言（scan 限定 get(sid)） |
| 删（M1 方案 A 连带） | T9.9 | pendingSend 降级单值后 sid 隔离天然成立 |

净效果：46 条 → 约 41 条（M1 方案 A）/ 42 条（M1 方案 B）。基数仍充足，去重后语义更清晰。

---

## 附：未质询项（明示不在本审查范围）

- 正确性维度（时序图 alt/else 是否覆盖全异常路径、不变式是否自洽）—— 非本红队维度
- 架构边界（store↔effects 去环 seam 是否真去环）—— 非本红队维度
- BC-1~BC-6 行为等价基线是否完整 —— 非本红队维度
- 上述由其他 reviewer 负责

---

**报告结束。Verdict: pass-with-conditions。M1+M2 为阻塞项（必须改），M3+M4 为比例性优化（建议改）。**
