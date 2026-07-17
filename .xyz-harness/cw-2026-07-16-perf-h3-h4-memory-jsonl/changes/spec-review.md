# Spec Review: perf-h3-h4-memory-jsonl

## 审查方法

**禁读重建**：派 fresh subagent 只看 objective + clarifyRecords（源头），不读 specSections/confirmSpec，独立重建 FR+AC。将重建结果与初稿 diff，差异即为审查发现。

重建覆盖章节：FR + AC + 边界场景识别。

## Diff 结果（重建 vs 初稿）

### 初稿遗漏（重建多出的条目）

初稿将 H3 的多个关注点合并进宽泛的 FR，重建拆得更细并发现了关键缺口：

| # | 重建发现 | 初稿状态 | severity |
|---|---------|---------|----------|
| 1 | **截断必须覆盖尾读回流的历史**——tool result 截断不能只在实时流路径（tool_call_end），尾读/hydrate 回流的历史 tool result 也必须截断，否则切回老 session 时 20 turn × MB 级 tool result 抵消 H3 内存收益 | 初稿 FR-2 只写了 tool_call_end handler | **must-fix** |
| 2 | 4KB 单位（字节 vs 字符）+ UTF-8 codepoint 边界对齐 | 初稿未明确单位 | should-fix |
| 3 | "turn" 的精确定义（user→assistant 一轮？含 tool_call？） | 初稿 FR-3/AC-5 用了 turn 但未定义 | should-fix |
| 4 | 尾读末行损坏容忍（文件存在但末行 JSON 不完整） | 初稿 AC-6 只覆盖文件不存在(ENOENT) | should-fix |
| 5 | streaming 豁免寿命——streaming 标志未清=永久豁免=新泄漏 | 初稿 AC-9 只说不驱逐 streaming，未说标志清理 | should-fix |
| 6 | Map 驱逐语义（delete key vs 置空数组） | 初稿未明确 | should-fix |
| 7 | toolName 匹配规则（MCP 命名空间前缀 mcp__server__read） | 初稿 AC-4 列了工具名但未说匹配算法 | should-fix |
| 8 | 驱逐与流完成的竞态（驱逐瞬间 tool_call_end 到达） | 初稿未覆盖 | should-fix |
| 9 | convertHistory 外扩方向与上限（配对一个 toolResult 不能拉回整个文件） | 初稿 AC-5 只说配对完整 | should-fix |

### 初稿与重建一致（无偏离）

- 范围界定（D1-D8）一致
- LRU 策略（K=8 + panel/streaming 豁免）一致
- tool result 截断层（renderer store）一致
- H4 尾读 + 加载更多 fallback 一致

## 审查结论

spec 基本就绪，但有 1 个 must-fix（截断覆盖回流历史）会导致 H3 收益被抵消——必须在 plan 前补上。9 个 should-fix 涉及边界定义和竞态，建议在 plan/dev 阶段明确。

### must-fix 修复方案

**SR1**：FR-2 截断逻辑必须同时作用于实时路径（tool_call_end）和历史回流路径（hydrate/setMessages）。实现上应抽出一个共享的 `truncateToolOutput(message)` 工具函数，两条路径都调用。补充 FR-2 detail + 新增 AC（回流路径截断验证）。

### should-fix 处理建议（plan 阶段明确）

- SR2（4KB 单位）：明确为 UTF-8 字节，截断在 codepoint 边界对齐
- SR3（turn 定义）：定义为「user message 开始到下一个 user message 之前」（含其间的 assistant + tool_call + toolResult）
- SR4（末行损坏）：尾读复用 readTailEntries 的首行残行丢弃逻辑（INVAR-tail-3）
- SR5（streaming 寿命）：复用现有 streaming timeout（DEFAULT_STREAMING_TIMEOUT_MS）+ finalizeSession 清标志
- SR6（驱逐语义）：delete key（与 disposeSession 一致），下游 getMessages 已有 `?? []` 兜底
- SR7（toolName 匹配）：精确匹配 + MCP 前缀（按 `__` split 取最后一段或包含匹配）
- SR8（驱逐竞态）：驱逐前二次检查 streaming 状态（double-check after eviction decision）
- SR9（外扩上限）：turn 外扩最多 1 轮，仍无法配对则丢弃孤立 toolResult（warn）
