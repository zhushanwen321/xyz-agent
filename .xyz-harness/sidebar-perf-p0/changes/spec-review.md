# Spec Review：sidebar-perf-p0

**审查方法**：禁读重建法。派 fresh subagent 只给 objective + 3 条 clarifyRecord（CL1 shallowRef / CL2 computed 派生 Set / CL3 runtime 写 session_end），让其从源头重建 FR/AC，与初稿 spec diff。

**审查日期**：2026-07-16

## diff 结果（重建 vs 初稿）

subagent 重建出的 FR/AC 与初稿的 6 个 FR + 7 个 AC 基本对齐（初稿的 FR-1~6 覆盖了重建的 FR-A/B/C 全部）。subagent 额外发现了 4 个 P0 级"决策接缝"问题，逐条评估如下：

### 逐条评估（subagent 发现 → 实际方案是否覆盖）

| # | subagent 发现 | 严重度 | 实际方案是否已覆盖 | 处理 |
|---|--------------|--------|-------------------|------|
| 1 | CL1↔CL2 响应式耦合：computed 派生 Set 在 shallowRef 下能否重算 | should-fix | **方案已验证**：messages 更新都是 Map.set/重新赋值，shallowRef 对 .value 替换敏感，computed 会重算。但 AC-6 只写"Map.set 触发响应式"，未显式覆盖"computed 派生 Set 重算" | 补 AC-6 表述 |
| 2 | 去预 hydrate 后瞬态（streaming/compacting）来源未定义 | should-fix | **方案已覆盖**：Task 6 明确瞬态由 Task 2 的 computed Set + compactingSessions Set 派生，不依赖 messages 历史。但 FR-6 没写这个 | 补 FR-6 细节 |
| 3 | 崩溃恢复 + 历史 session fallback 语义 | 已覆盖 | CL3 答案明确："历史 session 无 session_end 一律显示 idle"；崩溃来不及写也回退 idle | spec 表述充分，不补 |
| 4 | 量化性能 AC（内存/渲染时延阈值） | nit | vitest 是 jsdom 无真实渲染性能，DOM 节点数/内存/时延在单测难断言。性能用集成测 + 手动验证，不进机器 AC | 不进 issues，记 nit |
| 5 | scanner 全文扫描性能（extractSessionOutcome 是 O(文件大小)） | nit | 复用 extractSessionName 的 parseJsonl 全文件倒序——**这是现状**，session_end 复用同一机制不引入新问题。长 session 扫盘卡顿是独立 runtime 问题（审查 P2），本次不加重 | 不进 issues，记 nit |
| 6 | session_end 写入原子性 / scanner 读容错 | 已覆盖 | parseJsonl 本身逐行 JSON.parse 跳畸形行（jsonl.ts:27-40 已有容错）。append 写整行 JSON + '\n' | spec 不补，实现沿用现有容错 |
| 7 | 13 写入点收敛 + 3 边界点处理 | 已覆盖 | CL2 决策选 computed 派生 Set 正是为规避"手动维护易漏"——单一真相源自动覆盖所有写入点和边界点。这是选 computed 而非手动 Set 的核心理由（ADR 0035） | spec 不补，已在 ADR 论证 |

## 审查结论

**spec 就绪进 plan**。无 must-fix。

2 个 should-fix（AC-6 / FR-6 表述补全，让瞬态来源和 computed 重算在 spec 显式化），不影响方案完整性（实现已覆盖），仅补强 spec 可追溯性。

### nit（不进 issues，仅记录）
- 量化性能 AC：性能优化类项目的机器 AC 难以量化内存/时延，本项目用功能正确性 AC（O(1) 不扫消息、缓存命中）+ 集成测/手动验证覆盖。未来可引入渲染性能 benchmark。
- scanner 全文扫描：extractSessionOutcome 复用 extractSessionName 的 O(文件大小) 扫描，这是现状非本次引入。长 session 扫盘优化是独立 runtime 问题。
