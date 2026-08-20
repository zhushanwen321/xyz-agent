# 对话流 turn 归属设计文档审查 r2 确认轮

> r1 报告：`conversation-turn-attribution.review.md`（0 must-fix, 4 suggestions）
> r2 对象：r1 后修复版 `conversation-turn-attribution.md`
> r2 日期：2026-08-20

## Summary

4 项 suggestion 修复全部落地且方向正确，新文本无过度承诺/矛盾/多源回归。发现 1 处跨引用不一致（§3.5 探针清单行号未同步更新），降级为 suggestion。

## 逐条复验表

| # | r1 suggestion | 修复位置 | 修复内容 | 判定 |
|---|-------------|----------|----------|------|
| S1 | D2 段补规则 9 张力显式声明 | §3.3 D2, line 135 | 新增「与规则 9 的张力显式声明」段：ephemeral 通道承担执行期实时可见（不进 messages）、turn 内 notice 承担持久可见（与文件一致），双通道分工达成规则 9 | **通过**。声明准确、不过度承诺，与正文 D2 选择一致 |
| S2 | §3.6 bash 待落列补生命周期声明 | §3.6 自查表, line 196 | 补充：session 删除随 Map 分区清理丢弃（挂接既有 cleanup 编排）；切 session 再切回 Map 分区隔离保留（flush 信号按 sessionId 定向）——两者为预期行为 | **通过**。生命周期与 ADR-0049 cleanup 编排一致，无新机制引入 |
| S3 | G1 补机制 3 UX 限制标注 | §1 目标表 G1 行, line 30 | 追加：「机制 3 的 UX（steer 视觉降级为 turn 内插话）依赖 D1b deferred，本设计只保证结构性一致 + 回归守卫」 | **通过**。诚实标注限制，与 D1b deferred 一致 |
| S4 | D5 兜底补降级可靠性边界预评估 | §3.3 D5, line 153 | 补充：指纹歧义取最后匹配位、零匹配走现状去重兜底、最坏表现 = 回退现状水平；探针 ③ 证实不保留时需回填命中率数据 | **通过**。边界明确，降级行为不劣于现状，探针 ③ 约束合理 |
| L1 | 行号修正 groupRenderInput | §1 line 10, §2.1 line 44 | `:136-166` → `:138-170`（两处） | **通过**。与源码实测一致 |
| L2 | 行号修正 bash-effects | §1 line 10, §2.2 line 60 | `:50-67` → `:55-95`（两处） | **通过**。与源码实测一致（bashStartEffect:55-75, bashResultEffect:78-95） |
| L3 | 行号修正 pi prompt 前 flush | §2.2 line 66 | `:844-845` → `:846` | **通过**。与 dist 实测一致 |

## 新文本对抗结论

逐条审查 4 处新增文本，无过度承诺、无矛盾、无多源回归：

| 新增文本 | 对抗攻击 | 结论 |
|----------|----------|------|
| S1 规则 9 声明 | ephemeral 通道是否真正「实时」？→ 是，bashStart 帧即时广播已有（bash-effects.ts），改挂不改时机。是否引入新状态源？→ 否，ephemeral 通道复用既有 composer/状态区形态 | 无问题 |
| S2 生命周期声明 | 「挂接既有 cleanup 编排」是否与实际机制名称一致？→ 实际机制 = `useSidebar.deleteSession` → `triggerSessionCleanups(id)`（ADR-0049 Code Review Checklist 第 4 条），bash 待落列作为 per-session Map 分区随 cleanup 丢弃，无需额外接线。flush 信号按 sessionId 定向是否真？→ 是，`settled-after-cascade` 信号带 sessionId（session 级事件） | 无问题 |
| S3 UX 限制 | 是否过度承诺「结构性一致」？→ 不是，steer 两侧一致是已验证事实（§2.3 机制 3 表），守卫是本设计新增 | 无问题 |
| S4 降级边界 | 「最坏表现 = 回退现状水平」是否过度承诺？→ 不是，现状 = id 去重（mutations.ts:74-84），降级兜底 = 同一 id 去重 + warn，功能等价。取最后匹配位是否有歧义风险？→ 有，但文档已声明需探针 ③ 回填命中率数据 | 无问题 |

## 跨引用不一致发现

§3.5 探针清单（line 183）的 pi dist 行号未随 §2.2 同步更新：

| 探针清单 (line 183) | §2.2 (line 66-67) 实际值 | 判定 |
|---------------------|--------------------------|------|
| `:844-845` | `:846`（已修正） | 跨引用不一致，应同步为 `:846` |
| `:986-1018` | `:986-1011`（已修正） | 跨引用不一致，应同步为 `:986-1011` |
| `:2225-2247` / `:744-756` / `:340-361` | 一致 | 通过 |

此为 r1 修复的遗漏同步项——§2.2 正文改了但 §3.5 探针清单的引用没跟着改。

---

```json
{"report_file": "/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/docs/architecture/conversation-turn-attribution.review.r2.md", "must_fix": 0, "suggestion": 1}
```
