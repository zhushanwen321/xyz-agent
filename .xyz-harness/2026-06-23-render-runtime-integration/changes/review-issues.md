---
verdict: APPROVED
reviewer: independent-issue-reviewer（合并 v1+v2 终审）
review_target: issues.md
upstream: requirements.md, spec-w11.md, system-architecture.md
date: 2026-06-25
machine_check: PASS
review_history:
  - v1 (2026-06-24): APPROVED（3 非阻塞改进建议）
  - v2 (2026-06-25): CHANGES_REQUESTED（2 阻塞项 P1-1/P1-2，集中在 #1 async execFile 反哺）
  - 终审 (2026-06-25): v2 阻塞项已闭环 + 缺失覆盖表已补 → APPROVED
---

# 独立 Issue 审查报告（终审）— issues.md

> 本报告合并 review-issues v1（06-24，APPROVED）与 v2（06-25，CHANGES_REQUESTED）两轮审查结论。v2 的 2 个阻塞项已在终审前回填 issues.md，v1 的 3 个非阻塞建议也已落地。machine-check 8/9 PASS（含本轮补齐的「上游覆盖核验」表）。

## Verdict: APPROVED

issues.md 与上游 requirements.md、spec-w11.md、system-architecture.md 保持一致，F1-F12 全映射，C1-C15 决策均有对应 issue 或 AC，P0/P1 方案对比充分，优先级与依赖关系一致，迷雾处理干净（#13 升 P1 去 `?`），验收标准可执行。覆盖核验表逐条扫描 ② §5/§6.3/§7/§8/§10，无漏项。

---

## v2 阻塞项闭环确认

### P1-1（AC-3 grep 范围溢出 fix scope）— ✅ RESOLVED

**原问题**：#1 AC-3 曾写「AC-3 grep 范围扩到整个 `infra/`」，但 `infra/` 下 3 处 `execSync`（reconciler / trash.ts / process-manager.ts）中只 reconciler 在 fix scope，AC 按字面不可达。

**修复确认**：issues.md #1 方案 A「附带修复」段已收窄为「AC-3 grep 范围扩到 **git 相关** shell out（git-executor + reconciler）」，并补「AC-3 scope 边界」注释显式声明：reconciler 在 scope 内 ✅、trash.ts 归 #18 ❌、process-manager 非 git 无插值不纳入 ❌。AC（验收 line 190）措辞「git 相关 shell out (git-executor + reconciler) 无字符串形式」与 fix scope 对齐，可字面达成。

### P1-2（#1 execFileSync↔async 内部矛盾）— ✅ RESOLVED

**原问题**：#1 问题描述曾写「execFileSync 实现」，与方案 A「async execFile」自相矛盾。

**修复确认**：#1 问题描述（line 116）已改为「`async exec(){ ...execFileSync... }`（async 壳包同步调用，事件循环实阻塞）」——准确描述当前（待重构）状态，方案 A 是修复方向，两者不再矛盾。Runtime 细节（line 118）写「重构 execFileSync → async execFile」，AC（line 187）写「无 execFileSync」，全文自洽。

---

## 六维评分（终审）

| 维度 | 分 | 说明 |
|------|----|------|
| 1 完整性 | 10/10 | F1-F12 全映射；C1-C15 决策有 issue/AC 对应；覆盖核验表逐条扫描 ② §5/§6.3/§7/§8/§10，无漏项；#8↔#12 双向交叉引用已补 |
| 2 方案质量 | 9/10 | P0/P1 全 ≥2 方案 + 取舍依据来自系统性质；#1 DESIGN-IT-TWICE 三方向对抗有记录。扣：async 决策待反哺 code-arch（非 issues.md 问题，P2-1 非阻塞） |
| 3 优先级一致性 | 10/10 | P0 不依赖 P2/P3；blocked_by 与表一致；#8↔#12 软依赖已说明（可字符串占位，非硬阻塞） |
| 4 迷雾处理 | 10/10 | #13 升 P1 + [SURFACED]、标题去 `?`、章节「P1 续·冲突裁决」三者一致；#14-#17 P3 延后理由清晰 |
| 5 可执行性 | 9/10 | AC 多可 grep；C13/C14 新验收项齐全；占位符误报已修（#18 代码示例入代码块）。扣：#1 async 决策待同步 code-arch（P2-1，非 issues.md 自身） |
| 6 红队 | 8/10 | v2 红队 R3（trash.ts 真注入面）已登记 #18；refocus 双触发已补；R1/R4/R5 被驳成立 |

---

## v1 非阻塞建议落地确认

| v1 建议 | 状态 | 证据 |
|---------|------|------|
| #8↔#12 枚举补全交叉引用 | ✅ | #8 加「依赖 #12…可字符串占位」；#12 加「支撑下游 #8/#10」 |
| Wave 编号连续（去 W5 跳号） | ✅ | #13 从 W5 移至 W2，无跳号 |
| #13 迷雾项不占具体 Wave | ✅ | #13 升 P1 + [SURFACED] 修订，排入 W2 |

---

## 非阻塞遗留（不卡 issues.md APPROVED）

- **P2-1**：async execFile 决策待反哺 code-architecture §4.1/§4.2/§6.4 + system-architecture §11 AC-3。属下游同步，不卡 issues.md（issues 本身正确），但影响计划整体一致性，建议 code-arch 修订时同批处理。
- **P2-2**：C14 refocus 已补 `visibilitychange` + `window:focus` 双触发（#3 验收 line 273），覆盖最小化恢复与遮挡恢复。
- **A-04**：上游 spec-w11/requirements 的 pending 残留与 issues #8 [STALE] 方向相反（issues 正确），上游待同步，不卡 issues.md。

---

## 总体结论

issues.md 达到可进入下一步（④非功能性设计）的质量标准。v2 发现的 2 个阻塞项（#1 async execFile 反哺不彻底）已闭环：AC-3 scope 边界已显式声明、问题描述 execFileSync↔async 矛盾已消除。本轮补齐的「上游覆盖核验」表提供了「不漏项」的第一道防线（机器检查通过 + 逐条扫描）。红队 R3（trash.ts）是有价值的发现，已登记为 #18（P2 安全债）。

**APPROVED。**
