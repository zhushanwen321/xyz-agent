# Plan Review — drawer-composer-injection

**审查日期**: 2026-07-16
**plan 结构**: 5 waves（W1-W5），lite 格式

## Wave 拆分审查

| Wave | 内容 | 依赖 | priority | 评估 |
|------|------|------|----------|------|
| W1 | file chip 基础设施（insertFileChip + getSegmentsFromEl + # 路径迁移） | 无 | P0 | 正确：DOM 写入+解析是所有后续 wave 的基础，无依赖可最先做 |
| W2 | 注入通道（store + composable + target 路由） | W1 | P0 | 正确：依赖 W1 的 insertFileChip（composable 消费时调用） |
| W3 | 简单写入入口（header按钮 + Git列表 + DiffView行级） | W2 | P1 | 正确：依赖 W2 的 requestInjection API；三个 path-only/单行入口复杂度低，适合验证端到端 |
| W4 | 选区 bubble（选区检测 + Popover + 行范围反推） | W2,W3 | P1 | 正确：最复杂，放最后；依赖 W2 通道 + W3 在 DetailPane 已接入的经验 |
| W5 | 消息流渲染（Turn.vue file badge） | W1 | P1 | 正确：只依赖 W1 的 file segment 结构（getSegmentsFromEl 产出），与 W2-W4 无关 |

**依赖链合理性**：W1→W2 串行（基础设施→通道），W3/W4/W5 都依赖 W1，W4 额外依赖 W2+W3。无循环依赖，拓扑顺序正确。

## 关键风险点（已在 wave risks 标注）

1. **W2 landing composer sessionId 坑点**：Landing.vue:70 composerSid 落到 publicSessionId（非 null）。方案用 Composer variant prop 判定（variant 已存在 L119-124），不用 sessionId=null 匹配。这是整个链路成败点。
2. **W1 getSegmentsFromEl rejectChips**：file chip 子树（.chip-label/.chip-x）必须被 rejectChips 跳过，否则文本污染 segment。参照 skill chip 的 rejectChips.add 模式。
3. **W4 行范围反推**：CodeBlock 单块 `<pre>` 无行号，只能近似。DiffView 有行号可直取。首版接受 CodeBlock 近似精度。
4. **W5 AC-7.3 序列化对称性**：file segment submit 时归一化为 path 文本（D1），重开 session 从 JSONL 读回是 string，Turn.vue userSegments 对 string 返回空数组走 fallback——file badge 可能只在实时发送后可见，重开降级为文本。需在 W5 验证确认。

## FR 覆盖检查

CW 报 FR 覆盖率 warning（lite 格式 changes 无 acceptanceCriteria 字段，无法自动映射）。手动核对：

| FR | 覆盖 wave | 状态 |
|----|----------|------|
| FR-1 结构化 file chip | W1 | 已覆盖（insertFileChip + getSegmentsFromEl + # 迁移 + @保留）|
| FR-2 注入通道 | W2 | 已覆盖（store + composable + payload schema）|
| FR-2.1 target 路由 | W2 | 已覆盖（variant 判定 + startFlow 时序 + onMounted）|
| FR-3 header 按钮 | W3 | 已覆盖 |
| FR-4 选区 bubble | W4 | 已覆盖（选区检测 + bubble + 行范围 + 双 target）|
| FR-5 DiffView 行级 | W3 | 已覆盖 |
| FR-6 Git 文件列表 | W3 | 已覆盖 |
| FR-7 消息流渲染 | W5 | 已覆盖 |
| FR-8 仅 file chip | W1-W2 | 已覆盖（payload schema 无 text + 消费侧只产出 file segment）|

全部 9 个 FR 有对应 wave 覆盖，无遗漏。

## 审查结论

**plan 就绪进 tdd_plan。** wave 拆分合理，依赖链无环，FR 全覆盖，关键风险已标注。无 must-fix。
