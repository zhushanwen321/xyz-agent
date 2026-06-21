# v3 后续修复 Wave Handoffs 索引

> Phase D（6 commit）已完成。本目录是后续优化修复的多 wave 规划。
> 每个 handoff **自包含**——新 session 只读单个 handoff 即可开工（含项目上下文、路径、禁忌、任务、验证、边界）。

## 依赖关系与执行顺序

```
Wave V (视觉验证) ──→ Wave P1 (token/组件精细度)
                  └──→ Wave P2 (MessageStream/Overlays 精细度)

Wave F2 (flow-2 数据契约) —— 独立，可任意时序
```

- **Wave V 必须先跑**：P1/P2 的部分决策依赖 V 的视觉确认
- **Wave F2 独立**：契约设计不依赖 V/P1/P2，可并行或最后做

## Wave 清单

| Wave | Handoff | 目标 | 前置 |
|---|---|---|---|
| **V** | `wave-V-visual-verify.md` | 验证 Phase D 6 commit 视觉效果，对比设计稿 | Phase D 完成 |
| **P1** | `wave-P1-polish.md` | token 同值/Button ring/Input error/ScrollBar/GitZone truncate/ProgressZone 空态 | Wave V |
| **P2** | `wave-P2-message-overlays.md` | OutputText 拆分/Reasoning 折叠/SearchModal z/SettingsModal head/Composer 间距 | Wave V |
| **F2** | `wave-F2-flow2-contract.md` | FileChanges 数据契约 types + runtime 解析方案设计（不实现 UI） | 无（独立） |

## 每个 Wave 的执行建议

- **一个 wave 一个新 session**（上下文隔离，避免累积漂移）
- 执行前：读完目标 handoff 的"项目与全局上下文"块 + "必读文档"列出的路径
- 执行中：遵守"硬禁忌"（尤其★不读图片、异步 dev server）
- 执行后：验证（tsc+lint+视觉）→ 按逻辑分 commit → 更新本索引状态

## 全局共享信息（所有 handoff 内联，此处为索引）

- 设计稿 SSOT 根路径（含空格）：`/Users/zhushanwen/Library/Application Support/Open Design/namespaces/release-stable/data/projects/5c80f187-ed73-415b-8c81-f825302eacbc/docs/designs/v3-demo/`
- 审计产出：`.v3-audit/`（results/ + batch-*-summary.md + decisions.md + phase-D-{plan,wave0}.md）
- Phase D commits：`git log --oneline -6`（e2b386ea / 39eee5da / 373f33d6 / c5723efa / 462e878e / 3a4a33e5）

## 状态

- [x] Wave V — 产出 `.v3-audit/verify/phase-D-visual.md`（6/6 commit 兑现，1 P1 + 5 P2 偏差）
- [x] Wave P1 — 产出 `.v3-audit/verify/phase-D-p1.md`（6 项完成，VLM 误判经像素裁决推翻）
- [ ] Wave P2
- [ ] Wave F2
