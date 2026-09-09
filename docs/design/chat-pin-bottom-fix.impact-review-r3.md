# 影响面审查报告 r3（chat-pin-bottom-fix.md v3）

审查人：tech-design-impact-review（第 3 轮，聚焦项）　日期：2026-09-08
依据检查项：P0-12（接管后原流程步骤复刻/声明放弃）、P0-19（外部共享状态写入面）、P0-20（代价量化四要素）

## Summary

0 must-fix, 2 suggestions, 2 info. 上轮 4 条 suggestion（S1-S4）修复全部成立；D3 收窄 + D7 复合判据的新影响面基本穷尽，发现 1 处「语义对齐」声明与现状不符的未登记差异（load-more 前插浮层点亮）与 1 处实施歧义（末条文本 watch 的 isStreaming 守卫去留）。

## 上轮 suggestion 修复核验（S1-S4）

| 上轮项 | 文档位置 | 核验结果 |
|---|---|---|
| S1 ADR-0045:45 断链 | D7 同步清扫段（§4.3 D7 末段）+ §6.2 清扫行 | ✅ 成立：显式声明「ADR-0045:45 为历史决策快照按 ADR 纪律不改写原文」，由 conversation-stream-block-rendering.md 改述处建立「现行语义见本设计 D7」指针；§6.2 地图含该文件行 |
| S2 行号漂移 | §6.2 改写行 + 附录 | ✅ 成立：grep「单向翻真」锚点 + 实测 :388/:418/:423 备注；实读 MessageStream.vue :388/:418/:423 三处命中；useVirtuaFollow.ts:26 = `const BOTTOM_THRESHOLD = 40` 精确命中 |
| S3 禁用模式扫到测试头注释 | §4.4 ⑤ + §6 U4 | ✅ 成立：⑤ 显式声明「排除 `__tests__`/`.test.ts`」+ 顺序依赖「M1 归零先于 M2 挂接」；§6 U4 行同步声明「显式声明在 M1 禁用模式归零之后落地」 |
| S4 V9 补偿断言无验收 | §5.2 V9 | ✅ 成立：通过标准补「恢复贴底后新消息正常跟随——stickToBottom 未被前插/补偿流程误翻 false（跟随链完整）」 |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|---|---|---|---|---|
| SUGGESTION | §4.3 D3 效果段 / 触发矩阵 isPrepend 行 | P0-12 声明放弃面 | 「unreadBelow 语义与现状逐路对齐」的声明与现状有一处未登记差异：现状下 messages.length watch（useMessageStreamScroll.ts:45-51）无 isPrepend 抑制——脱离态用户点「加载更多」→ 前插使 length 变化 → followIfStuck → unreadBelow=true → 浮层**会**点亮；v3 矩阵 isPrepend 行「不标」实为行为变更（降噪改进），但未列入「已声明的语义差异」段，与「逐路对齐」总声明冲突。V9 已覆盖该行为，仅差显式登记 | 在 D3 效果段的「已声明的语义差异」清单补第三条：load-more 前插不再点亮浮层（现状会点亮，判定可接受——前插不产生新内容） |
| SUGGESTION | §4.3 D3 矩阵第 2 行 / §6 U1、U2 | P0-12 实施歧义 | 现状末条文本 watch 带 `if (lastRenderTurn.isStreaming)` 守卫（useMessageStreamScroll.ts:64，仅流式期间触发）；v3 矩阵只写「末条消息文本长度 watch（保留，store 级——流式 token 到达）」，U1/U2 拆分均未声明该守卫去留。若守卫被去掉，非流式态末条文本变化（编辑确认、归一化重算）将新增 unread 点亮面；若保留则 parity。迁移时无 spec 依据 | 在 D3 矩阵该行或 U1/U2 内容中显式声明守卫保留（推荐，保持 parity） |
| INFO | 附录 | 行号漂移（微小） | 附录写 `MessageStream.vue:305-310（vlistBottom）`，实读 `const vlistBottom` 在 :304-310——起点偏 1 行。grep 锚点纪律已覆盖主清扫项，此处仅备忘 | 实施时以 grep `vlistBottom` 定位为准 |
| INFO | useMessageStreamScroll.ts:70-71 | 陈旧注释交接 | 现状代码注释仍称「notice 是 absolute 定位的非消息元素」——该描述已过时（compacting 指示已收编入文档流 ActivityStrip，MessageStream.vue:109-114 证实）。D5 删除该文件时此矛盾自然消失，无行动项；但 D3/D5 的「isCompacting 由 tailEl RO 覆盖」论证依赖 ActivityStrip 文档流定位，已实读核实成立（增高 → tailEl RO → 标 unread，parity） | 无需改文档；U3 删文件时该陈旧注释一并消失 |

## 聚焦任务核验记录

1. **上轮 4 条 suggestion**：全部成立（见上表）。
2. **D3 收窄 + D7 复合判据新影响面穷尽性**：实读 useMessageStreamScroll.ts 全部 4 个 watch 逐路比对——① messages.length 保留 parity（除 isPrepend 抑制差异，见 SUGGESTION 1）；② 末条文本保留但守卫去留未声明（SUGGESTION 2）；③ isCompacting → tailEl RO 覆盖成立（ActivityStrip 文档流实读证实）；④ isSessionActive 完成点亮 → 静默分支差异已显式登记（「毫秒级窗口 + 无信息丢失，判定可接受」）。「第三处遗漏」排查：scrollToIndex 全部调用点 = useVirtuaFollow（原语内 2 处）+ useMessageStreamRail（白名单已声明）+ TraceView（范围外已声明）+ MessageStream force 转发（内联入口已列）——调用面穷尽，无第三处遗漏。
3. **交叉引用一致性**：探针表 ✅4（P-coord/P-offset/P-viewport/P-comp）+ ⛔3（P-wrap/P-timing/P-no-loop）与 §4.5 章结论一致；P-unread 取消后无悬空引用（仅 D3 被否③历史谱系提及，属合法）；§4.4 代价段三条（⑥⑦运行成本 / ⑤守卫成本 / D7 残余风险）四要素齐备，与决策段 D7 反例重演⑤、§6 U4 对应一致；§4.4 ⑤ 顺序依赖与 §6 U4 表述一致。
4. **行号/锚点抽查**：MessageStream.vue :388/:418/:423 精确命中；useVirtuaFollow.ts:26/:68-73/:131/:166 全部命中；vlistBottom 起点 1 行漂移（INFO）。
