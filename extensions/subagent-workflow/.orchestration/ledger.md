# Workflow 一次性生命周期实施 — Ledger

> 开发期协调脚手架（cw-orchestrator 机制：验收基线入 git → builder 开发 → verifier 对抗验收 → 主 agent 核对流转 commit）。权威规格：`docs/design/workflow-one-shot-lifecycle-impl-spec.md`。

## Unit 状态表

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|---|---|---|---|---|
| U1 行为删除 | orchestration + index + interface | committed | 2cff4d3f8（R6 后基线） | verifier PASS（.orchestration/acceptance/u1-report.md） |
| U2 类型与持久化收窄 | models + jsonl-run-store + gui 视图 | committed | ce9302111 | verifier PASS（.orchestration/acceptance/u2-report.md）；builder 两项裁决（abortRun 死分支删除不可达论证 / v1 fixture 用 running）均复核成立 |
| U3 文档回写 | README + CHANGELOG | pending | — | 前置 U2 ✓；含 U1 verifier 3 条环境注记（S7 脚本 @pi-meta / rebuild 日志 / 补全探测）+ U2 验收文档 fixture 描述修正 |

## Milestone Gate

| gate | 状态 | 报告 |
|---|---|---|
| one-shot 全场景（S1-S8 真实 pi 环境） | pending | — |

## 观察项（不阻塞，流转时如实记录）

- 存量测试失败 4 用例（skill-discovery ×2 / spawn-worktree-guidance ×2）：与本次 diff 无关已经 verifier 双重证实（文件交集空 + stash 基线复现）；属认知外存量问题，待单独决策修复或豁免
- U1 verifier 环境注记 3 条（转 U3 处理）：①手册 S7 注入脚本缺 `@pi-meta` 头（phases 必填，裸脚本 registry 标 available=false 以空脚本秒完成——U3 修子文档手册补 meta 头）；②rebuild 路径无 deps.log 调用，「日志含 rebuild 轨迹」断言以行为证据替代（若需日志可观察性另立小改动）；③pi rpc-mode 无补全探测入口，补全断言以源码 diff 为证

## 事件流水（时间倒序追加，永不覆盖）

- 2026-08-16 U1 verified→committed：verifier PASS（防篡改 diff 空 + 契约 7 条全过 + 真实 pi E2E S1/S2/S4/S7 三路全过：second 路 alpha session 恰 1 份 + beta 2 份 = discard 生效铁证、always 路 3 次耗尽、throwAt 分账）。存量 4 失败归因双重证实。commit 889a798f9。
- 2026-08-16 U1 R6 裁决：builder 上报 3 冲突（command-actions.test.ts / robustness-low-batch1.test.ts 规格遗漏、S8a grep 全域不可达）→ 测试清单扩 2 文件、S8a 改领地内断言、全域零命中挪 S8b；基线 2cff4d3f8。存量失败 4 用例待 verifier 核验归因。
- 2026-08-16 U1 builder 首轮交付：14 文件（7 源 + 7 测试），typecheck 0 / lint 0 error / 目标测试 76 绿；3 冲突停手上报（正确行为）。打回修复 C1/C2 后 16 文件全绿（2171/2175，4 豁免存量）。
- 2026-08-16 设计定稿：R3-R5 对抗审查收敛（R5: 0 must-fix），子文档 impl-spec 交付（commit 9ccfd44e1）。U1 acceptance 基线 commit 313005e1c。
