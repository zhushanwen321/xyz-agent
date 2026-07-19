# Spec Review — fix-subagent-memory-leak

> 审查方法：禁读重建（派 fresh subagent 只给 objective + clarifyRecord，不读 specSections，从零重建期望 spec，再与初稿 diff）。

## 审查范围

- 重建章节：FR(9) + AC(16) + 隐含需求(9) + 决策(9)
- 初稿章节：CL1 提交的 background + FR(5) + AC(7) + decisions(3) + outOfScope(3)
- diff 维度：completeness / consistency / reasonableness

## diff 结果（按 severity）

### must-fix（初稿遗漏/错误，不修会导致 dev 跑偏）

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| SR1 | completeness | FR-3 | **streaming 中 backToMain 策略完全缺失**。初稿说"无条件清"，但 subagent 还在 streaming 时清 messages 会损坏在途写入 + 终态 fetchAndInject 复活竞态。isLruExempt 守卫只覆盖 LRU 自动驱逐，不覆盖用户主动 backToMain。用户已决策：等终态再清。 | 改 FR-3：backToMain 只解绑 UI 订阅（已有 stopStream），不立即清 messages。等 subscribeStream 终态回调（lines===undefined）执行清理。补终态清理逻辑。 |
| SR2 | completeness | FR-7(新) | **终态回调竞态防护缺失**。subscribeStream 终态分支的 fetchAndInject 是 fire-and-forget Promise（void ... .catch()），backToMain 后若该 Promise 在途，完成后会 setMessages 复活已清 messages。 | 补 FR-7：cleared tombstone。backToMain 标记 virtualId cleared，终态 fetchAndInject 回调检查 tombstone 短路。重进时 tombstone 重置。注意：SR1 决策"等终态再清"下，tombstone 仍需防"用户返回后又重进再返回"的多周期竞态。 |
| SR3 | completeness | FR-5 | **deleteSession 时序未定**。初稿 FR-5 说 evictSessionWithVirtual 在 disposeSession 前调，但没固化。evict 需按 mainSid 前缀扫虚拟 key，若 dispose 先删主 session 记录，evict 内部反查会失败。 | 补决策 DR5：evictSessionWithVirtual(mainSid) 在 disposeSession(mainSid) 之前。INVAR-5.2。 |
| SR4 | completeness | FR-2 | **agentcall 清理归属未定**。初稿 FR-2 留作"plan 阶段定"，但这是 spec 级决策。agentcall 不含 mainSid，主 session dispose 无法前缀定位。用户已决策：mainSessionId→agentcall 映射。 | 补 FR-2：workflow store 维护 mainSessionId→Set<agentCallVirtualId> 映射。selectAgentCall 记录，deleteSession 经映射清全部。补决策 DR6。 |
| SR5 | completeness | FR-6(新) | **Panel.vue mainSessionId 解析缺失**。getActiveSubagentVirtualId 加 mainSessionId 参数后，Panel.vue:220 怎么拿 mainSessionId 没展开。 | 补 FR-6：mainSessionId 从 props.sessionId（承载 panel 的 session id）取。INVAR：空 panel / 非 main session guard 返回 null。 |
| SR6 | completeness | FR-1 | **extractSubagentId 返回契约未定**。改三段式后返回第三段 subId 还是 mainSid:subId？消费方 MessageStream.vue:160 extractSubagentId(props.sessionId) 依赖返回值。初稿没明确。 | 补决策 DR9：extractSubagentId 返回第三段 subId（保持消费契约不变）。消费方枚举确认。 |
| SR7 | completeness | FR-8 | **测试修复范围不全**。初稿 FR-4 只提 chat-lru.test.ts，但 subagent.test.ts / chat-subagent-stream.test.ts 极可能也手写虚拟 key。且缺旧两段式 key 负向测试。 | 补 FR-8：审计全部 3 个测试文件 + grep 'subagent:'/'agentcall:' 字面量。补旧两段式 key 负向测试（isSubagentVirtualId('subagent:foo') 返回 false）。 |
| SR8 | consistency | objective | **objective 描述了不存在的问题**。objective 说"split 多 panel 缺引用计数"，但 CL1 已确认架构排除此场景（单 panel 承载）。spec 须保留"为何不需要引用计数"论证防回退。 | 补 C-7：保留 CL1 四条架构事实作设计锚点。任何 PR 引引用计数应被 block。 |

### should-fix

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| SR9 | reasonableness | FR-1 | isSubagentVirtualId 只 startsWith('subagent:') 不够，需三段结构校验（排除旧两段式残留 + 误传）。 | 补 INVAR-1.4。 |
| SR10 | completeness | FR-2 | isSubagentVirtualId 与 isVirtualKeyOf 职责分离未声明（结构判定 vs 归属判定），易混用。 | 补 C-9。 |
| SR11 | completeness | 全局 | extractSubagentId 消费方枚举缺失（改三段式最易踩的破坏点）。 | 补 C-8。 |

### nit（只记录不进 issues）

- AC-12（split 场景 panel 解析）、AC-16（streaming 中返回体验）标 manual 合理。

## 审查结论

spec **未就绪进 plan**。8 个 must-fix（含 2 个核心策略缺失 SR1/SR2、2 个决策未定 SR3/SR4、3 个 FR 遗漏 SR5/SR6/SR7、1 个 objective 矛盾 SR8）。须进 spec_review_fix：用 cw clarify 追加修正后的完整 specSections 后复查。

关键教训：初稿虽基于深度代码调研，但只覆盖了"格式不匹配"这个表层缺陷，漏掉了 streaming 竞态（SR1/SR2）、deleteSession 时序（SR3）、agentcall 归属（SR4）三个深层交互问题。这些是 dev 阶段必然踩的坑，必须在 spec 锁死。

---

## 复查（spec_review turn 2，fix 后）

修复方式：CL2 提交完整修正 specSections（FR 8 + AC 11 + 决策 9），CL3 修正 FR-3/FR-7（立即清+tombstone 撤销等终态）。

关键修正：SR1/SR2 的"等终态再清"方案存在实现矛盾（backToMain 已 stopStream，终态回调不触发），经用户确认改为"立即清 + tombstone"——更简单且等价。

逐条核对：
- SR1（streaming backToMain）：FR-3 改为立即清+tombstone。✅
- SR2（终态竞态）：FR-7 tombstone 短路迟到 fetchAndInject。✅
- SR3（deleteSession 时序）：D5 evict 在 dispose 前。✅
- SR4（agentcall 归属）：D6 mainSessionId 映射。✅
- SR5（Panel mainSessionId）：FR-6 从 props.sessionId 取。✅
- SR6（extractSubagentId 契约）：D9 返回第三段 subId。✅
- SR7（测试范围）：FR-8 审计 3 文件 + 旧格式负向测试。✅
- SR8（objective 矛盾）：C-7 设计锚点。✅
- SR9/SR10/SR11（should-fix）：INVAR-1.4 结构校验 / C-9 职责分离 / C-8 消费方枚举。✅

复查结论：**spec 就绪进 plan**。所有 must-fix/should-fix 已闭环，无新问题。
