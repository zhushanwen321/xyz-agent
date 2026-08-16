# Workflow 一次性生命周期实施 — Ledger

> 开发期协调脚手架（cw-orchestrator 机制：验收基线入 git → builder 开发 → verifier 对抗验收 → 主 agent 核对流转 commit）。权威规格：`docs/design/workflow-one-shot-lifecycle-impl-spec.md`。

## Unit 状态表

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|---|---|---|---|---|
| U1 行为删除 | orchestration + index + interface | pending | <待填：acceptance commit> | |
| U2 类型与持久化收窄 | models + jsonl-run-store + gui 视图 | pending | — | 前置 U1 |
| U3 文档回写 | README + CHANGELOG | pending | — | 前置 U2 |

## Milestone Gate

| gate | 状态 | 报告 |
|---|---|---|
| one-shot 全场景（S1-S8 真实 pi 环境） | pending | — |

## 事件流水（时间倒序追加，永不覆盖）

- 2026-08-16 设计定稿：R3-R5 对抗审查收敛（R5: 0 must-fix），子文档 impl-spec 交付（commit 9ccfd44e1）。U1 acceptance 基线 commit 待记。
