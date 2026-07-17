# Code Review — fix-subagent-memory-leak

> 审查范围：commit b6e10e2a（W1+W2+W3 实现）+ commit 33157454（W4 测试）
> 审查方法：design-consistency（spec FR/AC 反查实现）+ 直接读代码审 type-safety/edge-case

## 发现的问题

### must-fix（已在 review 阶段直接修复）

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| R1 | design-consistency | subagent.ts:321 backToMain | **backToMain 误删主 session 消息**。chatEvict 回调调的是 `chat.evictSessionWithVirtual(mainSessionId)`，但 evictSessionWithVirtual 删整个主 session messages + 联动虚拟 key。用户 backToMain 只退出 subagent overlay，不该删主 session——返回主会话发现消息全没。 | 新增 `chat.evictVirtualKey(virtualId)` 只删单个虚拟 key（不动主 session/hydrated）。backToMain 改为 `chatEvict?.(virtualId)`。6 个调用方回调全改 evictVirtualKey。补回归测试"backToMain 只删虚拟 key 不删主 session"。 |

### should-fix（已在 review 阶段直接修复）

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| R2 | design-consistency | useSidebar.ts:395 deleteSession agentcall | deleteSession 的 agentcall 映射清理用 evictSessionWithVirtual(acsVirtualId)，对 agentcall virtualId 做了无意义的 isVirtualKeyOf 前缀扫（永远 false）+ hydrated 删除（agentcall 不在 hydrated）。行为正确但语义不对。 | 改为 evictVirtualKey(acsVirtualId)。 |

### 已验证无问题的维度

- **type-safety**：Panel.vue props.sessionId `string|null` 与 backToMain `string|undefined` 的 null/undefined 不兼容已修（`?? undefined`）。typecheck EXIT 0。
- **edge-case**：backToMain 幂等（清不存在 key 无副作用）有测试覆盖。tombstone 重进时 delete（selectSubagent L287）。
- **test-coverage**：52 测试全绿（m7 16 + chat-lru 8 + subagent 17 + chat-subagent-stream 11）。补了 evictVirtualKey 回归测试防 R1 回退。
- **plan-completeness**：W1-W4 全部 changes 落地，FR-1..8 全覆盖。

## 评分

- type-safety: A（typecheck 通过，无 any）
- edge-case: A（幂等 + tombstone + 主 session 不误删都有测试）
- design-consistency: A-（R1 在 review 阶段自发现自修复，说明 spec 的"立即清"描述未显式声明"只删虚拟 key 不删主 session"——这是 spec 隐含约束的盲点，但实现已正确）
- test-coverage: A（防假绿 + 真实工厂 + 负向测试 + 竞态测试）

## 审查结论

代码**就绪进 test**（R1/R2 已在 review 阶段直接修复 + commit + 测试验证）。核心风险点（backToMain 误删主 session）已闭环。
