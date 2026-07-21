# Retrospect · fix-sidebar-subagent-workflow-scroll

## derived 摘要

- totalWaves = 3，totalCases = 5
- gateFailCount = 0，devRetryCount = 0，testRetryCount = 0
- redLightConfirmed = true，firstTryPassRate = 1.00

执行指标干净——所有 gate 一次过，无重试。

## 第 1 段：derived 异常归因

无异常。firstTryPassRate=1.00，gateFailCount=0。

归因：任务复杂度 low（spec complexity 评级），根因在进入 CW 前已通过上一轮分析定位清楚（flex 高度传递链断裂），修复方案（加 h-full）和测试策略（结构断言，happy-dom 兼容）在 plan 前就已确定。CW 流程忠实执行了既定方案，没有遇到需要返工的岔路。

## 第 2 段：可泛化流程模式（processIssues）

1. **[pattern] clarify 阶段的「假决策」陷阱**：本 topic 在 clarify 阶段一度把「修复范围」和「测试策略」包装成需要用户拍板的决策提问，但这两点都能从代码/环境事实推导（修复范围用户上一轮已选定，测试策略受 happy-dom 限制唯一可行）。CW guidance 反复强调「提问前先分类：决策还是事实」，但 guidance 本身的「要记录 ADR」叙事有诱导性——容易让人为满足「问了问题」的形式而硬凑提问。判据应回归根本：能在不问用户的情况下通过读代码/环境得到答案的，是事实，不问。只有「答案不存在于代码里、必须人来定」的才是决策。

2. **[pattern] CSS 布局 bug 的测试策略：结构断言优于行为断言**：jsdom/happy-dom 无 layout 引擎，真实滚动行为（scrollHeight/clientHeight/overflow 触发）不可靠。这类「视觉/布局」缺陷的回归防护，结构断言（验证修复对应的 class 存在）是唯一可靠策略。可泛化到所有「渲染正确性依赖 CSS class 组合」的场景（如 flex 布局、grid 布局、定位）。判据：如果 bug 的根因是「缺某个 class」，测试就断言该 class 存在；不要试图测「加了 class 后的视觉效果」。

3. **[observation] SessionList 作为「能滚动的基线」极有价值**：定位本 bug 时，SessionList（根元素直接是 ScrollArea + h-full）作为对照基线，让「为什么 SessionList 能滚而 SubagentList 不能」的差异一眼可见。代码库里有「正确实现的同类组件」时，优先用它做对照分析，比从零推导 flex 规则快。

## 第 3 段：设计级风险（knownRisks）

1. **[设计级·low] Sidebar 子视图区的 flex 高度传递链依赖隐式约定**：本次修复的根因是「子视图区容器不是 flex container，子组件根 div 必须自己带 h-full 才能撑满」。这是一个隐式约定——未来新增任何 sidebar 子视图组件，如果根 div 忘了 h-full，会重蹈覆辙。overflow-hidden 是防御层，但不解决高度传递。unverified=true（待观察：未来新组件是否会遵循此约定，是否值得在 Sidebar 加注释或抽一个 SidebarPanel 容器组件强制 h-full）

2. **[代码级·low] happy-dom 下无法验证真实滚动行为**：结构断言验证了「根 div 有 h-full」，但「有 h-full 后 ScrollArea 真的会滚动」这个因果链在单测层无法验证（需 layout 引擎）。实际滚动行为的验证依赖手工/Playwright E2E。unverified=true（本次未跑真实浏览器验证，依赖 flex 布局规则的正确性推理）

## 第 4 段：未闭环评估

review 阶段无 open issue（issues 为空数组提交）。无 should-fix/nit 需评估。

## 全绿质量自检结论

测试套件有效：
- 删任一组件的 h-full → 对应 U1/U2/U3 立即变红（红灯校验已验证）
- 删 Sidebar overflow-hidden → U4 变红（源码正则断言）
- 四态渲染不回归由现有 27 个用例 + E1 整体跑守护
- 非覆盖率填充：每个 case 针对具体 bug（flex 高度链断裂的修复点），非 happy path 凑数
