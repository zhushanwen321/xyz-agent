# message-stream working 态对齐 + 滚动锚定修复 实现计划

## 业务目标

让对话流在 AI 工作中（streaming）时按 `draft-message-stream.html` 设计稿真实展示「流程无背景下划线全展开 + 脉冲点 + 实时计时」，完成后自动收起成一行 meta；并修复滚动锚定错误（用户上滚被强制拉回 + 无回到底部入口）。成功标准：working 态 thinking/tool 全展开不可收、完成后自动折叠一行、上滚脱离锚定且出现「回到底部」浮层、滚回底部自动恢复锚定。

约束：用 vitest（happy-dom + @vue/test-utils），不引入 E2E 框架；前端遵守 xyz-ui 组件 + Tailwind 语义类 + lucide 图标（禁原生元素/emoji/硬编码色）。

不做：折叠态 localStorage 记忆（设计稿未决项 3，本次用组件内本地态，刷新丢失，对齐现状）；滚动「跳到底部」提示的高级动效。

## 技术改动点

- 修改 `src-electron/renderer/src/components/panel/message-stream/Block.vue` — 新增 `working: boolean` prop；thinking/tool 折叠判定统一改为「working 时强制展开且不可手动收」；移除 tool 的 `isRunning` 短路（由 `working` 主导）；working 时 header 点击禁用
- 修改 `src-electron/renderer/src/components/panel/message-stream/Turn.vue` — 把 `turn.isWorking` 作为 `working` prop 传给三类 Block；watch `isWorking` 从 true→false 时复位 `expanded=false`（完成后自动收起成一行）；`elapsed` 在 working 态用 setInterval live 计时，完成时 clearInterval（onUnmounted 清理）
- 修改 `src-electron/renderer/src/composables/effects/useChatScroll.ts` — 实现真正的 stickToBottom 检测（onScroll 读 `scrollHeight - scrollTop - clientHeight`，< BOTTOM_THRESHOLD(40px) 则贴底）；新增 `unreadBelow` ref（非贴底时有新内容置 true，回贴底清零）；scrollToBottom 内部完成后把 stickToBottom 设回 true
- 修改 `src-electron/renderer/src/components/panel/MessageStream.vue` — 滚动容器绑 `@scroll.passive="onScroll"`；两个 watch 的 scrollToBottom 前加 `if (!stickToBottom.value) { unreadBelow=true; return }`；结构拆为外层 `relative` + 内层 `overflow-y-auto`（scrollEl 下移），外层底部加「回到底部」浮层按钮（`v-if="unreadBelow"`，xyz-ui Button + lucide ChevronDown，点击 scrollToBottom('smooth')）
- 创建 `src-electron/renderer/src/__tests__/panel/block-working.test.ts` — mount Block 验证 working 折叠行为（DOM 断言：内容可见性、header 点击禁用、chevron 旋转态）
- 创建 `src-electron/renderer/src/__tests__/effects/use-chat-scroll.test.ts` — 验证 onScroll 贴底判定 + unreadBelow 置位/清零（happy-dom 模拟 scrollTop/scrollHeight/scrollTo）

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1   | Block.vue, Turn.vue（仅「传 working」部分）, block-working.test.ts | - | G1 | 问题1+3：Block 折叠行为。Turn 传 working 依赖 Block 的 prop 定义 → 同文件并入 |
| W2   | Turn.vue（完成复位 + elapsed live）| W1 | - | 问题2：完成收尾 + 实时计时。改 Turn 同文件 → blocked_by W1 |
| W3   | useChatScroll.ts, MessageStream.vue, use-chat-scroll.test.ts | - | G1 | 问题4：滚动锚定 + 浮层。与 W1/W2 文件无交集 → 可与 W1 并行 |
| W4   | 验收 Wave | W1, W2, W3 | - | 跑全量单测 + lint + typecheck，整体回归 |

并行安全性：W1 与 W3 改动文件完全无交集（{Block.vue, Turn.vue} vs {useChatScroll.ts, MessageStream.vue}），同组可并行。W2 改 Turn.vue，必须等 W1 完成。W3 不改 Turn.vue，与 W2 无文件交集但 W2 依赖 W1；编排上 W1+W3 并行 → W2 → W4。

## 单测用例清单（AC 级）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | Block.vue:thinking working 态 | mount Block type=thinking content="长推理内容…" working=true | thinking 正文 `<p>` 存在于 DOM（非收起预览）| 正常 |
| U2 | Block.vue:thinking 非 working | mount Block type=thinking working=false（不传 collapsed 或 collapsed=true）| 仅显示预览行（previewText，截断 60 字符），正文 `<p>` 不存在 | 正常 |
| U3 | Block.vue:thinking working 点击禁用 | mount Block type=thinking working=true，trigger click header | 正文仍展开（点击不切换折叠态），thinkingCollapsed 不变 | 边界 |
| U4 | Block.vue:thinking 非 working 可收起 | mount Block type=thinking working=false，trigger click header → 再 trigger click | 首次点击正文出现，再次点击正文消失（toggle 正常）| 正常 |
| U5 | Block.vue:tool working 态 completed 工具 | mount Block type=tool，tool.status='completed'，working=true | 工具详情（toolName + argPath + result）存在于 DOM，即使 status 非 running 也展开 | 正常 |
| U6 | Block.vue:tool 非 working 默认收起 | mount Block type=tool，tool.status='completed'，working=false | 仅 header（工具名+状态），详情区不存在；点击 header 后详情出现 | 正常 |
| U7 | Block.vue:tool running 强制展开（回归保护）| mount Block type=tool，tool.status='running'，working=false | 详情展开 + 进行中光标存在（保留原有 running 可见语义）| 边界 |
| U8 | Block.vue:tool 失败红框 | mount Block type=tool，tool.status='error'，working=false | 整块带 danger 边框 class（`border-danger`），header 显「· 失败」| 异常 |
| U9 | Turn.vue:完成复位 expanded | mount Turn，turn.isWorking=true（trace 展开）→ setProps turn.isWorking=false | expanded 复位 false，trace 区域（`v-if="showTrace"`）从 DOM 消失 | 边界 |
| U10 | Turn.vue:elapsed working live | mount Turn turn.isWorking=true，用 vi.useFakeTimers + advanceTimersByTime(5000) | elapsed 文本随时间增长（如 "1m 05s"→"1m 10s"），setInterval 驱动 | 正常 |
| U11 | Turn.vue:elapsed 完成停止 | mount Turn turn.isWorking=false | elapsed 为静态计算值，无 setInterval（advanceTimers 不改变它）| 正常 |
| U12 | Turn.vue:onUnmounted 清理 | mount Turn turn.isWorking=true → unmount | 不抛错，无 timer 泄漏（vi.useFakeTimers + 检查 advanceTimers 后无副作用）| 边界 |
| U13 | useChatScroll.ts:onScroll 贴底判定 | scrollEl 模拟 scrollHeight=1000 clientHeight=800，scrollTop=159（差 41px）| stickToBottom=false（>40 阈值）| 边界 |
| U14 | useChatScroll.ts:onScroll 贴底判定 | scrollEl scrollTop=159→160（差 40px）| stickToBottom=true（≤40 阈值）| 正常 |
| U15 | useChatScroll.ts:unreadBelow 置位 | stickToBottom=false，模拟新内容到达调用 scrollToBottom | scrollToBottom 不实际滚动（被 guard 拦截），unreadBelow=true | 正常 |
| U16 | useChatScroll.ts:unreadBelow 清零 | unreadBelow=true → scrollTop 拉到底（onScroll 触发贴底）| unreadBelow=false，stickToBottom=true | 正常 |
| U17 | useChatScroll.ts:scrollToBottom 自洽 | 调用 scrollToBottom('auto') | 执行 el.scrollTo，完成后 stickToBottom=true | 正常 |

## E2E 用例清单

项目无 E2E 框架（仅第三方依赖 cytoscape 自带 playwright.config.js，非本项目）。降级为手动验证 + 建议未来装 Playwright。

| 用例ID | 场景 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|------|------|------|---------|
| E1 | working 态全展开 | 有一个 session，发起对话 | 1.发送消息 2.AI 工作中观察 trace | thinking/tool 全展开不可收，脉冲点+实时计时跳动，末条光标 | 手动 |
| E2 | 完成自动收起 | E1 进行中 | 等 AI 完成 | trace 自动收起成一行 meta（已工作+计时+计数 badge），收尾 summary 恒显 | 手动 |
| E3 | 上滚脱离锚定 | 流式进行中 | 在底部时向上滚 | 不被拉回底部，「回到底部」浮层出现 | 手动 |
| E4 | 回到底部恢复锚定 | E3 已脱离 | 点「回到底部」浮层 | 平滑滚到底，浮层消失，后续新消息自动跟随 | 手动 |
| E5 | 已在底部跟随 | 持续在底部 | 新消息到达 | 自动滚到底，无浮层 | 手动 |

> 提示用户：建议安装 Playwright（`pnpm dlx playwright install`）以获得可回归的 E2E 自动化。当前手动验证覆盖 happy path（E1/E2/E4）+ 关键状态转换（E3 脱离）。

## 覆盖率 gate

- gate 命令：`cd src-electron/renderer && npx vitest run src/__tests__/panel/block-working.test.ts src/__tests__/effects/use-chat-scroll.test.ts --coverage`
- 阈值：Block.vue / Turn.vue / useChatScroll.ts 增量行覆盖率 ≥ 60%
- gate 位置：列为验收阶段独立 todo（isVerification=true），W4 执行

## 实现步骤

1. [W1] 写 U1–U8 失败测试（block-working.test.ts，mount Block 各 working 组合）→ 实现 Block.vue 的 `working` prop + 统一折叠判定 + Turn.vue 传 working → 测试通过 → lint/typecheck → 提交
2. [W3]（与 W1 并行）写 U13–U17 失败测试（use-chat-scroll.test.ts）→ 实现 useChatScroll.ts 真实 stickToBottom + unreadBelow → 实现 MessageStream.vue scroll guard + 结构拆分 + 回到底部浮层 → 测试通过 → lint/typecheck → 提交
3. [W2] 写 U9–U12 失败测试（补入 block-working 或新 turn-working.test.ts）→ 实现 Turn.vue 完成复位 expanded + elapsed live setInterval + onUnmounted 清理 → 测试通过 → lint/typecheck → 提交
4. [W4] 验收 Wave：`cd src-electron/renderer && npx vitest run`（全量单测）+ `npm run lint` + `npm run typecheck` + 覆盖率 gate（U 命令）+ 手动验证 E1–E5，全绿才算完成
