# Plan Review · fast-fork

> 审查方法：禁读重建核验（主 agent 对着 spec FR/AC 清单逐条核验 dev-plan wave 覆盖度 + 架构合理性自审）。
> 审查日期：2026-07-22

## 1. 审查范围

- **重建维度**：从 spec 20 FR + 22 AC 重建期望的 wave 覆盖映射，与 dev-plan.json 的 4 wave × 19 changes diff
- **架构审查**：wave 拆分合理性 + dependsOn 依赖链 + 文件级改动清晰度
- **代码核查**：protocol.ts 现有 ServerMessageType（确认 FR-19 数据源）、config.sessions 广播机制

## 2. FR 覆盖度核验（20 FR 全覆盖）

| FR | 落点 wave | change file | 状态 |
|----|-----------|-------------|------|
| FR-1 SessionSummary 4 字段 | W1 | session.ts | ✅ |
| FR-2 active 路径 | W1 | types.ts + session-service.ts + session-lifecycle.ts | ✅ |
| FR-3 磁盘路径 | W1 | session-file-utils.ts + ports/session.ts + session-scanner.ts | ✅ |
| FR-4 JSONL forkEntryId | W1 | session-fork.ts | ✅ |
| FR-5 handedOffTo append | W1 | session-file-utils.ts | ✅ |
| FR-6 门控放开 | W2 | Turn.vue | ✅ |
| FR-7 每条 assistant fork | W2 | Turn.vue | ✅ |
| FR-8 双按钮 | W2 | Turn.vue | ✅ |
| FR-9 不 split | W2 | useSidebar.ts | ✅ |
| FR-10 forkSessionAsk | W2 | useSidebar.ts | ✅ |
| FR-11 删 ForkConfirmModal | W2 | Turn.vue + ForkConfirmModal.vue(delete) | ✅ |
| FR-12 反馈行 transient | W2 | ForkNotice.vue(create) + protocol.ts | ✅ |
| FR-13 composer 三重视觉 | W3 | Composer.vue | ✅ |
| FR-14 发送后退出 | W3 | Composer.vue | ✅ |
| FR-15 Esc + 切 session | W3 | Composer.vue | ✅ |
| FR-16 快捷键 | W3 | Sidebar.vue | ✅ |
| FR-17 ForkGroup | W4 | ForkGroup.vue(create) + SessionList.vue | ✅ |
| FR-18 分支血缘 | W4 | SessionItem.vue | ✅ |
| FR-19 后台管理 | W4 | useForkBranchNotify.ts(create) | ✅ |
| FR-20 parentSession fallback | W1 | session-service.ts + session-lifecycle.ts | ✅ |

**覆盖率 20/20 = 100%**。无 FR 遗漏。

## 3. 发现的问题

| ID | severity | dimension | ref | description |
|----|----------|-----------|-----|-------------|
| PR1 | should-fix | architecture | W4/FR-19 | FR-19 后台分支状态变更的数据源未明确。代码核查发现：runtime 现有 `config.sessions` 全量列表广播（含 status/outcome，session-service.ts:164），session 状态变更（isGenerating→idle/done）通过此广播感知。但 FR-19 "反馈行追加通知"需要精确路由到某条 fork-notice，config.sessions 只更新列表不触发反馈行追加。useForkBranchNotify.ts 需明确数据源：(a) 监听 config.sessions diff 对比分支 status 变化（前端驱动），或 (b) runtime 新增增量广播。W4 description 应注明选哪种，否则实现者不知数据从哪来。 |
| PR2 | should-fix | feasibility | W2 | W2 的 protocol.ts 加 `session.forkNotice` ServerMessageType，但 FR-12 反馈行 transient 渲染需要 runtime 在 fork 成功后**主动广播**这个消息。W2 的 changes 没列出 runtime 侧广播 forkNotice 的文件（session-lifecycle.ts 或 session-message-handler.ts 需在 fork RPC 成功后 broadcast）。当前 W1 改 session-lifecycle.ts（initializeManagedSession），W2 只列了前端文件 + protocol.ts，广播逻辑的落点不清。建议 W2 补 session-message-handler.ts 或明确广播在哪个文件。 |
| PR3 | nit | architecture | W1 | W1 改 8 文件超出"1-3 文件/Wave"建议，但这是类型链贯通的原子需求（拆了 typecheck 不过），属于"shared 前置识别"特例。合理，不需改。记录于此供未来参考。 |

## 4. 审查结论

plan 覆盖度 100%（20 FR 全覆盖），wave 拆分按 plan.md 的批次结构（W1 基础层 → W2 入口+行为 → W3 composer → W4 分支管理）合理，dependsOn 链正确（W2/W3/W4 → W1，W3 → W2，W4 → W1+W2）。2 条 should-fix 是数据流落点不够具体（PR1 通知数据源、PR2 forkNotice 广播文件），修复后 plan 更清晰，实现者不会迷失。

W1 的 8 文件超规模是类型链原子性的合理特例（shared 前置），不做拆分。

## 5. 修复记录（plan_review_fix turn 1）

2 个 should-fix 全部修复，dev-plan.json 已 replan 更新：

| issue | resolution | 验证 |
|-------|------------|------|
| PR1 (should-fix) | W4 useForkBranchNotify.ts description 明确数据源=监听 config.sessions 广播 diff 对比分支 status 变化（前端驱动，不新建 runtime 消息类型） | ✅ replan W4 description 含数据源说明 |
| PR2 (should-fix) | W2 补 session-message-handler.ts change（session.fork RPC 处理 :48-67 fork 成功后 broker.broadcast session.forkNotice） | ✅ replan W2 含 session-message-handler.ts modify |

修复后 W2 从 5 changes → 6 changes（补 runtime 广播落点），W4 description 明确数据源。turn 2 复查无新问题。
