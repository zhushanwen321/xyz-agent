# Code Review：sidebar-perf-p0

**审查方法**：派独立 subagent（未参与实现）逐 commit 审查 6 个 Wave 的 diff + 上下游调用链 + 类型定义。
**审查日期**：2026-07-16

## 审查结论

1 个 must-fix + 2 个 should-fix 已在 review_fix 修复。其余 should-fix 记为已知取舍或独立改进，nit 记录备查。

## 已修复（review_fix commit 4b4792f4）

### must-fix: index.ts:173 onTurnFinalize 丢弃 stopReason [已修]
W4 改了 onTurnFinalize 签名加 stopReason，event-interpreter 也传了，但组合根注入点 `(sid) => handleTurnEndSideEffects(sid)` 仍单参，stopReason 被丢弃。导致正常完成路径恒写 done，LLM error 终态永远不落盘。
**修复**：`(sid, stopReason) => handleTurnEndSideEffects(sid, stopReason)`。

### should-fix: abort 后 agent_end 覆盖 stopped [已修]
abort 写 stopped 后，若 pi 仍发 agent_end{stopReason:'aborted'}，handleTurnEndSideEffects 原映射 aborted→done 会覆盖。
**修复**：aborted 映射 stopped（与 abort 路径一致，两条 session_end 一致不冲突）。

## 已知取舍（不改，记录在案）

### should-fix: extractSessionOutcome 全量读 3 次 [已知，独立改进]
scanner 每个 session 文件被读 3 次（header + name + outcome），全量 readFileSync + parseJsonl。这是 extractSessionName 已有的现状（W5 复用同模式），大 JSONL 会抵消去 hydrate 的部分收益。
**处理**：本次不改（避免范围扩散）。合并 name+outcome 成一次倒序扫描或尾部读取是独立优化（性能审查 P2 已记录）。

### should-fix: Overview sessionDigest 未 hydrate 退化 [已知，需产品决策]
W6 去预 hydrate 后，Overview 的 sessionDigest 对未访问 session 返回空摘要 + 0 回合。功能回退。
**处理**：Overview 是否需摘要是产品决策。若需，单独为 Overview 按需 hydrate。本次接受摘要仅在点开 session 后可见。

### should-fix: turn-skill-badge.test.ts 中间态 [非本次责任]
W1 改 Turn.vue 但该测试在 2be14c21（范围外）才适配。非本次 commit 责任，跳过。

## nit（备查，不改）

- W4 persistSessionEnd 写失败静默：ADR 0036 已记录取舍（极端崩溃→idle）。console.error 已带 filePath。
- W3/W6 注释反复横跳（session store 依赖移除又加回）：建议统一更新为"W6 读 session store 取 metaStatus"。
- W1 editAndResend 传裸字符串 vs 其他入口走 segments：等价但不一致。
- SessionStatus/DerivedStatus 双枚举同名契约：deriveStatus 硬编码映射，建议加注释。

## 正确性验证通过

- W1 commitMessages 覆盖全部写入点（grep 无残留 messages.value.set），无字段级 mutate
- W2 streamingSessionIds computed 在 shallowRef 下正确重算，边界正确
- W3 缓存生命周期完善（deleteSession 清理 + 懒填充无泄漏）
- W4 existsSync guard 遵守规则 #6，onSessionExit 用缓存 session 对象正确
- W5 SessionStatus 扩展不破坏现有 `=== 'dead'` 消费
- W6 瞬态来源完整（streaming by computed Set，compacting by compactingSessions Set）
- 三层架构类型对齐（SessionOutcome port/impl/shared 一致）
