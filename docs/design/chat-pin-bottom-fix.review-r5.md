# 对抗式审查报告：chat-pin-bottom-fix.md（v5，第 5 轮）

> 主审（tech-design-review）。本轮聚焦：上轮 must-fix（120ms 关窗阈值）修复成立性 + case-5 `:shift` 枚举核实 + 交叉引用终检 + 上轮 3 suggestion 与影响面 r4 修复项逐条判定。所有代码断言以实装文件行号为证据。

## Summary

**1 must-fix, 1 suggestion, 1 info。**

v5 对上轮 must-fix 的修复方向（时间阈值取代帧定义）正确、交叉引用三处一致、case-5 枚举与 virtua 实装核对无误、上轮 3 suggestion 与影响面 r4 修复项全部成立。**但 120ms 阈值的推导依据——「useMarkdownStreaming 的 50ms flush 节流」——是一个不存在于实装中的编造常数**：该文件的真实节流是 rAF trailing（每帧一次，useMarkdownStreaming.ts:102-107/:246-249），上游 delta-coalescer 是 microtask 合帧（delta-coalescer.ts:105-107），全链路唯一 ms 级常数是 fence 静默阈值 `STREAMING_FENCE_SILENCE_MS = 200`（markdown.ts:974）。文档自身内部也矛盾：§3.1 数据流图与附录均写「rAF 节流」，D7 ② 却按「50ms flush」推导。讽刺的是，上轮（r4）must-fix 的量纲攻击本身就建立在这条未经验证的事实上，v5 照单全收。**结论层面无恙**：真实事件周期是帧级（~16.7ms @60Hz）而非 50ms，120ms ≈ 7 帧静默，作为「收敛完成」信号更充裕，「流式期窗口恒取 1500ms 上限」的登记行为反而更稳固——120ms 这个值可以保留，但其推导文本必须按真实节流机制重写，否则实施者按 50ms 常数去代码里找不到对应物，且未来若真引入 ms 级 flush 节流（如性能优化）会误以为 120ms 依据仍然有效。

## Findings（新发现）

| # | 等级 | 位置 | 问题 | 证据 |
|---|------|------|------|------|
| MF-1 | MUST_FIX | 文档状态行 / §4.3 D7 ② / 变更历史 v5 | **「useMarkdownStreaming 50ms flush 节流」为编造常数，推导依据失实**。实装核实：(a) `packages/ui/src/features/chat/composables/useMarkdownStreaming.ts:102-107`（H2 注释「rAF trailing 节流：每帧多次 content 变化合并为单次渲染」+ `requestAnimationFrame` 实码）与 `:246-249`（`scheduleRender` → rAF）——节流单位是**帧**，不是 50ms；(b) 上游 `packages/core/src/domain/chat/delta-coalescer.ts:105-107` 是 `queueMicrotask` 合帧，也无 50ms；(c) 全链路 grep 无任何 50ms flush 常数，唯一 ms 级阈值是 fence 静默 200ms（`packages/renderer/src/composables/logic/markdown.ts:974`）。且文档自相矛盾：§3.1 环节④ 与附录均正确写「rAF 节流」，D7 ② 却按「50ms cadence 两个周期 + 一帧余量」推导 120ms。这是 r4 must-fix 自己的前提未 read 验证、v5 照抄所致。**值本身仍成立**（帧级周期 ~16.7ms 下 120ms ≈ 7 帧静默，比原推导更保守；「流式期恒取 1500ms 上限」登记行为在帧级 RO 活跃下更必然），但推导文本与变更历史 v5 条目必须改为按 rAF 帧节流重算（如「覆盖 ~7 帧静默」），否则实施者找不到 50ms 对应物、且文档内部两处节流描述互相打架（P0-11 关键事实：方案成立依赖的节流常数失实 + 内部矛盾） | useMarkdownStreaming.ts:102-107/:246-249；delta-coalescer.ts:105-107；markdown.ts:974；对照本文档 §3.1 环节④「rAF 节流」 |
| S-1 | SUGGESTION | §4.3 D7 逐路径推导第四条 | **「isPrepend 期间用户必已脱离锚定（『加载更多』入口脱离态才可达）」是实用前提而非结构保证**。实装核实：load-more 按钮的 v-if 仅 `showLoadMore && renderItems.length > 0`（MessageStream.vue:84，showLoadMore 由 historyTruncated 驱动，useLoadMoreHistory.ts:34），**无任何脱离态（stickToBottom）门控**；按钮 `absolute top-0`（:86）在贴底态下离屏但仍在 DOM 中、可被键盘 Tab 聚焦 + Enter 激活（Chromium 离屏 focusable 元素可激活），此时用户仍 stuck、isPrepend 期发生 prepend jump——该序列下第二保险失效。第一保险（jump 恒正向 → offset 递增 → 第一合取不命中）独立成立且无前提，**安全性结论不变**；但「必已脱离」的绝对化措辞在被键盘用户 Tab 误触的边缘序列下不成立，应降级为「通常已脱离（按钮视觉上仅顶部可见）+ 第一保险独立兜底」 | MessageStream.vue:84-92（v-if 无 stuck 门控、abs top-0）；useLoadMoreHistory.ts:34 |
| I-1 | INFO | §4.3 D7 ② | **收敛后期其他 RO 源排查结果：无未登记的持续触发面**。逐源核实：(a) fence finalize 定时器在 token 静默 ≥200ms（markdown.ts:974）后触发一次完整重渲染——120ms 关窗恰在其前，产生的是关窗后的**单个** RO（spacer 增长 → D3 矩阵静默跟随分支，非脱离误判面）；(b) shiki 高亮在流式期经 streaming-fence 占位被推迟（useMarkdownStreaming.ts:15-17），finalize 后一次性完成，非逐批持续；(c) 图片解码属逐个离散事件，非周期性。均不构成「120ms 静默永不满足、1500ms 上限被常态顶穿」的未登记风险；上限常取场景已由反例重演⑥（流式切换）与⑤d（超长会话长尾）覆盖 | useMarkdownStreaming.ts:15-17/:226-237；markdown.ts:974 |

## 上轮（r4）修复判定

| 上轮项 | 判定 | 依据 |
|--------|------|------|
| MF（120ms 关窗阈值） | **方向成立，遗留 1 must-fix（推导依据失实，见 MF-1）** | 三处落点一致（D7 ②「静默 ≥120ms」/ 反例重演③「RO 静默 120ms」/ 护栏⑥「RO 静默 120ms 关窗 / 1500ms 硬上限」）；文档状态行与变更历史 v5 均如实登记改因。时间阈值取代帧定义的方向正确，且在真实帧级节流下 120ms 值依然成立——但「50ms flush」推导常数不存在于实装（MF-1） |
| S1（残余风险⑤d 四要素） | **成立** | D7 反例重演⑤d：「1500ms 上限到期但收敛未完」含完整四要素（量级 = 收敛 >1.5s 需数千 item / 恢复 = 任意下滚即重贴 / 重审 = V2 长会话实测收敛超上限 / 判定 = 可接受），并在 D7 ② 末尾被引用（「收敛期外的零星补偿与上限到期的未收敛长尾分别登记为残余风险⑤b/⑤d」） |
| S2（case-5 枚举） | **成立（附 1 条措辞降级，见 S-1）** | D7 推导补第四条：vue/index.js:453-455（本轮重新 sed 逐行核对：`c(() => r.data.length, e => { g.A(5, [e, r.shift]) })` 恰在 453-455）→ core/index.js:147（`case 5: n[1] ? (q(p(R, n[0], !0)), x = 2, i = 1)` 核对无误）；MessageStream.vue:41 `:shift="isPrepend"` 接线核实（:30 注释 + :41 实码 + :213 解构）。「jump 恒正向」第一保险成立；「必已脱离」第二保险为实用前提（S-1） |
| S3（护栏⑦流式判读） | **成立** | §4.4 ⑦ 补「判读指引：流式中（isStreaming=true）双超阈值按真实跟随失效上报——收敛期恒在 force 后窗口内，窗口外的流式持续 gap 无合法瞬态解释」。采用了比 r4 建议更干净的确定性规则（非「先复核再定性」），理由自洽：流式期 follow 每 token 重触发、dev 断言前置窗口恒新鲜，双超无瞬态解释——推理链成立 |
| 影响面 r4-1（两抑制窗命名区分） | **成立** | D7 ② 显式声明「命名区分：本窗抑制 onScroll 脱离判定，与 ⑥ 的『isPrepend 前插抑制窗』（抑制 unread 标记）是两个独立窗口、互无交集，实施时不得共用状态」——位置正确（首现处），与影响面建议措辞等价 |
| 影响面 r4-2（force 调用点 3 处） | **成立** | D5：「force 调用点枚举（3 处，均在 MessageStream.vue）：session 切换/挂载首滚、跟随态 loadMore 追加、『回到底部』按钮（:142）」；实装核对 MessageStream.vue:142 确为 `@click="followToBottom(true)"` ✓；与 §6.2（force 内联进 MessageStream.vue）一致 |
| 影响面 r4-3（抑制窗关闭条件单测条目） | **成立** | 护栏⑥ 测试清单含「抑制窗关闭条件（RO 静默 120ms 关窗 / 1500ms 硬上限，happy-dom 手动 RO stub 派发）」——正中影响面 INFO-2 建议的可控 stub 测法 |

## 交叉引用终检

- **120ms 三处一致**：D7 ②（「contentWrap RO 静默 ≥120ms 后关闭」）/ 反例重演③（「收敛完成（RO 静默 120ms）」）/ 护栏⑥（「RO 静默 120ms 关窗 / 1500ms 硬上限」）——同一数值、同一语义 ✓（但三处的推导母体均含失实的 50ms 前提，随 MF-1 一并改）
- **残余风险⑤a-d 四条完整**：a clamp-at-0 极端序列 / b 收敛期外零星负补偿 / c 同帧补偿写+用户滚动合流掩盖 / d 1500ms 上限到期未收敛——四条均带四要素（场景/量级/恢复/重审/判定）✓；D7 ② 末尾「⑤b/⑤d」交叉引用指向正确 ✓
- **D5「3 调用点」与 §6.2 一致**：D5 枚举 3 处 force 调用点均在 MessageStream.vue，§6.2 对 MessageStream.vue 的改写条目含「force 内联」、U2 含「删 useMessageStreamScroll 调用，force 入口内联」——无矛盾；:142 行号实装核实 ✓
- **「回到底部」按钮（:142）**：MessageStream.vue:136-146 Transition 块内 `@click="followToBottom(true)"` 恰在 :142 ✓
- case-5 行号：vue/index.js:453-455 ✓、core/index.js:147 ✓、MessageStream.vue:41 ✓（本轮全部重新 read 核对）

## 结论

v5 的全部修复动作（时间阈值、case-5 枚举、⑤d 登记、判读指引、命名区分、3 调用点、单测条目）均已正确落地，交叉引用体系一致。唯一实质问题是一条逆向事实错误：**上轮 must-fix 用来击穿 v4 的「50ms flush 节流」常数本身不存在**——真实节流是 rAF 帧级，文档因此出现「§3.1 说 rAF、D7② 说 50ms」的内部矛盾。修复代价极低（重写推导文本、保留 120ms 值、同步变更历史 v5 条目），修完即闭合。
