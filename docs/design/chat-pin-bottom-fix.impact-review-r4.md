# 影响面审查报告 r4（chat-pin-bottom-fix.md v4）

审查人：tech-design-impact-review（第 4 轮，聚焦项）　日期：2026-09-08
依据检查项：P0-12（接管后原流程步骤复刻/声明放弃）、P0-19（外部共享状态写入面）、P0-20（代价量化四要素）

## Summary

0 must-fix, 1 suggestion, 2 info. 上轮 2 条 suggestion 修复全部成立（实读 D3 对应段落 + 实装代码核对）；D7 新增的「force 后收敛抑制窗」影响面基本穷尽（窗状态单实例、rail/force 入口适配一致、流式 session 切换窗口恒取上限已量化登记），发现 1 处术语混淆风险（两个「抑制窗」同名不同物，文档未显式区分）与 2 处备忘级信息。v4 可进入实施。

## 上轮 suggestion 修复核验（S1-S2）

| 上轮项 | 文档位置 | 核验结果 |
|---|---|---|
| S1 isPrepend 行为变更未登记 | §4.3 D3 效果段第三条已声明差异 | ✅ 成立：实装核对 useMessageStreamScroll.ts:45-51——messages.length watch 确无 isPrepend 抑制，脱离态前插会点亮 unread；文档登记为「刻意降噪（前插不产生新内容），V9 验收覆盖，判定可接受（改进）」，与「逐路对齐」总声明的冲突由显式差异清单消解；§6.3 检查点第二条与 V9 通过标准（浮层不误点亮）呼应一致 |
| S2 isStreaming 守卫去留 | §4.3 D3 触发矩阵第 2 行 | ✅ 成立：矩阵显式声明「保留现状的 lastRenderTurn.isStreaming 守卫——仅在末 turn 流式中触发，编辑历史消息等非流式内容变化不触发——useMessageStreamScroll.ts:64 既有语义原样迁移」；实装 :64 核对无误（`if (deps.lastRenderTurn.value?.isStreaming)`），U1/U2 迁移有 spec 依据 |

上轮 2 条 INFO：附录 vlistBottom 行号已改为 :304（实读 `const vlistBottom` 恰在 :304 ✅）；useMessageStreamScroll.ts:70 陈旧注释确认由 D5 删文件自然消失（变更历史 v4 条目注明「无需另行处理」）✅。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|---|---|---|---|---|
| SUGGESTION | §4.3 D3 矩阵 isPrepend 行 / D7 ② | P0-12 实施歧义 | 文档存在两个同名「抑制窗」且未显式声明其独立性：① isPrepend 前插抑制窗（D3 矩阵末行 + §6 U2 + §6.3 检查点，宿主在 MessageStream 的 RO 回调层，抑制的是**标 unread**）；② force 后收敛抑制窗（D7 ②，宿主在 useVirtuaFollow，抑制的是**脱离判据翻 false**）。两窗状态分属不同文件、无交互（实推独立：isPrepend 窗内可能同时有 RO 跟随 → force 无关，不启动②；②窗内的 RO 静默判定不受 isPrepend 影响），但术语同名 + 均带时间窗语义，实施者（U1/U2 拆给不同单元）与后续维护者易混。反例：U2 实施者可能误把 isPrepend 抑制实现进 useVirtuaFollow 的②窗状态里 | 在 D7 ② 或 D3 矩阵 isPrepend 行加一句显式区分（如「此『前插抑制窗』与 D7 ②『收敛抑制窗』为两个独立窗口：前者抑制 unread 标记（MessageStream 层），后者抑制脱离判据（useVirtuaFollow 层），互不触发互不包含」） |
| INFO | §4.3 D7 ② / MessageStream.vue:142 | force 入口枚举完备性 | D5 称 force 入口「2 个（挂载 + session 切换）」——那是 useMessageStreamScroll 职责迁移口径；系统内 followToBottom(true) 实际有第三处调用点：`MessageStream.vue:142` 「回到底部」按钮 @click。D7 ② 「每次 followToBottom(true)」的措辞已统一覆盖它（按钮点击也会启动收敛抑制窗），行为无害——按钮点击时 RO 通常已静默、窗口经 2 帧静默即关，且用户刚主动要求回底、窗内短暂抑制脱离符合意图。仅备忘：若实施者按「2 个 force 入口」字面枚举启动窗的调用点，会漏掉按钮路径 | 实施时以「followToBottom(force=true) 内部统一启动」为准，不在调用点枚举 |
| INFO | §4.4 ⑥ 测试清单 / §6.1 U1 验收 | 测试清单对称性 | U1 验收列「force 后快照/抑制窗用例」，护栏 ⑥ 列「force 后首个 scroll 事件只建 lastOffset 快照不判定；收敛抑制窗内负补偿回声不脱离、wheel 恒即时脱离」——两侧覆盖一致 ✅；但「抑制窗关闭条件（RO 静默 2 帧后关闭 + 1500ms 硬上限兜底）」本身未见单测条目（关闭时序是 v4 新机制，回声拦截用例都隐含「窗开着」这一前提）。happy-dom 下 RO 为手动 stub，恰好可精确控制「静默帧数」，可测性无障碍 | U1 测试清单可补一条：注入 N 次 RO 回调后断言窗关闭（N=2）/ 伪造 RO 持续活跃断言 1500ms 后窗关闭。非阻塞，实施时补即可 |

## 聚焦任务核验记录

1. **上轮 2 suggestion 修复**：全部成立（见上表，含实装 :45-51 / :64 逐行核对）。
2. **D7 收敛抑制窗新影响面**：① 窗状态在 useVirtuaFollow（composable 实例级）——本组件 MessageStream 单实例消费，split mode 下两个 PaneSessionView 各自持有 vlistRef 与 follow 状态机（:key=sessionId 重建），无跨实例共享窗状态的面 ✅；② 与 isPrepend 抑制窗的独立性——语义上独立（见 SUGGESTION 1），文档唯一缺口是未显式声明；③ 入口适配一致性——rail 跳转（反例④「rail 非 force 入口，不启动抑制窗」→ 跳中部即时脱离）与 force 入口（②「每次 followToBottom(true) 与 session 重建后启动」统一措辞，覆盖挂载/session 切换/回到底部按钮全部三处调用点，见 INFO 1）声明一致 ✅；④ 流式 session 切换窗口恒取 1500ms 硬上限已在反例⑥ 四要素量化登记（对照现状「拖拽用户永远不脱离」）✅；⑤ 窗口与护栏⑦的交互——dev 断言的 500ms 收敛窗口（§4.4 ⑦）与 D7 抑制窗是第三个时间窗，但二者作用域无交集（⑦只管「是否 warn」，不改变行为），且文档分处两节不构成混淆面。
3. **变更历史 v1-v4 轨迹一致性**：v3 条目如实登记「主审 r2 S4 当轮漏落实（变更历史误称全修，第 3 轮审查抓出）」，v4 条目对应「护栏⑦ dev 断言落实双采样时点（r2 S4 补落实）」——漏落实→补落实链条自洽 ✅；v4 条目逐项与正文对得上（抑制窗 ↔ D7 ②、lastOffset NaN ↔ D7 ①、双采样 ↔ §4.4 ⑦、isStreaming 守卫 ↔ D3 矩阵、第三条语义差异 ↔ D3 效果段、残余风险⑤b/⑤c ↔ D7 反例⑤、:304 行号 ↔ 附录、陈旧注释 ↔ D5）✅。
4. **交叉引用一致性**：护栏⑦ 双采样（窗口末尾一次 + 200ms 复采）↔ §6.1 U4（「前置收敛窗口 + dpr 阈值」概括性引用，无矛盾）↔ §4.4 ⑥ 测试清单（force 后快照/抑制窗用例在 U1 验收与护栏⑥ 双侧出现且措辞一致）✅；D3 三条语义差异 ↔ 矩阵（trace 折叠行=spacer 静默、末条图片=parity、isPrepend 行=不标）↔ §6.3（isPrepend 检查点 + V9）✅；探针表 ✅4/⛔3 与 §4.5 章结论一致、P-unread 无悬空引用（仅存于被否谱系③历史记述）✅。
5. **不重查项**：wrapper 安全性、白名单、P0-19/20、宿主写入面、mobile-renderer、testid 层级、C-state-11 序号、守卫顺序依赖——按指示未重查。
