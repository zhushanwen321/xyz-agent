---
topic: subagent-engine-abstraction
complexity_tier: L2
created_at: 2026-08-24
---

# 设计进度 — subagent 执行层引擎中立抽象（pi / zcode）

**当前阶段：** mid-plan clarify（requirements.md + system-architecture.md 起草中，从设计文档提炼）
**主题目录：** `.xyz-harness/subagent-engine-abstraction/`
**复杂度档位：** L2（frontmatter；多模块单系统、5 Waves P1-P5、多 NFR 维度）

## 上游权威源

- 设计文档（已过三轮对抗式审查，达到可实施门槛）：`docs/architecture/subagent-engine-abstraction.md`
- 三轮审查报告：`.review/design-review-engine-abstraction-r2.md` / `.review/design-review-engine-abstraction-r3.md`

## 已完成阶段
| 阶段 | 交付物 | 审查 |
|------|--------|------|
| 设计（上游，CW 外） | docs/architecture/subagent-engine-abstraction.md（含 §3.3.5-§3.3.9 接口契约层） | ✅ 三轮对抗式审查通过（r3：0 must-fix） |
| CW create | topicId=cw-2026-08-24-subagent-engine-abstraction（tier=mid） | — |

## 下阶段必读
- mid-plan / mid-detail-plan / coding-execute SKILL.md
- 本主题全部上游交付物（见上表 + 本目录）

## 不可推翻的决策
- **直接 read `{topic}/decisions.md` 取 status=confirmed 且 classification=D-不可逆 的决策**（权威源，即时维护，不在本文件复制一份——消除双份维护漂移）
