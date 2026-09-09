# 对抗式审查报告：chat-pin-bottom-fix.md（v1）

> 主审（tech-design-review）。审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`。所有「事实」类判定均已 read 源码核实（virtua 0.50.0 node_modules 编译 JS、useVirtuaFollow.ts、useMessageStreamScroll.ts、MessageStream.vue、useMessageStreamNotices.ts、useMarkdownStreaming.ts、useForkNoticeStream.ts、style.css）。

## Summary

**3 must-fix, 6 suggestions.**

总体判断：这是一份事实准确度罕见地高的设计文档——全部 virtua 实装行号引用（core/index.js:78 的 `findItemIndex` 减 startMargin、:287 的 scrollToIndex 公式、vue/index.js:470-471 的 scrollSize 不含 startMargin、:368 的 viewport=contentRect）经逐一核对**全部属实**；根因分析（R1-R4）与方案对比（A/B/C/D 两维度评估 + 明确推荐）扎实。三个 must-fix 集中在两处被忽略的攻击面：**非滚轮上滑输入不脱离锚定（RO 兜底网放大 G2 侵犯频率）**与 **P-wrap 降级路径自洽性**，均为「方案在主路径上成立、但在真实用户输入面与失败分支上不闭合」的问题，不推翻方案 A，但实施前必须补设计。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §2 G2 / §4.3 D3 / INVAR-M4-2 | P0-4 问题定义 + P0-10 | **非滚轮上滑输入不脱离锚定，RO 兜底网把「扯回」触发源从 4 个信号放大到「每一次内容高度变化」**。useVirtuaFollow.ts:68-73 证实：脱离锚定**只**由 `onWheel deltaY<0` 驱动；滚动条拖拽上滑、键盘 PageUp/Home 滚动**不触发 wheel**，`stickToBottom` 保持 true。旧架构下此类用户只在 4 个 watch 信号到达时被扯回（低频、多数场景碰不到）；方案 A 的 RO 兜底网对**任何**内容高度变化（含用户阅读期间中部图片加载、异步 reflow）都调 `followIfStuck()`，而 rAF 内重读的 `stickToBottom` 仍为 true → 视口被持续扯回底部。G2（「用户滚动意图不被侵犯」）对滚动条/键盘用户结构性不成立，且比现状更差。文档未识别此隐藏根因，也未声明「非滚轮上滑用户不在保护范围」的假设 | 三选一并写入 D3：① onScroll 增加向下远离判定（distance 增大趋势翻 false，需评估与程序性滚动的冲突）；② scrollEl 监听 `scroll` 事件区分用户滚动（scrollTop 突变且非 pending rAF 写入）；③ 显式登记为已接受代价并给出量化（该输入路径的使用频率假设），V5 验收补滚动条拖拽场景 |
| MUST_FIX | §4.5 P-wrap 降级路径 / §4.2 方案 C 行 | P0-16 降级路径不完整 | **P-wrap 失败降级到方案 C 后，RO 兜底网同时失效，降级方案不自洽**。降级描述是「去掉 wrapper，原生 `scrollEl.scrollTop = scrollEl.scrollHeight`」——但 D3 的 RO 兜底网以 `contentWrapEl` 为内容高度变化的唯一观察目标；去掉 wrapper 后 RO 网失去观察对象（RO 观察 scrollEl 只覆盖视口 resize，不覆盖内容增长），R1（「最后一次增长无人补偿」——本设计自称的**主因**）在降级形态下原样复活，方案 C 实际只修 R2/R3 的坐标面。§4.2 C 行「F1-F4 都能修」的说法在降级语境下不成立（F1=R1 时序盲区）。P0-16 要求「⛔ 实施期门探针失败时方案怎么调整」有完整答案，当前答案只覆盖了写路径、丢掉了触发路径 | 降级方案补全：wrapper 去掉后 RO 改观察 `tailEl` + virtua 虚拟列表根元素（或 scrollEl 的最后一个内容子节点）；或明确声明降级形态接受 R1 退化 + 量化退化范围（哪些 F 回归） |
| MUST_FIX | §4.4 ⑥ usePinBottomGuard / §2 G1 度量 | P0-16 断言误报 | **dev 断言条件 `stickToBottom && 静止 500ms && gap > 2px` 在「滚动条拖拽上滑」场景系统性误报**。与 MUST_FIX 1 同根但独立成立：即使不修输入面，断言本身也会在用户用滚动条上滑阅读时（stuck 未翻 false、gap 自然 >2px、滚动静止超 500ms）触发 `[pin-bottom-guard]` 假警告——这正是 §4.4 自己设的重审条件「误报率 > 0 即上调阈值」会在 dev 日常使用中立刻兑现的场景，护栏会狼来了 | 断言前置收紧：仅在「最近一次 followIfStuck/followToBottom 执行后的收敛窗口内」检查（即断言自己触发的 follow 是否收敛），而非任意时刻的 stuck 态；或结合「距底曾达到 ≤2px 后又被拉开」判据 |
| SUGGESTION | §4.3 D3 未读标记纪律 | P1-10 / D3 效果声明 | **三分类漏判「视口上方内容增高」**：用户脱离锚定阅读中部历史时，中部 item 异步长高（旧图片加载、延迟渲染）→ contentWrapEl 高度增加 → 归类「增高」→ 标 `unreadBelow` → 「回到底部」浮层点亮。但该变化不是「下方有未读新内容」（是 reflow），与 D3 效果声明「`unreadBelow` 语义反而变准」相悖，浮层成为噪音。另：纯宽度变化（contentRect 宽变高不变）触发 RO 回调时三分类均不命中，行为未定义 | 分类增加「变化位置在视口上方（virtua fixScrollJump 已补偿）→ 不标 unread」分支，或收窄增高判定为末项/尾部区域高度；纯宽度变化显式 no-op |
| SUGGESTION | §5.2 验收场景 | P0-15 配套 | **验收缺 load-more（isPrepend）场景**：D3 的未读抑制与 §6.3 检查点 2（isPrepend 复位与 RO 回调先后）是设计明确承担的风险，但 V1-V8 无一覆盖「脱离锚定态下点加载更多 → 不误标 unread、不跳动」。被推迟到「U2 实施期实测一次」削弱了验收章节的完备性——这恰是三分类里最易错的类 | 补 V9：长会话脱离锚定态触发 load-more，断言无「回到底部」浮层闪现、视口锚定不跳 |
| SUGGESTION | §4.3 D6 证据 | P1-8 事实陈述过时 | **D6 的消费关系描述与模板现状矛盾**：D6 称 vlistBottom「当前仅被 fork notice 的 absolute 定位基线消费（useForkNoticeStream.ts:81-92）」，但 MessageStream.vue:116-131 的 ForkNotice 已是文档流 block 渲染（无任何 `:style` top 绑定）；`forkNoticeTop`/`forkNoticeBaseTop` 计算链疑似已无渲染消费方（死路径）。§6.3 检查点 3 已自觉标注「实施期再核」，但 §4.3 正文证据应先核实再定措辞——若确为死代码，D6 的正确形态可能是「登记待删」而非「修正坐标」 | 实施前 grep `forkNoticeTop` 渲染消费方；确认为死路径则 D6 改为登记清理项，vlistBottom 修正的价值论证同步调整 |
| SUGGESTION | §4.4 ⑥ | P1 断言阈值 | **非 100% 缩放下 ≤2px 阈值可能擦边误报**：浏览器 zoom 125%/150% 时 scrollHeight/scrollTop/clientHeight 的取整误差可接近 1-2px，恰好踩线。dev 环境常用非整数缩放的 mac retina 外接屏场景不少见 | 阈值说明补「按 devicePixelRatio 向上取整容差」或验收时记录实际缩放倍率；至少在护栏警告上下文里带上 dpr 便于归因 |
| SUGGESTION | 附录 参考锚点 | P1-8 行号偏移 | 两处行号小偏移（不影响判定）：`vue/index.js:351` 的 scrollRef prop 声明实际在 **:348**（:351 是 `as` 默认值）；core case-3 实际范围 **:114-140**（doc 写 :115-131）。其余全部行号核对精确（useVirtuaFollow.ts:131/:166、vue/index.js:368/:446/:470-471、core/index.js:78/:287、常量族 :37/:48/:55/:61、style.css:120、MessageStream.vue:16/:305-310 均命中） | 实施时按实际行号修正 |
| SUGGESTION | §4.1 失败路径表 / §4.4 ⑤ | P1-3 受众背景 | 「RO 兜底网未生效（浏览器 API 缺失）」一行对 Electron + Chromium 21x 的运行时不成立——renderer 内 ResizeObserver 恒存在，真正会走这条路径的只剩「RO 挂载失败/观察目标 null」的代码 bug。失败路径表可更诚实地区分「理论 API 缺失」与「接线 bug」 | 合并该行为「RO 接线失败」，恢复指引不变 |

## 逐项判定摘要（P0 主审条目）

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | 背景/目标/现状问题（含物理数据流+失败模式+根因）/方案（对比+决策+护栏）/验收/实施全齐 |
| P0-2 delta 链 | 不适用 | v1 首版，无前序版本可引用 |
| P0-3 结论先行 | 通过 | 每章首句结论 + SCQA 开篇，全文最强项之一 |
| P0-4 问题定义 | **不通过** | 见 MUST_FIX 1：真实问题定义忠于用户痛点（差 1-2 行），但隐藏根本问题（非滚轮输入不脱离锚定 × 兜底网放大）未识别 |
| P0-5 重实现轻体验 | 通过 | §3.2 F1-F4 全使用者视角，§4.1 终态反转对照 |
| P0-6 术语定义 | 通过 | 「贴底」「尾部块」首次出现即定义并绑定实例 |
| P0-7/8/9 方案对比 | 通过 | 4 方案 × 两维度 + 明确推荐 + 被否若用（但方案 C 行的「F1-F4 都能修」在降级语境不成立，计入 MUST_FIX 2） |
| P0-10 解决根因 | **不通过（局部）** | R1/R2/R3 修复链成立（坐标断言全部实装核实）；G2 在非滚轮输入面反向恶化，见 MUST_FIX 1 |
| P0-11 关键事实 | 通过 | 全部 virtua 行为断言（findItemIndex 减 startMargin、scrollSize=max(total,viewport) 不含 startMargin、offset 正偏移、viewport=contentRect、scrollRef prop、case-3 顶锚限定）与 node_modules 0.50.0 编译 JS 逐一核对属实；两处行号偏移降级 P1-8 |
| P0-13/14/15 验收 | 基本通过 | 真实 dev app + Playwright + 8 场景 + 机器可读判据（gap ≤ 2px），非单测非 mock，投入匹配「大改动」定级；缺口：load-more 场景（SUGGESTION 2）、滚动条拖拽负面场景（MUST_FIX 1 配套） |
| P0-16 运行时断言 | **不通过** | 探针清单完备（✅4 + ⛔3 带门），但 P-wrap 降级路径不完整（MUST_FIX 2）、dev 断言误报面（MUST_FIX 3） |
| P0-17 数据流图 | 通过 | §3.1 六环节物理数据流含位置标注 |
| P0-18 错误恢复 | 通过 | §4.1 失败路径表三条均有具体恢复动作（第 1 行的成立性见 SUGGESTION 6） |
| P0-21 邻居不变量 | 通过（本土化） | V8 故障注入验护栏；本设计纯渲染进程内存行为、无宿主共享状态写入，归口判定合理 |

## 结论

方案 A 的主因果链（坐标错位 R3 + 尾部块 R2 + 时序盲区 R1 → RO 兜底网 + 索引直取 + offset）经实装核实成立，验收设计质量高于常见水准。3 个 must-fix 均为补设计而非换方案：①把「哪些用户输入算脱离锚定」的假设显式化并处理滚动条/键盘路径；②补全 P-wrap 降级后 RO 网的观察目标；③收紧 dev 断言的触发前置。修完后可进入实施。
