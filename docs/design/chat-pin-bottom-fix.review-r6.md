# 对抗式审查报告：chat-pin-bottom-fix.md（v6，第 6 轮）

> 主审（tech-design-review）。本轮聚焦：上轮 MF-1（50ms 编造常数 / D7② 推导重写）与 S-1（「必已脱离」措辞降级）修复成立性 + 本轮改动文本面（文档状态行 / D7② / 变更历史 v5 补注 / 附录路径）。四轮已通过的机制设计、事实断言、验收、方案对比、交叉引用体系不重查。

## Summary

**0 must-fix, 1 suggestion。**

v6 对上轮 must-fix 的修复完全成立：D7② 推导已按真实节流机制（rAF 逐帧 trailing，无毫秒常量）重写，三个实装锚点本轮重新 read 核对无误（useMarkdownStreaming.ts:102-107 / markdown.ts:974 / MessageStream.vue:84），与 §3.1「rAF 节流」的内部矛盾消除，「fence finalize 200ms 静默晚到增长走 D3 静默跟随路径」的处置与上轮 I-1 排查结论自洽。S-1 措辞降级与第一保险独立性声明均已落地。唯一遗留是一条新发现的**表述过强**（非机制缺陷）：D7② 与反例⑥「流式期间内容每帧增长 → RO 不可能静默 120ms → 窗口恒由硬上限关闭」把「恒取上限」表述为无条件结论，但慢 token 节奏（相邻 token 间隔 >120ms，慢模型/思考模型停顿期并非罕见）下 RO 会在合法的 token 间隙静默满 120ms、窗口由静默分支提前关闭——安全性不受影响（关窗后残余负补偿回声风险已由⑤b 四要素登记兜住），但「恒取上限」的量级声明应限定条件或并入⑥的量级说明，否则实施者按「流式=恒 1.5s 抑制」推断抑制面会比实际宽。

## Findings（新发现）

| # | 等级 | 位置 | 问题 | 证据 |
|---|------|------|------|------|
| S-1 | SUGGESTION | §4.3 D7 ② / 反例重演⑥ | **「流式期间 RO 不可能静默 120ms → 窗口恒由硬上限关闭」是无条件表述，实际以 token 节奏 <120ms 为隐含前提**。机制推演：rAF trailing 节流只在 content 变化时调度渲染，content 只在 token 到达时变化——相邻 token 间隔 ≥120ms（慢模型输出、思考期停顿、工具调用等待段）时无渲染、无高度变化、contentWrap RO 合法静默满 120ms，窗口由**静默分支**关闭而非硬上限。安全性无恙：关窗后若同帧出现负补偿回声 + >40px 底部增长，正是⑤b 已登记的四要素场景（三重巧合 / 任意下滚即恢复 / 判定可接受）；且下一个 token 到达触发 follow 写入（offset 递增，第一合取不命中）不产生扯回面。但两处「恒取上限」声明（D7②「窗口恒由 1500ms 硬上限关闭（与『恒取上限』声明自洽）」、反例⑥「RO 持续活跃、窗口恒取硬上限 1500ms」）应补一个条件限定（如「token 间隔 <120ms 的密集流式期」）或将慢节奏提前关窗的情形并入⑥量级说明——否则实施者按「流式=恒 1.5s 抑制」推断窗内拖拽被扯回的时间面，会高估抑制窗的持续时间 | 本轮机制推演（useMarkdownStreaming.ts:102-107 rAF trailing 由 content 变化驱动 + fence 静默 200ms 常数本身即承认 token 间隔可 ≥200ms——若 token 间隔恒 <120ms，200ms 静默 finalize 将永不触发，自相矛盾处即证慢间隙真实存在）；markdown.ts:970-974 |

## 上轮（r5）修复判定

| 上轮项 | 判定 | 依据 |
|--------|------|------|
| MF-1（50ms 编造常数，D7② 推导重写 + 消除 §3.1 矛盾） | **成立** | D7② 新文本：「流式 md 渲染是 rAF 逐帧 trailing 节流（useMarkdownStreaming.ts:102-107 实装核实，无毫秒常量——v5 曾误引『50ms flush 节流』，第 5 轮主审 MF 纠正），帧级增长下 2 帧静默会在合法增长间隙误关窗；120ms ≈ 7 帧静默，远超帧级节流周期与 RO 投递延迟」——锚点本轮重新 read 核对：:102-107 确为「H2 流式 markdown 渲染 rAF trailing 节流」注释 + `rafId`/`pendingContent` 实码，全段无毫秒常数 ✓；markdown.ts:974 确为 `export const STREAMING_FENCE_SILENCE_MS = 200` ✓。内部矛盾消除：§3.1 环节④「rAF 节流 + latest-wins 串行 + fence 静默 finalize」与 D7② 现同述同一机制 ✓。fence finalize 处置自洽：200ms 静默阈值 > 120ms 关窗，晚到增长「不依赖本窗——走 D3 静默跟随路径」与上轮 I-1 排查结论（单个 RO → 静默跟随分支，非误判面）一致 ✓。附录引用补全：`packages/ui/src/features/chat/composables/useMarkdownStreaming.ts:102-107` 与 `packages/renderer/src/composables/logic/markdown.ts:974` 全路径 + 行号 ✓。文档状态行与变更历史 v6 条目如实登记改因与「阈值不改、论据重写」的范围 ✓。遗留 S-1（本轮新）系「恒取上限」表述的条件前提问题，非本次修复引入的缺陷，而是重写时对慢 token 节奏推演不全 |
| S-1（「必已脱离」降级 + 第一保险独立性声明） | **成立** | D7 逐路径推导第四条现文：「isPrepend 期间用户**通常已脱离**锚定（load-more 浮层 v-if 无 stuck 门控——MessageStream.vue:84 实核，离屏状态下 Tab+Enter 理论可激活；此前提仅作第二重保险，第一重『jump 恒正向 → 第一合取不命中』独立成立，安全性不依赖脱离态前提）」——本轮重读 MessageStream.vue:84 确认 v-if 仍为 `showLoadMore && renderItems.length > 0`，无 stuck 门控，与上轮实核一致；措辞降级与独立性声明均在，安全性结论不再依赖被降级的前提 ✓ |
| 影响面 r5-S（命名区分指代修正 + v5 变更历史补注） | **成立** | D7② 命名区分声明现文：「与 **D3 触发矩阵**的『isPrepend 前插抑制窗』（抑制 unread 标记）是两个独立窗口、互无交集，实施时不得共用状态」——「⑥」误指已修正，且 D3 矩阵确实含该抑制窗行（「load-more 前插抑制窗（isPrepend）」），指代准确 ✓；变更历史 v5 条目补注「（当时引用的『50ms flush 节流』前提后证讹，v6 已纠正论据、阈值不变）」✓ |

## 结论

上轮 1 must-fix + 1 suggestion + 影响面 1 suggestion 全部修复成立，三个实装锚点本轮复核无误，文档内部节流机制描述已统一为 rAF 帧级。新发现仅 1 条 suggestion（「恒取上限」表述的 token 节奏前提限定），修复为纯措辞级（两处补条件限定或并入反例⑥量级说明），不动机制、不动数值。修完即可闭合进入实施。
