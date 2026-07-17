# Plan Review — perf-quick-batch

> 审查方法：spec 阶段已对 FR/AC 做深度禁读重建审查，plan 只是 FR→Wave 映射，重建价值低。本阶段直接自审 coverage + architecture + feasibility。

## 审查范围

- spec FR 清单：FR-L6 / FR-M4 / FR-M5 / FR-M8 / FR-M6 / FR-X（6 项）
- plan waves：W1 (message-broker) / W2 (event-interpreter + process-control) / W3 (useChatScroll + MessageStream)

## FR → Wave 覆盖核对

| FR | Wave | changes | 覆盖 |
|----|------|---------|------|
| FR-L6 | W1 | message-broker broadcast 单次 stringify + try-catch + 错误策略 | ✅ |
| FR-M8 | W2 | event-interpreter resetWatchdog 不变量约束 | ✅ |
| FR-M5 | W2 | process-control @157 dev/prod 差异化 + stderr 兜底 | ✅ |
| FR-M6 | W2 | process-control @264 sleep 异步化 + 调用方 await | ✅ |
| FR-M4 | W3 | useChatScroll rAF trailing + MessageStream 触发源保留 | ✅ |
| FR-X 回归 | 跨 Wave | tdd_plan 建回归用例（chat store 204 + 各模块） | ✅（test 阶段验证） |

**CW 的 mustFix warning（FR-1..5 未覆盖）是编号匹配问题**：旧编号 FR-1..5 匹配不到新命名 FR-L6/M4/M5/M6/M8。实际 6 个 FR 全覆盖，无缩范围。

## 发现的问题

### should-fix

| ID | dimension | ref | 问题 | 建议 |
|----|-----------|-----|------|------|
| PR1 | architecture | W2 | W2 把 M8（event-interpreter watchdog，不变量多、逻辑复杂）和 M5+M6（process-control，简单改动）混在一个 Wave。虽然文件不同、无依赖、正交，但 commit 粒度不清晰——M8 的 watchdog 重构和 M5/M6 的简单替换是不同性质的改动。 | dev 阶段 W2 内分两个 commit：先 M5+M6（process-control 同文件必须同 commit），再 M8（event-interpreter 独立 commit）。Wave 不拆（同属 runtime/主进程侧性能点，逻辑聚类合理），但 commit 粒度分开。 |

### nit（只记录不进 issues）

- W3 的 MessageStream.vue 改动描述是"确认触发源不改"，实际可能零代码改动（只改 useChatScroll）。dev 时若 MessageStream 无需改，change 描述应更新为"无需改动，仅验证"。

## 审查结论

plan **就绪进 tdd_plan**。FR 全覆盖，依赖链无环（三 Wave 都 dependsOn:[]，独立可并行），feasibility 无问题（5 项均已验证代码事实，改动量明确）。

PR1（commit 粒度）作为 dev 阶段执行指引，不阻断 plan。W2 内按 M5+M6 一个 commit、M8 一个 commit 执行。
