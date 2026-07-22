# Spec Review · fast-fork

> 审查方法：禁读重建（派 fresh subagent 只看 objective + clarifyRecords + 设计 SSOT 文档，不读 spec 初稿，从源头重建 FR/AC 蓝图，与初稿 diff）。
> 审查日期：2026-07-22

## 1. 审查范围

- **重建章节**：FR（25 条重建）+ AC（21 条重建），从 `fast-fork/spec.md` 14 节 + `handoff-fast-fork.md` + `fast-fork-merge-handoff-plan.md` 推导
- **diff 对象**：初稿 specSections（19 FR + 20 AC + 8 决策）
- **代码锚点**：全部 14 类锚点复验命中，行号 ±3 行内

## 2. 设计文档质量评价

设计文档六轮迭代质量很高：代码锚点精确到行号且全部命中，三层改动（入口/行为/管理）划分清晰，反模式 §11 和 transient/persist 两层语义（§8.3）区分到位。初稿 spec 基本忠实搬运了设计文档的核心 FR/AC。

## 3. 发现的问题

| ID | severity | dimension | ref | description |
|----|----------|-----------|-----|-------------|
| SR1 | must-fix | completeness | FR-1/FR-2/FR-4 | forkEntryId 数据一致性：parentSession 存源 sessionFile 路径，但活跃源 session 的 sessionFile 可能晚于 fork 落盘（pi 延迟写入，架构约定 #6）。fork 时源 sessionFile 可能 undefined → parentSession 写 undefined → 血缘链路断裂，FR-17 分支小列表 filter 永不命中。spec 假设 parentSession 有值但无 fallback 约束。需补 FR：parentSession 在源 sessionFile 未落盘时用 sessionId 作血缘键 fallback。 |
| SR2 | must-fix | consistency | FR-3 | ScannedSessionMeta 两处定义（session-file-utils.ts:272 + ports/session.ts:10）现状已不一致：前者有 outcome 字段，后者无。FR-3 只说"两处加 parentSession/forkEntryId/handedOffTo"，没要求先对齐 outcome。若实现者照搬现状，两处继续分裂。FR-3 需显式注明两处先对齐 outcome 再统一加字段。 |
| SR3 | should-fix | completeness | FR-19 | 后台分支完成/出错通知数据流不够具体。设计描述了三层落点（主线反馈行追加 + 侧栏状态点 + 未读角标），但 FR-19 只笼统说"经 WS 广播"。关键缺失：(a) fork-notice 运行期需在内存维护 fork-notice ↔ 目标分支 id 的映射（transient 不持久化但运行期需路由）；(b) 多个 fork-notice 并存时状态变更追加到哪条。这是验收最模糊的一块，需把数据流写实否则无法 vitest 断言路由正确性。 |
| SR4 | should-fix | completeness | AC-19 | 反馈行"查看"点击跳转的降级场景缺 AC。设计 §4 明确"源 session 已删除 → 查看降级为纯文本不可点"，但 AC 只覆盖正常跳转。需补 AC：mock 反馈行指向已删 session → 断言查看为纯文本不可点。 |
| SR5 | should-fix | completeness | outOfScope | 多级 fork 递归缺 outOfScope 明确。设计 §10.3 说"v1 只展示直接子一层"，FR-17 天然只 filter 一层（parentSession === currentSession.sessionFile）没问题，但 spec 无显式声明，实现者可能误以为要支持递归。补 outOfScope：多级递归不做（A→B→C，C 激活时不递归展示 B 的兄弟）。 |

## 4. NIT（不进 issue tracking，仅记录）

| ID | description |
|----|-------------|
| N1 | 术语统一：forkEntryId（持久化字段）/ piEntryId（runtime 截断参数）/ fromMessageId / msg.id（前端 Message 层）是同一概念（fork 锚点 entry）的不同名字。建议 plan 阶段统一术语映射表，避免实现者混淆。 |
| N2 | fresh 高亮 3.2s 是设计 §10.1 的 Open Question（可能应"点过一次才消"），但 AC 写死 3.2s。建议 AC 用常量参数化（FRESH_FADE_MS）断言，实现时可调。 |
| N3 | composer fork 模式应显式声明"复用主线 Composer.vue 单实例，通过 forkMode ref 切换，不新建独立 composer 组件"。 |
| N4 | streaming 中 fork JSONL 读取竞态（设计 §10.5）——设计已标注为"实现时二选一"缓解方案（回退上一条完整 assistant / 反馈行明示），属实现细节，spec 不提成独立 FR。但 plan/dev 阶段需确保实现者知晓此风险并选择缓解方案。 |

## 5. 审查结论

spec 整体质量良好，核心 FR/AC 覆盖设计文档的完整诉求。2 条 must-fix（SR1 parentSession fallback、SR2 ScannedSessionMeta 对齐）是真实数据正确性/类型一致性风险，必须在 plan 前补进 spec。3 条 should-fix 改善验收可判定性。修复后 spec 就绪进 plan。

设计 §10 Open Questions 里已识别的风险（streaming 竞态、sessionFile 延迟落盘）中，sessionFile 延迟落盘（SR1）必须提成 FR——它不是"实现时再定"的选择题，而是"不处理就血缘断裂"的必答题。streaming 竞态（N4）可留作实现缓解方案。

## 6. 修复记录（spec_review_fix turn 1）

5 个 issue 全部修复，specSections 已更新：

| issue | resolution | 验证 |
|-------|------------|------|
| SR1 (must-fix) | 补 FR-20 parentSession fallback（源 sessionFile 未落盘时用源 sessionId 作血缘键）+ AC-21 断言 fallback 生效 | ✅ specSections 含 FR-20 + AC-21 |
| SR2 (must-fix) | 修订 FR-3 注明两处 ScannedSessionMeta 必须先对齐 outcome 字段再统一加 fork 字段 | ✅ FR-3 detail 已含对齐要求 |
| SR3 (should-fix) | 修订 FR-19 拆细通知数据流：运行期内存维护 fork-notice↔分支映射 + 精确路由 + 未读角标 | ✅ FR-19 detail 已含 4 步数据流 |
| SR4 (should-fix) | 补 AC-22 反馈行指向已删 session 时查看降级为纯文本不可点 | ✅ specSections 含 AC-22 |
| SR5 (should-fix) | 补 outOfScope 多级 fork 递归展示（v1 只展示直接子一层） | ✅ outOfScope 含递归条目 |

修复后 FR 从 19 → 20，AC 从 20 → 22，outOfScope 从 7 → 8。turn 2 复查无新问题。
