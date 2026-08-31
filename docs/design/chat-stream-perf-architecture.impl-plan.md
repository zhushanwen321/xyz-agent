# impl-plan — 聊天链路性能架构改造（chat-stream-perf-architecture）

> 设计文档：[chat-stream-perf-architecture.md](./chat-stream-perf-architecture.md)（已对抗式审查修复，commit `9787c2611`，0 must-fix / 3 suggestion 全修）。
> **计划性质：事后补建**（代码先行倒挂场景——A/B/D 三单元已于 2026-08-31 实施并 committed，本计划按 dev-flow「状态恢复」校准规则依 git log 回建，供阶段 3 一致性审查与阶段 5 双级验收作为状态事实源）。
> **diff 审查区间**：`1fe7f4626..af96fa94c`（恰含 u-A / u-B / u-D 三个实现 commit）。

## 0. 章节映射（设计文档内容 → 实物位置）

| 设计文档章节 | 实物 |
|--------------|------|
| §2.1 数据流 / §1 背景目标 | 文档自身（背景性，无独立代码） |
| §2.2 + §3.1 候选 A | `packages/core/src/domain/chat/message-turns.ts` + `__tests__/message-turns.incremental.test.ts`（u-A） |
| §2.3 + §3.2 候选 B | `packages/core/src/domain/chat/apply-entry.ts` + `__tests__/apply-entry-fold-equivalence.test.ts`（u-B） |
| §2.4 + §3.3 候选 D | `packages/renderer/src/composables/features/sidebar/`（useSidebar 新轨）、`packages/core/src/domain/session/use-session.ts`、`useChatViewDeps.ts`、`useTraceJump.ts` + 59 文件批次（u-D） |
| §3.4 候选 C | 无代码（撤销登记 + 重启信号） |
| §4 验收 | Gate A（全量测试）+ Gate B（场景表逐行签收）；S1-S5 执行时点见文档 §4.2 引言（9787c2611 登记） |

## 1. 单元表与状态表

| 单元 | 内容 | 领地（白名单） | 证据 | 状态 |
|------|------|---------------|------|------|
| u-A | toRenderItemsIncremental 尾部快车道三车道 | core/domain/chat/message-turns.ts + 其增量测试 | commit `3fa710aee` | committed |
| u-B | apply-entry transient fold + ChatStateCollector | core/domain/chat/apply-entry.ts + fold 等价套件 | commit `3c099d409` | committed |
| u-D | useSidebar 双轨一次性收尾（含 selectSessionFallback 端口 + enterEmptyChatState + 重命名清扫） | renderer sidebar/session 编排 + core/domain/session + 59 文件批次 | commit `af96fa94c` | committed |
| u-doc | 设计文档产出 + 对抗式审查修复 | docs/design/chat-stream-perf-architecture.md | `a6414f1ba` + `9787c2611` | committed |
| u-gateA | Gate A 整体测试验收（core/renderer/ui 全量 + typecheck + lint） | 只读验证 + 本计划状态表 | 待执行 | pending |
| u-gateB | Gate B 验收场景表逐行签收（§4.1 证据复核 + §4.2 S1-S5 状态） | 只读签收 + 本计划状态表 | 待执行 | pending |

DAG：u-A ∥ u-B ∥ u-D（并行实施，文件集不重叠）→ u-doc（事后沉淀，已含审查）→ u-gateA → u-gateB。

## 2. 合理偏差登记表

（阶段 3 一致性审查产出后回填）

## 3. 残留风险与变更历史

- **2026-09-01 校准事件（计划补建）**：本计划非实施前置产物，系代码先行场景下按 git log（`3fa710aee` / `3c099d409` / `af96fa94c`）与工作区实物回建；基线 `1fe7f4626`（恰为本波次三实现 commit 之前最后一个 commit）。设计文档已经用户方对抗式审查并修复（`9787c2611`），审查结论登记执行时点：S1-S4 随下次 prerelease 真机验收执行、S5 随本分支首次 push 后 CI。
- **残留风险 R1**：u-B 的 real-pi 池（live-reload / relay-live-reload / broadcast-getstate / pi-protocol-contract / chaos）本地未跑，归 CI（S5）。
- **残留风险 R2**：本 worktree 存在并行会话的活跃提交与认知外改动（extensions/、`packages/shared/src/mandatory-extensions.json`、`scripts/probe-third-host-integration.mjs`）——不在本计划领地，Gate A 若因之出 failures 须归因区分，不计入本计划单元失败。
- **残留风险 R3**：S1-S4 真实场景收益实证未执行（登记时点：随下次 prerelease）——交付口径为「行为等价已锁定（测试级），收益实证待 S1-S5」。
