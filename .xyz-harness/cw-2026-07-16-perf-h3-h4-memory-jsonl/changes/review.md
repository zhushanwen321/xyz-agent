# Code Review: perf-h3-h4-memory-jsonl

## 审查范围

4 个 Wave（W1-W4），13 个文件。审查方法：subagent 全量代码审查 + 主 agent 确认。

## 发现的问题

### Must-fix（阻塞进 test）

| ID | 问题 | 文件 | 维度 |
|----|------|------|------|
| R1 | `isEnaent` 拼写错误——errors.ts 只导出 `isEnoent`，运行时 isEnaent 为 undefined。tailReadHistory 大文件 fallback 的 readFile 抛 ENOENT 时会 throw "isEnaent is not a function" 而非返回 []，违反规则 #6 | session-history.ts:12,172 | correctness |
| R2 | tailReadHistory 是 dead code——session-service.ts 导入但从未调用。getHistory 的文件 fallback 用 getHistoryFromFile（全量读），W1 尾读优化未接入主链路 | session-service.ts:26,371-391 | omission |

### Should-fix

| ID | 问题 | 文件 | 维度 |
|----|------|------|------|
| R3 | LRU 退化为 FIFO——touchLru 只在 hydrate()（有 hydrated 守卫）调用，selectSession/getMessages 不调用。重新访问已 hydrate session 不更新 recency | chat.ts:448, useSidebar.ts | correctness |
| R4 | evictIfNeeded 可能驱逐刚选中的 session（R3 的后果——已 hydrate session 时间戳旧） | useSidebar.ts:262 | edge-case |
| R5 | sessionLastAccessed 模块级 Map 内存泄漏——disposeSession 不清理 | chat-lru.ts:32 | omission |
| R6 | getHistory 与 getFullHistory 语义重叠——两者文件路径都全量读，W1 尾读投资未兑现（与 R2 相关） | session-service.ts:371-404 | consistency |
| R7 | truncateToolOutputBatch 浅 clone（toolCalls 数组仍原引用）——当前安全但脆弱 | chat.ts:451,462,468 | edge-case |

### Nit（不进 issues）

- N1: hasMoreHistory 默认 true，空 session 也显示「加载更多」按钮
- N2: shouldTruncate 对 read_file（单下划线）不命中，行为依赖 MCP `__` 分隔约定
- N3: tailReadHistory L187 条件措辞易误读
- N4: hasMoreHistory 判定靠消息数变化，去重场景极端情况可能误判

## 审查结论

W2（截断工具）质量最高。W1/W3 有 must-fix 必须先修。修复 R1（拼写）+ R2（接入尾读）+ R3（touchLru 调用点）+ R5（内存泄漏）后可进 test。
