# 影响面审查报告 r5（chat-pin-bottom-fix.md v5）

审查人：tech-design-impact-review（第 5 轮，聚焦项）　日期：2026-09-08
依据检查项：上轮修复判定 / D7② 120ms 关窗条件影响面（useMarkdownStreaming 实装核对）/ 变更历史 v1-v5 轨迹自洽性

## Summary

0 must-fix, 1 suggestion（新发现）。上轮 1 suggestion + 2 INFO 修复全部成立（实读 D7② / D5 / 护栏⑥ / §5.1 对应位置核对）。主审 r4 的 MF（关窗条件 2 帧→120ms）与 S1-S3（⑤d 残余风险、case-5 枚举、护栏⑦流式判读指引）修复在正文全部落实。**新发现 1 条事实性问题（SUGGESTION）：v5 关窗条件的论证前提「useMarkdownStreaming 50ms flush 节流」在实装中不存在**——实装是 rAF trailing 逐帧节流（每帧 ~16.7ms，无 50ms 常量）+ fence 静默 finalize 阈值 `STREAMING_FENCE_SILENCE_MS = 200`（markdown.ts:974）。120ms 数值本身在真实机制下依然成立（推导见 Findings），但论据需改写，否则违反「运行时行为断言必须先验证」纪律且会误导后续按 50ms 校准。v5 修正该论据后可进入实施。

## 上轮修复核验（S + INFO1/2）与主审 r4 修复顺带核对

| 上轮项 | 文档位置 | 核验结果 |
|---|---|---|
| S 两抑制窗同名混淆 | §4.3 D7 ② | ✅ 成立：D7② 显式加「**命名区分**：本窗抑制 onScroll 脱离判定，与 ⑥ 的『isPrepend 前插抑制窗』（抑制 unread 标记）是两个独立窗口、互无交集，实施时不得共用状态」——语义区分完整（抑制对象 / 宿主层 / 独立性）与 r4 建议措辞等价。**微瑕**：「⑥ 的」指代不精确——isPrepend 窗的正文定义在 D3 触发矩阵末行 + §6.1 U2，§4.4⑥ 只是测试清单提及；实施者按「⑥」去 §4.4 找窗口定义会绕路。建议把「⑥ 的」改为「D3 触发矩阵 isPrepend 行的」，随本次 S 一并修（非独立 finding） |
| INFO1 force 调用点口径 | §4.3 D5 + §5.1 | ✅ 成立：D5 标题改「保留两个 watch + **三个 force 调用点**」，正文枚举 3 处（session 切换/挂载首滚、跟随态 loadMore 追加、「回到底部」按钮 :142）；§5.1 全文已无「两个 force」类计数表述；D7②「每次 followToBottom(true)」统一措辞未动（行为面不变） |
| INFO2 抑制窗关闭条件单测 | §4.4 ⑥ | ✅ 成立：⑥ 测试清单补「**抑制窗关闭条件**（RO 静默 120ms 关窗 / 1500ms 硬上限，happy-dom 手动 RO stub 派发）」——与 U1 验收行（「force 后快照/抑制窗用例」）形成总-分呼应。可测性可行性：§6.3 第一条已声明 happy-dom 无 RO 时以手动 stub 驱动 + fake timers 纪律（TEST-STRATEGY 同款），「静默计时」用 `vi.advanceTimersByTime(120)` + 不派发 RO 回调即可精确控制，1500ms 上限同理——**声明可行，无障碍** |
| （主审 r4 MF）关窗 2 帧→120ms | §4.3 D7 ② + 变更历史 v5 | ⚠️ 落实但论据有事实错误：见 Findings S1 |
| （主审 r4 S）case-5 `:shift` 枚举 | D7② 程序性写入逐路径推导 | ✅ 成立：第四条写路径补齐（vue/index.js:453-455 → core/index.js:147、MessageStream.vue:41 `:shift="isPrepend"` 接线、恒正向 + isPrepend 期必已脱离的安全推导），与既有三条（follow 写入/clamp 回声/fixScrollJump 负向补偿）并列结构一致 |
| （主审 r4 S）残余风险⑤d | D7 反例重演⑤ d | ✅ 成立：1500ms 上限到期未收敛长尾，四要素齐全（数千 item 级量级 / 任意下滚恢复 / V2 实测观测即重审 / 可接受） |
| （主审 r4 S）护栏⑦流式判读指引 | §4.4 ⑦ | ✅ 成立：「流式中（isStreaming=true）双超阈值按真实跟随失效上报——收敛期恒在 force 后窗口内，窗口外的流式持续 gap 无合法瞬态解释」，消除了「流式持续 gap 被当瞬态漏报」的判读歧义 |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|---|---|---|---|---|
| SUGGESTION | §4.3 D7 ②（v5 关窗条件论证）/ 变更历史 v5 | P0-事实准确性（运行时行为断言未验证） | 「不用静默 ≥2 帧：60Hz 下 2 帧 = 33ms **< useMarkdownStreaming 50ms flush 节流周期**，会在每个 flush 间隙误关窗；120ms 覆盖两个 flush 周期加一帧余量」——实装核对（packages/ui/src/features/chat/composables/useMarkdownStreaming.ts）：**不存在 50ms flush**。真实机制是 ① content watch → `scheduleRender` rAF trailing 节流（每帧多次变化合并单次渲染，周期 = 一帧 ≈16.7ms，无毫秒常量）；② streaming-fence 静默 finalize 阈值 `STREAMING_FENCE_SILENCE_MS = 200`（markdown.ts:974，经 useChatViewDeps.ts:184 注入）。**120ms 结论在真实机制下依然成立**，但论据需换：(a) 原 2 帧方案的真实缺陷仍成立——rAF 逐帧渲染意味着流式期 RO 每帧活跃，「帧计数」静默判据在帧间隙（vsync 空拍、tab 节流）下不稳，毫秒计时更稳；(b) 120ms 的覆盖对象应改述为「跨过 fence finalize 的 200ms 静默阈值前后的 DOM 增长拍」并不必要——finalize 后的增长走 D3 矩阵「spacer 变化 → 静默跟随」安全路径（follow 写入 offset 递增，不命中脱离判据），关窗与否无行为风险；真正的安全边界是「测量收敛风暴期（帧级密集补偿回声）结束」，RO 静默 120ms ≈ 7 帧无测量事件，作为收敛信号量级合理。风险：留着 50ms 论据会诱导未来维护者按「不存在的 50ms」重校准窗宽，或怀疑实装漂移 | 改写 D7② 该句论据：删「50ms flush 节流周期 / 覆盖两个 flush 周期」，改述为「rAF 逐帧渲染下流式期 RO 每帧活跃、帧计数判据在 vsync 空拍下不稳，改毫秒计时；120ms ≈ 7 帧无 RO 测量事件，足以判定收敛风暴结束；fence finalize（200ms 静默阈值）之后到达的增长由 D3 矩阵静默跟随路径接管，不依赖本窗」。变更历史 v5 条目中「50ms flush」字样同步改。随上条 S 的「⑥ 指代」微瑕一并在 v6 修订 |

## 聚焦任务核验记录

1. **上轮 1S+2INFO 修复**：全部成立（见上表，含 §5.1「两个」计数清除的全文复查）。
2. **120ms 关窗条件影响面（useMarkdownStreaming 实装核对）**：实读 composable 全文——渲染链 = content watch（immediate）→ scheduleRender（rAF trailing，latest-wins 串行）→ doRender；fence finalize = armFenceFinalizeTimer 每帧重排、`STREAMING_FENCE_SILENCE_MS=200` 静默阈值或 streaming true→false 立即 finalize；卸载清 timer/rAF。结论：**50ms flush 不存在**（见 S1）；120ms 窗宽在真实机制下安全——流式期 RO 每帧活跃 → 窗不关（与反例⑥「流式 session 切换恒取 1500ms 上限」登记一致）；静止后 finalize 晚到增长走静默跟随，无需窗保护。**⑥ 清单 RO stub 可测性**：手动 stub + fake timers 可精确控制「派发/不派发 + 时间推进」，120ms 与 1500ms 两分支均可确定性断言，声明可行 ✅。
3. **变更历史 v1-v5 轨迹自洽性**：v5 条目声称的 7 项修复逐一对到正文（120ms ↔ D7②、case-5 ↔ D7② 推导、⑤d ↔ 反例⑤、判读指引 ↔ ⑦、命名区分 ↔ D7②、force 3 处 ↔ D5、单测条目 ↔ ⑥）✅；v5 开头声明的双方 findings 数（主审 1MF+3S、影响面 0MF+1S+2INFO）与 r4 双报告实数一致 ✅；v1-v4 轨迹上轮已核、未变。唯一瑕疵：v5 条目复述了 50ms 错误论据（见 S1，需同批改）。
4. **不重查项**：wrapper 安全性、P-wrap 降级、白名单、宿主写入面、四轮已核全部面——按指示未重查。

## 结论

v5 修复面全部落实，唯一残留是 120ms 论据的事实性错误（50ms flush 不存在，实装 rAF 逐帧 + 200ms fence 静默）——结论数值仍安全，论据需改写。修完本条 S（含「⑥ 指代」微瑕）即可关闭影响面审查，进入实施。
