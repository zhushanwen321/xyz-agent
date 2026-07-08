---
verdict: APPROVED
review_round: 1
routes_merged: [needs, reconstruct-clarity]
machine_check: PASS
---

# review-clarity.md（CW clarify gate 面向）

> mid-plan review-fix-loop round 1 收敛后，合并需求完整性路 + 禁读重建路（需求部分）的结论。

## Verdict: APPROVED

需求完整性路（needs）verdict APPROVED，禁读重建路（reconstruct）报 4 条 MISSING（M1-M4）已在 round 1 修复：
- M1 editAndResend 路径 → 补 UC-5 + BC-5 + §7 useChat 行
- M2 stream_error/message.error 终态 → 补 AC-4.4/AC-4.5
- M3 isGenerating per-session → requirements §4/§3 已明确
- M4 landing 首发 → 补 UC-6

## must_fix（已清空）

无。所有 must_fix 已在 round 1 修复。

## should_fix（已纳入文档）

- needs#1 WS 断连 AC：requirements §7 声明归并到 runtime 重启路径
- needs#2 pendingSend 来源：requirements §3 对齐为 send 空窗来源
- needs#3 超时 BC 标注：requirements §7 补 BC 行

## nit（可选，不阻断）

- shared 层关联未在 §6 列出（文档完整性，非功能遗漏）
- AC-3.2 reason 表述混合（已部分修复）

## per-route 溯源

- [from review-midplan-needs] APPROVED，3 should_fix 已纳入
- [from review-midplan-reconstruct] CHANGES_REQUESTED → 修复后 APPROVED，4 MISSING 已补
