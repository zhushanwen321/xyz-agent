---
topic: search-modal
complexity_tier: L2
created_at: 2026-06-30
current_phase: nfr
---

# 设计进度 — search-modal

**当前阶段：** ④非功能设计（下一步执行）
**主题目录：** `.xyz-harness/2026-06-30-search-modal/`

## 复杂度档位

**L2（标准档）**

## 已完成阶段

| 阶段 | 交付物 | 审查 |
|------|--------|------|
| ①澄清需求 | requirements.md (+.html) | ✅ APPROVED |
| ②系统设计 | system-architecture.md (+.html) | ✅ APPROVED |
| ③Issue 拆分 | issues.md (+.html) | ✅ APPROVED |

## 下阶段必读

- 下阶段 SKILL.md（design-nfr）
- 本主题全部上游交付物（均在本目录）

## 不可推翻的决策

- 直接 read `decisions.md` 取 status=confirmed 且 classification=D-不可逆 的决策（D-001/003/004/005/006/011/012/013/016）

## 搭便车候选（待⑤骨架验证确认）

1. Sidebar keydown 接入命令注册表（#10，P2）
2. scrollIntoView → scrollIntoViewIfNeeded（#10，P2）

> debounce(120ms) 已按 D-020 从 #10 提前到 #7（P1），不再属搭便车候选。
