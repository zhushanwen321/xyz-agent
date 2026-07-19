# Plan Review — fix-subagent-memory-leak

> 审查方法：spec 阶段已做两轮深度禁读重建审查（8 must-fix + 3 should-fix 全闭环），FR/AC/决策完整度高。plan 是 FR→Wave 映射，重建价值低。本阶段直接自审 coverage + architecture + feasibility。

## 审查范围

- spec FR 清单：FR-1/2/3/4/5/6/7/8（8 项）
- plan waves：W1（subagent 三段式）/ W2（清理链路 4 文件）/ W3（agentcall 映射 + chat-lru）/ W4（测试）

## FR → Wave 覆盖核对

| FR | Wave | changes | 覆盖 |
|----|------|---------|------|
| FR-1 三段式+结构校验 | W1 | subagent.ts subagentVirtualId/is/extract + 调用点 | ✅ |
| FR-2 agentcall 映射 | W3 | workflow.ts 映射 + chat-lru isVirtualKeyOf | ✅ |
| FR-3 backToMain 立即清+tombstone | W2 | subagent.ts backToMain + useSidebarSubagentActions + Panel.vue | ✅ |
| FR-4 backFromAgentCall | W3 | workflow.ts backFromAgentCall | ✅ |
| FR-5 deleteSession 时序 | W2 | useSidebar.ts evict 在 dispose 前 | ✅ |
| FR-6 Panel mainSessionId | W2 | Panel.vue getActiveSubagentVirtualId 参数 | ✅ |
| FR-7 tombstone 短路 | W2 | subagent.ts subscribeStream 终态检查 | ✅ |
| FR-8 测试修复 | W4 | chat-lru/subagent/chat-subagent-stream 3 测试 | ✅ |

**CW 的 mustFix warning（FR-1..5 未覆盖）是编号匹配问题**：旧编号匹配不到 CL2/CL3 新提交的 FR-1..8（覆盖了原始 5 个）。实际 8 FR 全覆盖。

## 发现的问题

### should-fix

| ID | dimension | ref | 问题 | 建议 |
|----|-----------|-----|------|------|
| PR1 | architecture | W2 | W2 有 4 文件（subagent.ts + useSidebarSubagentActions + Panel.vue + useSidebar.ts），是最大 Wave。但都属"清理链路"同一逻辑聚类（backToMain 立即清 + tombstone + deleteSession 时序），拆开会破坏原子性（backToMain 不加清理则 evictSessionWithVirtual 仍零调用）。 | 不拆，dev 阶段 W2 内分 commit：subagent store 签名变更一个 commit，调用方适配一个 commit。保持 Wave 不变。 |

### nit（只记录不进 issues）

- W4 测试文件 chat-subagent-stream.test.ts 的改动描述是"审计是否手写 key"——dev 时若该测试无手写 key 可能零改动，应更新为"验证三段式签名变更不破坏现有测试"。

## 审查结论

plan **就绪进 tdd_plan**。8 FR 全覆盖，依赖链 W1→W2/W3→W4 无环，feasibility 无问题（5 项缺陷均已验证代码事实 + 调用链清晰）。

PR1（commit 粒度）作为 dev 阶段执行指引，不阻断 plan。
