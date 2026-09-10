# 对抗式审查报告：chat-pin-bottom-fix.md（v3，第 3 轮）

> 主审（tech-design-review）。本轮聚焦：上轮 must-fix（D7 复合判据）修复成立性——特别攻击 virtua 0.50.0 实装的**全部三条程序性 scrollTop 写路径**（case-1 scroll 更新 / case-3 补偿冲刷 / clamp）；D3 新触发矩阵完备性；交叉引用一致性终检。不重查 v1/v2 已确认项（骨架、事实断言、验收设计、方案对比）。事实判定均 read 实装核实：`node_modules/virtua@0.50.0` core/index.js / vue/index.js 全文。

## Summary

**1 must-fix, 3 suggestions。**

上轮 must-fix 的复合判据方向正确，且对它声称覆盖的两条路径确实成立：follow 原语写入（目标恒为底部方向，offset 递增——core/index.js:287 公式 + :279-288 scrollToIndex 实读核实）与 clamp 回声（落在新真实底部，distance ≤ 0）。D3 的 store 级三路收窄彻底消除了上轮 S1 的视口内/相交增长误判面（判据整体废弃而非修补，P-unread 取消后 §4.5 计数 ✅4+⛔3 全文自洽），parity 声明诚实。**但 D7 的结构性支柱「程序性写入朝底部方向 offset 只增不减」漏算了 virtua 的第三条程序性写路径——`$fixScrollJump` 负向补偿**：顶部相交/上方 item 收缩时（core/index.js:118-129，`q()` 累积负 delta），vue 层在每次虚拟状态更新后 post-flush 冲刷 pending jump（vue/index.js:459-462 `watch(S) → ce()` → core R 包装器 `i[c] = offset + jump` 直写 scrollTop），该写使 **offset 递减**；若同一收敛窗口内存在未补偿的底部/视口内增长使 distance 已 > 40（session 切换混合估算误差的常态），补偿回声同时满足双合取 → 误翻 false → 静默停在中途（spacer 收敛增长不标 unread，连「回到底部」按钮都不亮）——正是本设计要杀的 F1 变体，且恰发生在反例重演③自己声称安全的 session 切换场景。反例重演③的推演只枚举了「follow 写入 offset 递增」与「clamp 先行」两种情况，未覆盖补偿路径。

交叉引用一致性：D1-D7 / P-*（✅4+⛔3）/ V1-V9 / 护栏①-⑧ / §6 拆分与改动地图全部对上；virtua 实装行号（core :78/:114-140/:287、vue :348/:368/:430-431/:446/:470-471）本轮逐一复核无误；上轮 S2/S3/S5 已正确落实（grep「单向翻真」锚点、:26 修正、ADR 指针方案）。唯一不一致：变更历史 v3 声称「当轮全修」，但上轮 S4（dev 断言采样时点）在 §4.4 ⑦ 中未见任何落实痕迹。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.3 D7「采用」段 / 反例重演 ③⑤ | P0-16 运行时断言（新增，本轮发现） | **「程序性 follow 写入的 offset 只增不减」漏算第三条程序性写路径：`$fixScrollJump` 负向补偿。** 实装链路（逐行核实）：① case-3 测量更新中，item 高度变化 delta 为负（收缩）且命中补偿条件（`1 !== y && 0 === x` 时 fully-above；y=1 向下滚动时 `o < e && o + r < e + v` 即**顶部相交也算**，core/index.js:120-125）→ `q()` 把负 delta 累积进 pending jump S（:60-61，桌面端 `b()` 为 false 走 S 分支）；② vue 层 `watch([S], {flush:'post'})` 在**每次**虚拟状态版本变化后调 `$fixScrollJump`（vue/index.js:459-462）→ core 滚动监听包装器读出 pending jump 直写 `scrollTop = scrollOffset + jump`（core/index.js:266，jump 为负 → **offset 递减**）。反例序列（全部落在反例重演③自己的场景——session 切换估算收敛期）：全量 200px 估算 → `followToBottom(true)` 写入大目标 X；RO 批次 A：视口底部附近长消息实测 > 200 → scrollSize +Δg，不补偿（y=1 下不满足顶部条件）→ **distance 升至 > 40 待收敛**；RO 批次 B：与视口顶相交的短消息实测 < 200 → 收缩 → 负 jump 冲刷写 scrollTop −Δs → scroll 事件回声（vue/index.js:430-431 实时读 store）：`offset 递减（−Δs）∧ distance > 40（Δg 未被补偿冲抵，distance 在补偿前后不变——scrollSize 与 scrollTop 等量同降）` → **双合取命中 → 误翻 false**。后果：followIfStuck 的 rAF guard 读 false → 收敛期一切静默跟随死亡；且该增长是纯估算收敛（spacer 变化），D3 矩阵**不标 unread** → 用户视角 = 切完 session 窗口停在中途、无浮层、无提示，须手动下滚。D7 现文「fixScrollJump 补偿等量改变 scrollSize/scrollTop（distance 不变）」这句本身没错，错在用它推出「第二合取不命中」——它只在 distance 本已 ≤ 0 时才成立，与「另一路未补偿增长把 distance 顶到 > 40」同窗共存时推导断裂 | 三选一写入 D7 并重写反例重演③：① **（推荐）有界抑制窗**：`followToBottom(force)` / session 重建后的收敛窗内（如 500ms，与护栏⑦同窗）暂停判据①的翻 false——这是最小且诚实的方案，等于承认「无标记位」卖点在补偿路径上不成立，D7 删去该卖点改述为「仅一条有界的时间窗标记」；② 复合判据加第三合取「scrollSize 快照未减少（或 offset 递减量 > scrollSize 递减量）」——补偿回声 scrollSize 等量同降可被抑制、用户拖拽 scrollSize 不变可放行；但回声读实时 store，若窗口内后续 RO 批次已把 scrollSize 增写回去，该合取会被绕过（对异步回声不 airtight），采用时必须声明此残余；③ 保留现设计，把该序列按四要素登记为残余风险⑥并新增 ⛔ 探针 P-echo（dev app：session 切换 + 长短消息混合的收敛期全程断言 stickToBottom 不被 scroll 回声翻 false）——仅当能论证「批次 A 增长先行触发 D3 RO 网跟随写、先于批次 B 补偿冲刷」的帧序恒成立才可选，而该帧序恰是本轮未证明的实现细节，默认不可选 |
| SUGGESTION | §4.4 ⑦ / 变更历史 v3 | P1 一致性（新增） | **上轮 S4（dev 断言采样时点）未落实，但变更历史 v3 声称「当轮全修」**。§4.4 ⑦ 现文仍是「收敛窗口内 gap > 阈值即 warn」的即时采样——R4 估算收敛期的瞬态 gap（下一次 RO 网 follow 到来前的 1-2 帧，可达数百 px）仍会合法兑现「误报即上调阈值」的重审条件，与 v2 版一字未改 | 二选一：落实（检查时点 = 收敛窗口末尾且内容高度静止 ≥100ms，或连续两次采样均超阈值才 warn）；或在变更历史 v3 中把 S4 明确标注为「评估后未采纳 + 理由」，消除「全修」与实文的矛盾 |
| SUGGESTION | §4.3 D7「采用」段 / U1 | P1-8 未定义语义（新增） | **`lastOffset` 快照在 session 重建 / `followToBottom(force)` 时的重置语义未声明**。反例重演③依赖「nextTick 强制回底并重置 stuck/unread」，但未提 lastOffset：重建 scrollTop 归零产生的 scroll 事件（offset≈0 < 旧大值 lastOffset ∧ distance 大）若在 force 写入**之后**送达，会把 lastOffset 拍回 0 附近的旧值序列，此后首个 follow 写入回声（offset 大幅递增）虽不误翻 false，但「重建事件先于 force 写入」与「之后」两种时序下 lastOffset 的语义不同——设计层应显式钉死：force 入口同步重置 lastOffset = 当前 offset（或置 NaN 使下一事件只建快照不判定），U1 验收用例补一条 | D7 采用段补一句 lastOffset 重置规则；U1 单测清单（§6.1）补「force 后首个 scroll 事件只建快照」用例 |
| SUGGESTION | §4.3 D7 反例重演 ⑤ | P1 残余风险登记补全（新增，微小） | **「同帧补偿写 + 用户滚动合流」可掩盖用户第一拍 offset 递减**：补偿直写 scrollTop 后、scroll 事件派发前用户滚轮/拖拽再改 scrollTop，浏览器只报最终位置——若补偿增量 ≥ 用户减量，回声 offset 不递减，该拍脱离判定被掩盖（wheel 用户由保留的 onWheel 分支兜住；滚动条拖拽用户的下一拍事件即解除掩盖）。可达性极低（需亚帧级交错），但与 clamp-at-0 同属「应登记而未登记」的残余面 | 并入反例重演⑤的残余风险清单（clamp-at-0 之后追加一条），四要素同款量化；不必改判据 |

## 上轮 findings 修复判定

| 上轮 | 判定 | 依据 |
|------|------|------|
| MF1（D7 纯 distance 阈值被收敛期回声击穿） | **方向成立，遗留 1 must-fix** | 复合判据对 follow 写入回声（offset 递增，core :287 公式核实）与 clamp 回声（distance ≤ 0）确实结构性免疫——v2 的击穿场景（回声读实时 store 见 distance>40）在「写入本身使 offset 递增」的前提下不再命中；但「程序性写入只增不减」的论证漏算 $fixScrollJump 负向补偿路径（见本轮 MUST_FIX），反例重演③在混合估算收敛场景仍可被击穿 |
| S1（视口内/相交增长误判 + 混合增长未定义） | **成立** | Δ 签名判据整体废弃（D3 被否③ 谱系录入），store 级三路 + tailEl 使 spacer 增长永不标 unread——视口内/相交/上方 reflow 噪音与同帧混合增长两个面一并消除，无跨帧时序假设；「末条无内容变化的纯异步增长不点亮」的 parity 声明与现状 content watch 行为对齐，判定合理 |
| S2（MessageStream.vue 清扫行号指错） | **成立** | 清扫锚点改为 grep「单向翻真」（实测 :388/:418/:423），D7 同步清扫段与 §6.2 均更新，且声明「实施时以 grep 定位为准，不写死行号」 |
| S3（守卫顺序依赖 + 测试排除） | **成立** | §4.4 ⑤ 显式声明「M1（U1/D6 归零）之后落地，M2 才挂接」+ 禁用模式扫描排除 `__tests__`/`.test.ts` |
| S4（dev 断言采样时点） | **未落实（见本轮 SUGGESTION 1）** | §4.4 ⑦ 文本与 v2 逐字相同，无窗口末尾/静止采样/双采样设计；与变更历史「当轮全修」矛盾 |
| S5（useVirtuaFollow.ts:26） | **成立** | §1 概念段与附录均已改 :26 |

## D3 新触发矩阵完备性检查

- 「脱离时应有 unread 但三路不覆盖」：逐路核对——新消息（条数 ✓）、流式 token（末条文本 ✓）、尾部块出现/长高（tailEl RO ✓）；唯一不覆盖面 = 「末条消息无内容变化的纯异步高度增长」，设计已按 parity 声明并判定可接受（与现状 content watch 语义一致），登记完整 ✓
- 「贴底时应跟随但 RO/watch 都不触发」：item 高度任何变化 → totalSize 变 → Virtualizer 根节点高变 → contentWrap RO ✓；tailEl 高度变化 ✓；视口 resize（scrollEl RO）✓；纯宽度变化显式 no-op ✓；load-more 前插走 isPrepend 抑制窗（V9 覆盖）✓。未找到残留场景
- 矩阵与 §4.4 ⑥ 单测清单、U2 实施描述三方一致 ✓

## 交叉引用一致性终检

- 决策 D1-D7：正文顺序与 §4.3 本章结论一致；D1/D2/D5/D6/D7 的跨节引用（§4.2、§4.4 ④、§6.1/6.2）全部命中 ✓
- 探针 P-*：表内 ✅4（P-coord/offset/viewport/comp）+ ⛔3（P-wrap/timing/no-loop），与表头声明、D3 正文「回到 ✅4+⛔3」一致；P-unread 仅存于被否谱系的历史叙述（D3 被否③），无悬空现行引用 ✓
- 场景 V1-V9：9 行齐；V5 双轮（滚轮 + 滚动条拖拽）、V9 三次 load-more + 贴底恢复断言 ✓
- 护栏 ①-⑧：编号完整；⑤ 的 M1→M2 顺序依赖、⑦ 的收敛窗口 + dpr 阈值与 §6.1 U4 描述一致 ✓
- virtua 实装行号复核：core :78（findItemIndex 减 startMargin）/ :114-140（case-3）/ :287（scrollToIndex 公式）、vue :348（scrollRef prop）/ :368（contentRect）/ :430-431（scroll emit）/ :446（scrollRef 挂载）/ :470-471（scrollSize）全部精确 ✓；本轮新增引用的 core :60-61（q 累积）、:120-125（补偿条件）、:161（jump 冲刷）、:266（scrollTop 直写）、vue :459-462（watch(S) post-flush → $fixScrollJump）为 MUST_FIX 证据链
- §6.2 改动地图与 D5/D6/D7/U1-U4 的文件清单互相覆盖，无遗漏文件 ✓；§6.3 待验证检查点与正文声明一致 ✓

## 结论

D3 的收窄修复干净利落（判据废弃而非修补，噪音面与未定义分支一并消除），交叉引用体系经第三轮独立复核全部成立，文档工程质量高。D7 复合判据修掉了 v2 的主洞（follow 写入回声），但「程序性写入 offset 只增不减」的结构性论证在 `$fixScrollJump` 负向补偿路径上不成立——session 切换混合估算收敛期可构造双合取同时命中的回声序列，且误脱离后果是无提示的静默停摆（spacer 增长不标 unread）。需按 MUST_FIX 三选一补设计（推荐有界抑制窗，同时修正「无标记位」卖点的表述），并把 lastOffset 重置语义与 S4 落实/弃用状态一并收口。修完即可进入实施。
