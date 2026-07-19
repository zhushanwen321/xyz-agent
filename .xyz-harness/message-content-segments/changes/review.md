# Review: message-content-segments

## 审查范围

W1-W6 全部改动（commit 82127011 + 2be14c21），覆盖 ADR-0037 的 Message.content `string | Segment[]` 重构。

## 架构一致性

- Segment 判别联合定义正确（text/skill/file/mention），type 字段是判别器
- 序列化边界清晰：segmentsToPrompt（pi 边界 trim）/ segmentsToText（展示不 trim）/ normalizeContent（联合类型归一化）
- user message content = Segment[]，assistant/system content = string，按 role 语义区分合理
- 两条读取路径（RPC convertPiHistory + JSONL session-history）共用 convertPiHistory 解析，一处修改覆盖两条路径

## 发现的问题

### SR1（should-fix）：segmentsToText/segmentsToPrompt 分离后的一致性测试缺失

segmentsToText 不 trim、segmentsToPrompt trim 的分离是 W6 修复末尾换行回归时改的，但没有专门的单元测试验证两者的行为差异。segments.test.ts（如果存在）应覆盖：末尾 `\n` 在 segmentsToText 保留、在 segmentsToPrompt 被 trim。

### SR2（nit）：Turn.vue 的 userSegments 对非 Segment[] content 返回空数组

`userSegments` computed 对 string content 返回 `[]`，模板有兜底纯文本渲染分支。但理论上 user message 的 content 永远是 Segment[]（appendUser 和 convertPiHistory 都保证），string 分支只是防御。无实际问题。

## 结论

代码质量良好，架构决策落地准确，序列化边界清晰。无 must-fix 问题。
