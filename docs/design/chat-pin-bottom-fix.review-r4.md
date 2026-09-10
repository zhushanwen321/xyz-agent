# 对抗式审查报告：chat-pin-bottom-fix.md（v4，第 4 轮）

> 主审（tech-design-review）。本轮聚焦：上轮 must-fix（force 后收敛抑制窗）修复成立性——特别攻击抑制窗机制本身（关闭条件可达性 / lastOffset NaN 交互 / 上限到期未收敛）；护栏⑦双采样规格；程序性 scrollTop 写路径第四条枚举（read `node_modules/virtua@0.50.0` core/index.js + vue/index.js 全文复核）；交叉引用一致性终检。不重查前三轮已确认项（骨架、事实断言、验收设计、方案对比、D3 矩阵、P-wrap 降级四件套）。

## Summary

**1 must-fix, 3 suggestions。**

上轮 must-fix 的抑制窗方向成立、修法正确：force 入口同步置 lastOffset=NaN + 窗内暂停判据①的翻 false（恢复分支/wheel 不抑制、快照照常维护）对 r3 击穿序列（负向补偿回声 × 同窗底部增长双合取）确实构成覆盖；程序性写入逐路径推导对它声称的三条路径（follow 写入 / clamp 回声 / fixScrollJump case-3 负补偿）逐一复核无误。lastOffset 交互时序核验通过：force 写入回声建快照 → 窗内负补偿回声更新快照（照常维护）→ 关窗后首个用户拖拽事件的比较基准 = 最后一次程序性回声位置（贴底态下即真实底部附近），拖拽上滑 offset 递减 ∧ distance>40 正确命中——该链路无洞。

**但抑制窗的关闭条件「contentWrap RO 静默 ≥2 帧」量纲自相矛盾**：useMarkdownStreaming 的 50ms flush 节流使流式期 RO 事件以 ~50ms（≈3 帧 @60Hz）为周期到达，而「静默 ≥2 帧」= 33ms 阈值 < 50ms 周期——窗口会在每个 flush 间隙的静默期**提前关闭**，D7 ② 与副作用登记⑥ 双双声称的「流式 session 切换 RO 持续活跃、窗口恒取 1500ms 上限（以此罩住该场景）」在 2 帧阈值下**不成立**：窗口实际在 force 后 ~80ms（首个 flush 间隙）即关，此后流式收敛期若仍有负向补偿回声 × 底部增长，r3 must-fix 场景在「切到正在流式的 session」这一主场景上重新暴露。这不是机制错，是阈值量纲写错——修复是把「静默」钉死为时间阈值（如 ≥120ms，覆盖 50ms cadence 两个周期）或显式重算帧定义下的登记行为。

其余核查：virtua 全文扫描确认第四条候选写路径 **case-5 `:shift` prepend jump**（vue/index.js:453-455 `watch(data.length) → $update(5,[len,shift])` → core:147 `q(p(R,n[0],!0))` 入 S 队列 → 同一 $fixScrollJump 冲刷），且 MessageStream.vue:41 实际接线 `:shift="isPrepend"`——该路径**安全性成立但未入推导枚举**（jump 恒正向维持视口锚定 + isPrepend 期用户必已脱离，双保险）；smooth 滚动路径（core:252-255 `behavior:'smooth'`）app 无调用不可达。双采样规格基本完备，流式瞬态误报面建议补一句判读指引。交叉引用体系（D1-D7 / ✅4+⛔3 / V1-V9 / 护栏①-⑧ / §6 拆分）第四轮独立复核全部成立。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.3 D7 ②（抑制窗关闭条件）/ 反例重演⑥ / U1 | P1 规格自洽（新增，本轮发现） | **「RO 静默 ≥2 帧」在 50ms flush 节流下与已登记行为矛盾**。量纲推导：60Hz 下 2 帧 = 33.3ms；useMarkdownStreaming 流式期每 50ms flush 一次、每次内容增长都触发 contentWrap RO（≈每 3 帧一个 RO 事件）；「上一个 RO 事件后连续 2 帧无新事件即关窗」的阈值 33ms **小于** 事件周期 50ms → 每个 flush 间隙都被判定为「静默 ≥2 帧」→ 窗口在 force 后首个间隙（~80ms）即关闭。后果二选一皆坏：若按字面实现，r3 must-fix 的主场景「切到正在流式的 session」不被罩住（窗口早已关），负补偿回声 × 流式底部增长双合取重新可达；若实现者隐式按 ms 理解（如 2×50ms），则反例重演⑥ 的副作用量化（「恒取硬上限 1500ms」）与关闭条件文本脱节，实施期必然二义。这是把 r3 修复的覆盖声明建立在一条与其依赖的节流常数不相容的阈值上 | 二选一写入 D7 ②：① 关闭条件改时间阈值——「contentWrap RO 静默 ≥120ms（覆盖 md flush 50ms cadence 两个周期）」，硬上限 1500ms 不变，反例重演⑥ 的登记行为随之自洽（流式期恒达上限）；② 保留帧定义但显式声明「帧 = RO 事件周期而非 rAF 帧」并重算登记——不可取，RO 无固有周期。推荐①。U1 单测清单补「50ms 间隔连续 RO 事件下窗口不提前关闭」用例 |
| SUGGESTION | §4.3 D7 ② / 反例重演⑤ | P1 残余风险登记补全（新增） | **1500ms 硬上限到期但测量收敛未完（超长会话收敛风暴超窗）的关窗后补偿回声场景未登记**。现登记面：⑤b 仅覆盖「收敛期外零星负补偿」（三重巧合、单次）；⑥ 仅覆盖窗口**内**副作用。介于两者之间的「收敛风暴本身长于 1500ms（会话数千 item、逐批 RO 实测的尾部批次落在上限之后）→ 关窗后仍有高密度补偿回声 × 未补偿底部增长 → 双合取命中」既非零星也未入册。量级判断：常规会话收敛（视口 ± 缓冲 ~40 item 两轮实测）远小于 1500ms，该场景仅超长会话 + 慢机可达，概率低但后果 = 静默停摆（同 r3 must-fix 后果） | 并入反例重演⑤ 作第四条残余风险（四要素：可达性 = 收敛时长 > 1500ms 的超长会话/慢机 / 恢复 = 任意下滚即重贴 / 重审条件 = 实机观测切超长 session 后误脱离 / 判定 = 可接受）；或加有界续窗——上限到期时若最近 100ms 内 RO 仍活跃则续窗一次（总上限 3000ms，仍保持「有界时间窗标记」卖点）。二选一，推荐登记（保持机制最小） |
| SUGGESTION | §4.3 D7 程序性写入逐路径推导 | P1 完备性（新增） | **第四条候选写路径未入枚举：case-5 `:shift` prepend jump**。实装链（本轮逐行核实）：vue/index.js:453-455 `watch(() => props.data.length) → $update(5, [len, props.shift])`；core/index.js:147 case-5 当 `shift=true` 时 `q(p(R, n[0], !0))` 把 prepend 调整量入同一 pending jump 队列 S，并置 `x=2` 模式；core:120 case-3 在 `x=2` 期间对**全部** item 的测量 delta 无条件补偿（含底部增长与收缩）→ 同经 `$fixScrollJump` 冲刷写 scrollTop（core:266）。MessageStream.vue:41 实际接线 `:shift="isPrepend"`，即 load-more 前插期该路径活跃。安全性论证成立（双保险）：prepend jump 恒为正向（前插高度使 scrollTop 增加以维持视口锚定，offset 递增，第一合取不命中）；且触发前提是用户已上滑到顶部点「加载更多」→ D7 判据①已翻 false，误翻无效果。但推导文本声称「程序性写入的逐路径」枚举而漏此条，实施者读到 `:shift` 接线会质疑推导完备性 | D7 推导补第四条：case-5 shift jump + x=2 全量补偿模式，附上述双保险论证；顺带登记 smooth 路径（core:252-255，`scrollToIndex({smooth:true})` 的原生动画多回声）经 grep 本仓 follow/rail 无调用、不可达，若未来引入其回声 offset 递增亦安全 |
| SUGGESTION | §4.4 ⑦（双采样） | P3 判读指引（新增，微小） | **流式瞬态下双采样仍可能双超阈值**：护栏⑦前置是「最近一次 follow 后 500ms 收敛窗口」，流式期 follow 每 token 重触发、窗口末尾采样天然落在「上一 token 的 follow 已滚、下一 token 高度已长」的瞬态里；若 markdown 渲染积压使瞬态持续 >200ms，复采也超 → warn。dev-only + 已有「误报即上调/改采样」重审条款，代价可接受，但缺一句判读指引会让首个触发者误当真回归 | ⑦ 补一句：warn 判读时结合 `isStreaming`（流式期窗口末尾采样跨瞬态属已知形态，先按 V2 静止后 gap 复核再定性）；或评估给断言加 isStreaming 门槛（不推荐——会掩盖流式期的真回归） |

## 上轮 findings 修复判定

| 上轮 | 判定 | 依据 |
|------|------|------|
| MF（fixScrollJump 负向补偿双合取击穿） | **方向成立，遗留 1 must-fix（量纲）** | 推荐方案①（有界抑制窗）正确采纳：force/重建启动、窗内暂停判据①、wheel 恒即时、恢复分支不抑制、lastOffset 快照照常维护——对 r3 击穿序列构成覆盖；「无标记位」卖点诚实改述为「仅一条有界的时间窗标记」；程序性写入三路径推导与反例重演③重写均复核无误。但窗口**关闭条件**的「静默 ≥2 帧」量纲与 50ms flush 节流不相容（见本轮 MUST_FIX），覆盖声明在主场景上不成立 |
| S1（S4 采样时点未落实 vs 变更历史全修） | **成立** | 护栏⑦落实双采样（窗口末尾 + 超阈值后 200ms 复采，两次均超才 warn）；变更历史 v3 条目诚实标注「当轮漏落实」 |
| S2（lastOffset 重置语义） | **成立** | D7 ① 显式钉死 NaN 重置规则（force/重建同步置 NaN，下一事件只建快照不判定）；护栏⑥ 与 U1 单测清单各补对应用例。交互时序本轮专项核验：窗内负补偿回声更新快照后，关窗后首个用户拖拽的比较基准 = 最后程序性回声位置（贴底态即真实底部附近），判定正确 |
| S3（同帧合流残余面） | **成立** | 反例重演⑤c 四要素登记（亚帧级交错、仅滚动条路径、下一拍解除、可接受） |
| 影响面 r3（2S + 2INFO） | **成立** | D3 矩阵 isStreaming 守卫迁移声明（§4.3 D3 表第 2 行）、第三条语义差异 isPrepend 不点亮（判定改进）、vlistBottom :304（附录）、MessageStream 清扫锚点 :386-390（D7 同步清扫 + §6.2）均已核对落实 |

## 程序性 scrollTop 写路径第四条专项核查（virtua 0.50.0 实装全文）

- **写 scrollTop 的全部语句**：core:255（J flush 直写，scrollTo/scrollBy/scrollToIndex 非 smooth 共用）、core:252-254（smooth 原生动画）、core:266（R 包装器 `v()` 即 $fixScrollJump 冲刷直写）、core:262-264（iOS touch 期 overflow:hidden 切换，touch-only）、W 变体（core:298-303，window 级 scroll，非 scrollEl 容器形态）。桌面 Electron scrollEl 场景可达 = J flush、$fixScrollJump、smooth（app 未用）三条 + 本轮新枚举的 case-5 jump（经 $fixScrollJump 同一出口）——设计已列三条，第四条为 case-5（见 SUGGESTION 2，安全性成立）
- **case-1（scroll 更新，core:98-107）/ case-2（core:110-112）/ case-4 viewport（:142-144）/ case-7/8**：均无 scrollTop 写——case-1 只更新内部 offset 版本与滚动方向 `y`，case-8 只设 case-3 的参照区间 `_`。设计「三条 + 待补 case-5」之外无隐藏写路径
- **附带发现（无 finding 级影响）**：core:266 冲刷带 `r && u()`——fixScrollJump 写后会取消 pending 的 J 程序性写（`2===x` 即 shift 模式时）；即 isPrepend 期一次 follow 写可能被 prepend jump 冲刷吃掉，由 RO 网重触发自愈，无需设计处理，登记备查
- **vue 层复核**：vue:453-455（data.length→case-5）、vue:459-462（`watch([S],{flush:'post'})→$fixScrollJump`）与设计引用一致；`:446`（scrollRef 挂载）、`:470-471`（scrollSize）行号无误

## 交叉引用一致性终检

- 决策 D1-D7 / 探针 ✅4+⛔3 / 场景 V1-V9（9 行齐，V5 双轮、V9 三次 load-more）/ 护栏①-⑧（结构①②③ + 机器④⑤ + 回归⑥⑦⑧，⑤ M1→M2 顺序依赖在文）/ §6 U1-U5 与 §6.2 改动地图互相覆盖——全部对上 ✓
- v4 新增文本落点核验：D7 ② 抑制窗（含 1500ms 上限与⑥副作用量化）、反例重演⑤a/b/c 三条四要素、护栏⑥ force 后快照/抑制窗用例、D3 isStreaming 守卫与第三条语义差异、变更历史 v4 含 v3 漏落实诚实标注 ✓
- 附录行号抽核（core :78/:114-140/:147/:266、vue :348/:368/:430-431/:446/:453-455/:459-462/:470-471、MessageStream.vue :41/:304）本轮逐一 read 复核无误 ✓

## 结论

抑制窗机制本身选型正确、lastOffset 交互与逐路径推导经第四轮实装级核验成立，第四条写路径（case-5 shift jump）安全但应补入枚举。唯一实质问题是关闭条件的量纲：2 帧阈值 < 50ms flush 周期导致「流式 session 切换恒取上限」的登记行为在字面实现下不成立，把 r3 修复的覆盖声明悬空——改一句时间阈值（≥120ms）即闭合。修完 MUST_FIX（外加两条登记补全）即可进入实施。
