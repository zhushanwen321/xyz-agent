# 对话流 turn 归属设计文档审查报告

> 审查对象：`docs/architecture/conversation-turn-attribution.md`（HEAD 3d9f31186 后工作区新增文件）
> 审查依据：rubric-design-doc.md + data-source-governance.md + data-source-registry.md + ADR-0049 + ADR-0062 + AGENTS.md
> 审查日期：2026-08-20

## Summary

0 must-fix, 4 suggestions. 设计文档整体质量高，问题定义精准触达根因（role 扫描 + 3 类消息绕过 entry 通道 + load-more id 空间分裂），方案直接对应每个机制，多源红线合规（§3.6 自查表经对抗验证无反例），关键事实引用全部经源码核实通过。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §3.3 D2 | P0-12 副作用 | D2 bash 延迟入流（streaming 期间挂起、级联末转 entry）与 AGENTS.md 规则 9「对话流状态必须实时可见」存在张力。设计以 ephemeral 反馈交代，但未显式声明与规则 9 的关系——审查者需自行推断「ephemeral 反馈 = 实时可见的实现形态」。建议在 D2 段加一句显式声明：「此设计选择与规则 9 的张力：bash 执行记录延迟到级联末算作 turn 内 notice，执行期间的实时反馈由 ephemeral 通道承担（不进 messages 数组），两者共同满足实时可见语义」。 | D2 段补规则 9 张力显式声明 |
| SUGGESTION | §3.6 自查表 bash 待落列行 | P0-12 副作用 | bash 待落列的生命周期在 session 删除/切换时的清理语义未显式声明。设计说「per-session Map，挂 activeSession 同区」，但未说明：(a) session 删除时 pending bash items 是否丢弃（合理行为，但需声明）；(b) 用户在 bash streaming 期间切换到另一个 session 再切回来，pending items 是否仍在（Map 分区保证隔离，但设计应确认这是预期行为）。ADR-0049 的 Map 分区范式 + cleanup 编排（useSidebar.deleteSession → triggerSessionCleanups）可覆盖，但设计作为 per-session 状态的引入者应显式挂钩。 | §3.6 自查表 bash 待落列行补生命周期声明（cleanup 挂钩 + 切 session 语义） |
| SUGGESTION | §2.3 机制 3 / §3.3 D1 | P1-5 MECE | 机制 3（steer 切分）在 §2.3 表中标注「结构性、两侧一致，属语义决策而非分叉」，D1 选择「保持开新 turn」并以 G6 为目标。但 §1 目标 G1 的描述（「steer 后重开分组不变，现状已一致，本设计加回归守卫」）给人印象是机制 3 已完全解决。实际上机制 3 的 UX 问题（一次逻辑响应被切成两组）被有意保留，D1b deferred 承认需要 pi 侧支持才能改进。建议在 G1 或 §3.1 终态描述中显式标注：「机制 3 的 UX（steer 视觉降级为 turn 内插话）依赖 D1b deferred，本设计只保证结构性一致 + 回归守卫」。 | G1 或 §3.1 补机制 3 UX 限制显式标注 |
| SUGGESTION | §3.3 D5 | P1-8 细节 | D5 兜底路径提到「锚 entry 已被 compaction 重写移除时（探针 ③），降级为按锚内容指纹定位切分点」，但探针 ③ 的描述（「hydrate 锚在 compaction 后的存活」）偏向二值结论（存活/不存活），未展开降级路径的触发率和可靠性。设计已将此标为「探针 ③」门控，但建议补充：若探针 ③ 结论为「compaction 不保留尾窗 entry id」，则内容指纹降级的可靠性边界（hash 碰撞率 / 多条相同 role+首段文本的歧义）也应一并评估，而非实施时再发现。 | 探针 ③ 补降级路径可靠性边界预评估 |

## 四大方向审查结论

### 1. 对抗式审查（方案薄弱点 / 反例 / 攻击面）

**结论：方案经对抗验证无致命薄弱点。**

逐项攻击结果：

- **「在什么情况下方案会失效？」**：(a) pi 未来改变 bash 落盘时机（从级联末变为即时）→ D2 的「镜像 pi 双分支」假设破功，但探针 ② 会在实施期捕获；(b) pi 未来为 steer user entry 添加可区分标记 → D1 的「两侧不可区分」论据失效，但这恰好解锁 D1b（正面）；(c) compaction 重写移除尾窗 entry → D5 兜底路径触发，已有降级设计。(a)(b)(c) 均有探针或兜底覆盖，不构成未防御的攻击面。
- **bash 待落列在异常路径的行为**：pi bash RPC 失败 → dispatcher catch 分支处理，无 entry 产生、无消息入流（§3.1 失败路径已声明）。pi 进程崩溃 → session 标 dead 态，pending items 随 session 状态丢弃（合理但未显式声明，见 suggestion 2）。
- **hydrate 锚的并发安全**：锚的唯一写方 = hydrate（一次性），唯一读方 = load-more。hydrate 和 load-more 不会并发执行（用户操作驱动），无竞态。

### 2. 问题定义审查（是否正确定义问题 / 是否真正解决目标问题）

**结论：问题定义精准，因果链完整闭合。**

- §1 定义的问题（5 个分组错乱机制）是用户可感知的真实现象，不是表面症状。§2.4 根因分析正确识别了三层根因：(a) 分组靠 role 扫描（传输属性充当产品语义），(b) 3 类消息绕过 entry 通道（live≠reload 构造性不成立），(c) load-more 的 id 空间分裂。
- 因果链验证：G1-G6 → D1-D6 → 机制 3/4/5/A/C 的映射完整，每个机制有且只有一个主修复决策，无遗漏无冗余。
- 机制 3 的处置（语义定案 + 回归守卫，D1b deferred）是否算「解决」：从 G6（全类型可回归）角度算——steer 两侧一致已有，回归守卫防止未来退化；从用户体验角度不完全——一次逻辑响应被切成两组的 UX 问题保留。设计诚实标注了 D1b deferred，不掩盖限制。

### 3. 副作用 / 遗漏 / 关键事实审查

**结论：关键事实引用全部核实通过，无影响决策的事实错误。**

详见下方「事实核实清单」。行号偏差均为 1-3 行的微小偏移（代码持续演进的正常现象），不影响决策。

遗漏项（已转化为 suggestions）：
- D2 bash 延迟入流与规则 9 的张力未显式声明
- bash 待落列生命周期未显式声明
- 机制 3 UX 限制未在目标描述中标注

### 4. 验收审查

**结论：验收章节完整、真实场景可执行、testable、回溯 G。**

- §4 存在 7 个验收场景（V1-V7），全部为真实环境操作（dev app / pi CLI），无 mock/桩/单测替代。
- 每个场景有明确通过标准（具体可观察的行为，非抽象断言），每个回溯 §1 目标（V1→G1, V2/V3→G2, V4→G3, V5→G4, V6→G5, V7→G6）。
- V7 包含等价性测试扩展（apply-entry-equivalence / custom-start-equivalence），覆盖 §2.2 表全部 5 行消息类型——testable 且有既有测试先例。
- Final gate（V1/V2/V4 在打包链 dev app 端到端复跑）确保打包形态也被覆盖。
- V5 的「触发健康警告」依赖真实 stream_warn（120s 无活动），实操有门槛，设计已提供「injected 帧模拟」降级但要求「以真实 stream_warn 一次为准」——合理。

## 多源真相回归专项审查

**结论：§3.6 自查表经逐行对抗验证，无多源真相回归风险。**

| 新增物 | 对抗攻击 | 结论 |
|--------|----------|------|
| 边界规则集 | 是否有第二写方？→ 否，纯函数派生，`message-turns.ts` 单一处。是否物化？→ 否，不落 store。 | 合规 |
| bash 待落列 | 是否有第二写方？→ 否，message-dispatcher 单点。是否物化缓存？→ 否，一次性中转（落定即清）。session 删除时？→ 随 Map 分区 cleanup（需显式挂钩，见 suggestion 2）。 | 合规（lifecycle 需补声明） |
| hydrate 锚 | 是否有第二写方？→ 否，hydrate 单点一次性写入。多次 hydrate（重进 session）？→ 新锚覆盖旧锚，行为正确（尾窗首条 entry 随新 hydrate 更新）。是否构成缓存？→ 否（无失效/回写问题）。 | 合规 |
| liveOnly 标记 | 是否有第二写方？→ 否，registry 单一创建点。是否物化？→ 标记即来源声明，不落 store。 | 合规 |
| trigger turn / inline notice | 是否物化？→ 否，分组派生，渲染层只读，不落 store。 | 合规 |

**D3 display 过滤挪渲染层后的「渲染过滤不丢消息」验证**：隐藏 COMPLETE_NOTIFY 消息参与 `groupRenderInput`（作为 turn 边界），但不进入渲染输出（渲染层过滤）。消息始终存在于 messages 数组中（reducer 写入、store 持有），「不丢消息」语义成立——隐藏消息不渲染但参与分组语义判定，正是设计意图。

**D6 user entry 化后 badge 回填链验证**：`appendUser` 返回 id 从 `u-${uuid}` 改为 reducer 派生 id，useChat 的 `clientUuid` 映射消费返回值（行为不变）；`custom` entry（`CLIENT_MSG_ID_TYPE`）的 `clientUuidMap` 回填由 reducer 的 `custom` case 处理（apply-entry.ts:607-620），与 user entry 化正交——badge 回填链不被破坏。

## 项目规范符合性审查

| 规范 | 判定 | 依据 |
|------|------|------|
| ADR-0049 Map 分区范式 | 合规 | bash 待落列 / hydrate 锚均为 per-session Map，符合「全局 sid 协调器例外类」模式（runtime/store 层非 Vue composable，无 sidRef）。session 销毁 cleanup 需显式挂钩（suggestion 2）。 |
| ADR-0062 绝对写规则 | 合规 | 设计不新增任何对 pi JSONL 的写路径。bash entry 化后经 `applyEntryFrame` 写入 reducer state（xyz 内存），不写 pi 文件。 |
| 规则 7.5「渲染过滤不丢消息」 | 合规 | display 过滤挪到渲染层后，隐藏消息仍参与分组、仍存在于 store，不丢消息。 |
| 规则 9「对话流状态实时可见」 | 部分张力 | D2 bash 延迟入流与实时可见存在张力，ephemeral 反馈作为补偿但未显式声明（suggestion 1）。 |
| 登记表 #7 例外列 | 合规 | 设计引用登记表 #7 例外列「分组语义归 fix-chat-flow-order」，与实际登记一致。D5 锚按 `@data-owner #7` 注解，符合登记表演进规约。 |
| 等价性测试先例 | 合规 | V7 引用 `apply-entry-equivalence.test.ts` 和 `custom-start-equivalence.test.ts`，两者均存在于 `packages/core/src/domain/chat/__tests__/` 且有实质内容。 |

## 事实核实清单

| 引用 | 文档声明 | 源码实测 | 判定 |
|------|----------|----------|------|
| `message-turns.ts:136-166` groupRenderInput | role 扫描：user 开新 turn、assistant 归当前、system 切断 | 实测 lines 138-170：逻辑完全一致（user→新 TurnGroup、assistant→归 current、else→current=null + static item） | 准确（行号偏 4 行，`136` 应为 `138`，不影响决策） |
| `message-turns.ts:83-85` filterDisplayableMessages | display===false 过滤 | 实测 line 83-85：`messages.filter((m) => m.display !== false)` | 准确 |
| `store.ts:335` appendUser 直插 | `u-${uuid}` id、乐观 send 与 drainN 两处调用 | 实测 line 335-349：id = `u-${crypto.randomUUID()}`，commitMessages 直插 | 准确 |
| `store.ts:373-384` drainN 计数 FIFO | 按 sendMode 匹配取前 n 条 | 实测 lines 373-405：逻辑完全一致 | 准确 |
| `store.ts:398-402` reconcilePending | 深度结构性对账 | 实测 lines 398-413：`prev.length > depth` 时裁剪到 depth | 准确 |
| `store.ts:434-437` applyEntryFrame | entry 喂 per-session reducer | 实测 lines 434-437：`entryStates.set(sessionId, applyEntry(cur, entry))` | 准确 |
| `bash-effects.ts:50-67` bash 直建 system 消息 | bashStart/bashResult 直建 messages 项 | 实测 lines 55-75（bashStartEffect）+ 78-95（bashResultEffect）：`bash-${uuid}` id、直插 messages | 准确（行号偏 5 行，`50` 应为 `55`，不影响决策） |
| `mutations.ts:74-84` prependHistory | 按 Message.id 去重 | 实测 lines 74-84：`existingIds = new Set(prev.map(m => m.id))` + filter | 准确 |
| `COMPLETE_NOTIFY_CUSTOM_TYPES` shared/message.ts | 常量 SSOT | 实测 line 20：`new Set(['subagent-bg-notify', 'workflow-result'])` | 准确 |
| `apply-entry.ts:588-598` custom_message | 完成通知类覆写 display:false | 实测 lines 583-598：case 'custom_message' + `isCompleteNotify ? false : display` | 准确 |
| `effects/registry.ts:250-257` stream_warn | 直插 system 消息 | 实测 lines 250-262：`s-${uuid}` id、role:'system'、直插 messages | 准确 |
| `effects/registry.ts:414-424` message_end → applyEntryFrame | entry 喂 reducer | 实测 lines 414-423：entry 形态守卫 + `ctx.applyEntryFrame(sid, entry)` | 准确 |
| `effects/registry.ts:84-96` countDrained | 计数差集 | 实测 lines 85-96：遍历 prev、splice remaining、收集 drained | 准确 |
| pi `agent-session.js:2225-2247` recordBashResult | 双分支：streaming 缓存、空闲立即写 | 实测 lines 2225-2247：`isStreaming ? push : push+appendMessage` | 准确 |
| pi `:744-756` _runAgentPrompt finally | flush + emitAgentSettled | 实测 lines 744-756：try/finally 内 `_flushPendingBashMessages()` + `_emitAgentSettled()` | 准确 |
| pi `:844-845` prompt 前 flush | 新 prompt 前 flush pending | 实测 line 846：`this._flushPendingBashMessages()` | 准确（行号偏 1 行） |
| pi `:986-1018` steer/followUp 展开 | skill/模板展开后入队 | 实测 lines 986-1016：steer() + followUp() 各自 `_expandSkillCommand` + `expandPromptTemplate` + `_queueSteer`/`_queueFollowUp` | 准确 |
| pi `:340-361` queue_update | 入队即发、消费时再发 | 实测 lines 305-315 (`_emitQueueUpdate`) + 340-365 (`_handleAgentEvent` splice + re-emit) | 准确（引用范围略宽，实际消费逻辑在 340-365） |
| `apply-entry-equivalence.test.ts` 存在性 | 等价性测试先例 | 文件存在，含 `replayEntries` + `liftHistoryToEntries` 确定性断言 | 准确 |
| `custom-start-equivalence.test.ts` 存在性 | custom 通知链等价性 | 文件存在，含 5 条红性依据 | 准确 |

**行号偏差汇总**：7 处引用中 4 处精确匹配、3 处偏移 1-5 行（代码持续演进的正常现象），无一行影响决策或架构判断。

---

```json
{"report_file": "/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/docs/architecture/conversation-turn-attribution.review.md", "must_fix": 0, "suggestion": 4}
```
