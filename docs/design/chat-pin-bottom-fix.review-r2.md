# 对抗式审查报告：chat-pin-bottom-fix.md（v2，第 2 轮）

> 主审（tech-design-review）。审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`。本轮聚焦：上轮 3 must-fix 修复成立性（特别攻击 D7 的 distance 推导与 D3 判据 ③）、交叉引用一致性终检；不重查上轮已确认项（P0-1/3/5/6/7/8/9/11/17/18/21 与已核实事实断言）。事实判定均 read 实装核实：`node_modules/virtua@0.50.0` core/index.js / vue/index.js、useVirtuaFollow.ts、MessageStream.vue、useNoticeStack.ts、useMessageStreamNotices.ts、useForkNoticeStream.ts、conversation-stream-block-rendering.md。

## Summary

**1 must-fix, 4 suggestions。**

上轮 3 个 must-fix 中 2 个修复成立：MF2（P-wrap 降级）已闭合为「方案 C 完整形态」四件套，退化范围量化诚实（R1 仅收尾子集失去触发 + 护栏 ⑦ 兜底），方案 C 行同步修正；MF3（dev 断言误报）收敛窗口 + dpr 容差修复成立，且在我的新 must-fix 场景中护栏 ⑦ 恰好能报警（正向配合）。**MF1（D7 双向化）修复不完整**：D7 的核心支柱「程序性写入落点 distance 恒 ≤ 0，结构上碰不到 >40 分支」在 R4 估算→实测收敛窗口内不成立——推导假设「写入时刻与 scroll 事件送达之间 virtua store 的 scrollSize 不再增长」，而估算误差（session 切换全量 200px 估算 / 长粘贴 / 多图）恰恰在该窗口内分帧到达，误差 > 40+startMargin 时 scroll 事件回声会看到 distance > 40 → 误翻 false → 跟随链死亡直到用户点按钮。反例重演 ③ 的「一 tick 内收敛」推演依赖同一未证明假设。存在无标记位的修复方向（「offset 较上一事件递减 且 distance > 40」才翻 false）。D3 判据 ③ 有一个未覆盖的分类面（与视口相交/视口内的 reflow 增长）与一个未定义分支（同帧上方+下方混合增长），建议补探针场景。交叉引用整体高度一致（D1-D7 / P-* / V1-V9 / 护栏 ①-⑧ 编号与引用全部对上，✅4+⛔4 计数正确），仅 2 处行号级错误——其中 D7 清扫清单的 `MessageStream.vue:404-408` 指到了 rail u5 注释，真正的 INVAR-M4-2 断言（:418「结构上不可能」）不在清单行号内，有清扫遗漏风险。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.3 D7「采用」段 / 反例重演 ③ | P0-16 运行时断言（新增，本轮发现） | **D7 的「无需标记位：程序性写入落点 distance 恒 = -startMargin - tailHeight ≤ 0，结构上碰不到 >40 分支」在 R4 估算→实测收敛窗口内不成立**。核实：virtua scroll 事件经 `g.R(4, () => emit("scroll", g.N()))`（vue/index.js:430-431）同步发射，handler 内 `v.scrollSize` 读的是**当时** store——而 store 的 totalSize 会被 RO 实测持续增写。反例：① **session 切换重建**（反例 ③ 自己的场景）：全量 item 按 ESTIMATED_TURN_HEIGHT=200 估算，`followToBottom(true)` 强制写入用估算缓存（落点按推导 distance ≤ 0 ✓），随后各 item 实测经 RO 分帧写入 store（scrollSize 持续增长），若某次 scroll 事件回声送达时已落地的估算误差累计 > 40+startMargin（长会话必然，200 估算 vs 短消息实际几十 px 是**负向**、vs 长粘贴正向几百 px），handler 读到 distance > 40 → 误翻 false；② **长粘贴/多图 append**（R4 正向误差）：follow 写入目标含 200 估算，写入触发末项渲染 → virtua RO 实测 800 → scrollSize +600，若实测先于 scroll 事件回声进 store（scroll-event 与 RO 投递的相对顺序是实现细节，本文档未验证也未声明）→ distance ≈ 556 > 40 → 误翻 false。误翻后果连锁：RO 网 followIfStuck 的 rAF 重读 stickToBottom=false → 不滚 + 标 unread → 后续一切跟随死亡，用户视角 = 「流式中窗口停在中途 + 回到底部按钮亮」——恰是本设计要杀的 F1 变体，且反例 ③ 声称的「一 tick 内收敛」在同一假设下不成立。注意：护栏 ⑦（收敛窗口断言）在此场景会报警（正向），但报警 ≠ 修复 | 三选一写入 D7：① **无标记位方案（推荐）**：翻 false 需同时满足「distance > 40 **且 offset 较上一次 scroll 事件递减**」——用户一切上滑输入（滚轮已由 wheel 覆盖、滚动条拖拽/键盘 PageUp/Home）都使 offset 递减，贴底态程序性写入只增不减（scrollToIndex 目标恒为底部或以下、fixScrollJump 顶锚补偿等量保 distance、浏览器 clamp 只向下取更贴底）；② 接受最小标记位（最近程序性写入时间戳 + 回声窗抑制），D7 删去「无需写标记位」卖点；③ 保留现设计但把「结构上碰不到」降级为「条件成立」，新增 ⛔ 探针 P-echo（dev app：session 切换 + 长粘贴两场景，断言整个估算收敛期 stickToBottom 不被 scroll 回声翻 false）并在 §4.5 登记。无论选哪条，反例重演 ③ 的推演需重写（现版依赖未证明假设） |
| SUGGESTION | §4.3 D3 判据 ③ | P1-10 分类完备性（新增） | **判据 ③ 的补偿签名只覆盖「完全在视口上方」的增长，两个面未定义/误判**。核实 core/index.js case 3（:114-140）：完全在视口上方的 item 在 y/x 任一标志组合下都会被补偿（`o+r <= e` 与 `o < e && o+r < e+v` 对 fully-above 均真——用户提示的「y/x 标志位导致上方增长未补偿」假设**不成立**，此点 D7/D3 现文安全）；但**与视口顶相交**（straddling：`o < e < o+r`，y=0/x=0 时 `o+r <= e` 为假）与**视口内**的 item 增长不被补偿 → ΔscrollTop ≈ 0、ΔbottomPos > 0 → 被 ③ 判为「底部区域真实增长」→ 脱离锚定阅读历史的用户看到视口内/顶部图片加载展开时「回到底部」浮层误点亮——这正是上轮 S1 要消的噪音，v2 只消了「视口上方」子集。另：**同帧混合增长**（上方图片加载 + 下方 token append）时 ΔbottomPos = Δ上 + Δ下，既不 ≈0 也不 ≈ΔbottomPos，两分支均不命中，行为未定义 | 判据补第四类：补偿签名不命中时按「增长源相对视口底的位置」细分（增长源在视口底之上 → 静默；之下 → unread），或明确接受「视口内/相交增长误标 unread」并量化（P-unread 补「脱离锚定 + 视口内图片加载」场景断言浮层行为——无论修不修，该场景进探针）；同帧混合增长的落点显式定义（建议按 unread 优先，宁可多亮不漏亮） |
| SUGGESTION | §4.3 D7 同步清扫 / §6.2 | P1-8 引用面行号错误（新增） | **清扫清单的 `MessageStream.vue:404-408 注释` 指错位置**：实测 :404-408 是 rail 的 [u5] streamItems 基准注释，与 INVAR-M4-2 无关；MessageStream.vue 内真正的 INVAR-M4-2 引用在 **:388 / :390 / :418 / :423** 四处，其中 **:418「不可能：useVirtuaFollow INVAR-M4-2 下 onScroll 只单向翻真，永不翻 false」是与 INVAR-M4-2′ 直接矛盾的强断言**——按现清单行号执行清扫会漏改这四处中最关键的一处。另核对确认：conversation-stream-block-rendering.md:318、packages/ui/src/features/chat/index.ts:12、use-virtua-follow.test.ts:6/7/113 三处引用面登记准确 | 清扫清单行号改为 MessageStream.vue:388/:390/:418/:423（或以 grep `INVAR-M4-2\|单向翻真` 结果为准），§6.2 同步；实施时以 grep 而非行号定位（C-proc-10 惯例） |
| SUGGESTION | §4.4 ⑦ / §5.1 | P1 断言采样时点（新增） | dev 断言「500ms 收敛窗口内 gap > 阈值即 warn」未定义采样时点：若在窗口内即时采样，R4 估算收敛期的瞬态 gap（下一条 RO 网 follow 到来前的 1-2 帧内 gap 可达数百 px）会触发误报——恰是护栏自己声明的重审条件「误报即上调阈值」会被合法瞬态兑现。D7 修复（上轮 MF1）后此窗口更敏感 | 断言检查时点定为「收敛窗口末尾且内容高度已静止 ≥100ms」采样一次（或连续两次采样均超阈值才 warn），把「收敛中」与「未收敛」区分开 |
| SUGGESTION | 附录 参考锚点 / §1 | P1-8 行号偏移（新增，微小） | `useVirtuaFollow.ts:27`（BOTTOM_THRESHOLD）实际在 **:26**（:27 为空行后注释错位；§1 概念段与附录两处引用同错）。同文件 :68-73 / :131 / :166 核对无误 | 改 :26 |

## 上轮 must-fix 修复判定

| 上轮 | 判定 | 依据 |
|------|------|------|
| MF1 非滚轮上滑不脱离锚定 | **部分成立，遗留 1 must-fix** | R5 根因、D7 决策、V5 滚动条拖拽路径、INVAR-M4-2′ 修订与 5 处引用面登记齐备，方向正确；但「无需标记位」的结构性论证在 R4 收敛窗口有反例（见本轮 MUST_FIX），反例重演 ③ 自身的收敛推演也被同一假设击穿 |
| MF2 P-wrap 降级不自洽 | **成立** | 降级四件套闭合：原生写底 + RO 收窄 tailEl/scrollEl + git 历史恢复信号 watch + C-state-11 限期回访；退化范围量化诚实（仅 R1 收尾子集，护栏 ⑦ dev 报警发现）；降级形态下 D7 distance 推导仍成立（原生写底落点更贴底，distance 更负）；§4.2 方案 C 行「单独采用 F1/F4 依旧」同步修正 |
| MF3 dev 断言误报 | **成立（遗留采样时点建议）** | 收敛窗口前置 + 窗口被用户脱离/新 follow 取消 + max(2, 2×dpr) 阈值（S4 一并修复），滚动条拖拽静止态结构性不误报；遗留：窗口内瞬态采样误报面（本轮 SUGGESTION 4） |

## 交叉引用一致性终检

- 决策编号 D1-D7：正文顺序（D1/D2/D3/D7/D4/D5/D6）与 §4.3 本章结论列举顺序一致；全文交叉引用（D1/D2 于 §4.2、D2 公式于 D7、D5 于 D3、§4.4 ④ 于 D6 等）全部命中 ✓
- 探针 P-*：§4.5 表 ✅4（P-coord/offset/viewport/comp）+ ⛔4（P-wrap/timing/unread/no-loop）与表头计数声明一致；正文引用（D3 引 P-unread、代价段第三条对应 P-unread 降级）命中 ✓；实装行号本轮复核 core :78/:114-140/:287、vue :348/:368/:446/:470-471 全部精确 ✓
- 场景 V1-V9：表内 9 行齐；V5 含滚动条拖拽两轮、V9 load-more ×3；§6.3 与 D3 对 V9 的引用命中 ✓
- 护栏 ①-⑧：§4.4 表内编号完整，D4/§6.1 U4 引用命中 ✓
- INVAR-M4-2′ 引用面 5 处：数量与文件清单自洽（useVirtuaFollow 头部 / MessageStream.vue / chat index.ts / conversation-stream-block-rendering.md / use-virtua-follow.test.ts）；其中 useVirtuaFollow 与 test 文件由 §6.2 改写行覆盖，chat index.ts 与 md 由清扫行覆盖——**唯 MessageStream.vue 的行号指错**（见 SUGGESTION 2）
- §6.3 检查点 3（fork 死路径）已结案标注，与 D6 表述一致 ✓

## 结论

方案 A 主链、MF2/MF3 修复、全部 virtua 事实断言与交叉引用体系经本轮独立复核成立。D7 的双向化方向正确、反例重演纪律执行到位，但「程序性写入落点 distance 恒 ≤ 0」在 R4 估算收敛窗口存在结构性反例（scroll 事件回声读到增长后的 scrollSize），且该场景下反例 ③（session 切换）的收敛推演同样被击穿——需按 MUST_FIX 三选一补设计（推荐无标记位的「offset 递减 ∧ distance>40」复合判据）。修完即可进入实施。
