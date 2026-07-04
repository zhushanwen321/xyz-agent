# 对话流渲染修复（顺序错乱 + 滚动锚定 + 跳转按钮）实现计划

## 业务目标

修复对话流区域的三个渲染缺陷：① 流式过程中 thinking/text 交替出现时渲染顺序错乱（同一轮内交错错位 + 跨轮次文字跳变）；② 贴底时流式渲染不能稳定锚定底部，会先上移再回落；③ "回到底部"按钮点击一次后，手动上滚不再出现。

成功标准：
- **顺序**：一个 AI 回合内 thinking → text → thinking → text 的真实到达顺序在渲染上一一对应；工具循环开启新一轮（新 message_start）时，已有 text 不从底部"跳"到上方折叠区。
- **锚定**：贴底态下，text_delta / thinking_delta / tool_call_start / message.complete（trace 折叠）任一发生，视口始终保持在底部（距底 ≤ 8px），不出现可见上漂。
- **按钮**：用户手动上滚（距底 > 阈值）后"回到底部"按钮立即出现，无需等待新消息到达；点击后滚回，再次上滚仍出现。

约束：
- 数据模型已有 `contentBlocks` 字段（`shared/message.ts:129-130`）与 `ContentBlock` 类型（已就绪，history 路径已用），本次为**补全流式路径填充 + 渲染层接入**，不改字段语义。
- 测试框架 vitest（happy-dom 环境）+ playwright（E2E，项目已配 `@playwright/test`）。
- 严格遵循项目规范：禁 any、禁原生 HTML 元素、组件行数上限（template ≤400 / script ≤300）、emit 单对象 payload、失败必须重置 streaming 状态。
- MarkdownRenderer 异步渲染（shiki）是客观约束，滚动方案必须覆盖异步重排。

不做：
- 不重构 Turn.vue 的 user 气泡 / 编辑 / fork / ChangeSetCard 等无关逻辑。
- 不改 event-adapter 侧产生多 assistant message 的机制（它是 pi 工具循环的忠实反映，跨轮"跳变"靠渲染层合并 trace+summary 解决，而非改数据生产）。
- 不引入新的 markdown 渲染库或改动 shiki 配置。
- 不做流式渲染的性能优化（虚拟列表等），仅修正确性 + 锚定稳定性。

## 技术改动点

### 问题 1：顺序错乱（数据层 + 渲染层）

- **修改 `src-electron/renderer/src/stores/chat-chunk-processor.ts`** — 流式路径补全 `contentBlocks` 填充。`message_start`（:95-110）初始化空 `contentBlocks: []`；`text_delta`（:111-119）首次到达时 push `{type:'text', refId:'text'}`（按真实到达顺序，非置顶）；`thinking_start`（:120-129）push `{type:'thinking', refId:blockId}`；`tool_call_start`（:157-173）push `{type:'toolCall', refId:callId}`。沿用已有的 `findLastAssistantIndex` 定位目标 message。`thinking_end/thinking_delta/tool_call_end/tool_call_update/complete` 只更新既有元素，不碰 contentBlocks（顺序已定）。
- **修改 `src-electron/runtime/src/infra/pi/message-converter.ts:99-126`** — history 路径实现"循环内 push"以真正按到达顺序。当前 text 在循环外一次性 `unshift`（永远置顶），改 `unshift→push` 仍只是"永远末尾"（因为 text 累积在循环外的 textContent，循环结束才 push）。**正确做法**：循环内遇到 `part.type==='text'` 时，若该 text 不是首块则立即 push 一个 text contentBlock 占位（text 仍累加到 textContent 字符串，refId 统一为 'text'）。这样 `[thinking, text, toolCall]` 的 parts 才能产出同序 contentBlocks。与流式路径、mock 数据三方语义统一。
- **修改 `src-electron/api/mock/data.ts`** — 校对三条带 contentBlocks 的 mock 样本（:138-143 / :170-173 / :200）：当前手写顺序需与"按到达顺序 push"语义对齐（a1 当前 text 写在最后，符合 push 语义，保留；确认其余一致）。仅在不一致时调整。
- **修改 `src-electron/renderer/src/components/panel/message-stream/Turn.vue:114-181`** — **核心改动，风险最高**：取消"trace 三段式 + 末尾 summary 分层"结构，改为按 `assistant.contentBlocks` 到达顺序的单一连续流渲染。**关键设计——text 块恒显、不受 trace 折叠控制**：
  - 遍历 `turn.assistants`，每个 assistant 内按 `contentBlocks` 顺序产出块。
  - **text 块**：永远渲染（无论 working/expanded 状态），落在 contentBlocks 指定的到达位置。末尾 assistant 的末个 text 块附 streaming 光标 + hover actions（复制/复制MD/fork，从原 summary 区迁移）。
  - **thinking/tool 块**：受 `showTrace`（isWorking || expanded）控制，折叠时隐藏。即 trace 折叠只隐藏过程块，不隐藏 text——保证用户始终能看到 AI 的最终回答。
  - `toolCall→tool` 类型映射；refId 查 `thinking[]/toolCalls[]/content`，refId 未命中时跳过该块（防御 hydration 不一致）。
  - 无 `contentBlocks` 字段的旧消息：回退为按"thinking→toolCalls"顺序渲染过程块（无 text 中间块概念，兼容老数据），text 仍取 content 恒显。
  - `isMidAssistant` 废弃（不再区分中间/末尾 assistant 的 text 归属）。
- **修改 `src-electron/renderer/src/composables/logic/messageTurns.ts`** — 评估 `isWorking`/`hasFoldable` 是否仍需调整（isWorking 仍由最后 assistant status==='streaming' 判定，不变；hasFoldable 改为基于 contentBlocks 是否含非 text 块判定，逻辑等价但更直接）。属适配修改。

### 问题 2：滚动锚定不稳定

- **新建 `src-electron/renderer/src/composables/effects/useStickToBottom.ts`** — 基于 ResizeObserver 监听滚动容器内容高度变化，高度增长时若处于贴底态则自动 `scrollToBottom`。导出 `stickToBottom`/`showJumpButton`/`scrollToBottom`/`onScroll`/`scrollEl`/`observe(target)`。ResizeObserver 在 happy-dom 不可用（测试需 mock，见 U15）。**复用判定**：项目内无任何 ResizeObserver/IntersectionObserver/useElementSize 工具（已 grep 确认），新建合理。
- **修改 `src-electron/renderer/src/composables/effects/useChatScroll.ts`** — 替换为基于 `useStickToBottom` 的实现，或保留文件名内联 ResizeObserver 逻辑（二选一，倾向保留文件名减少改动面）。核心：① `onScroll` 维护 `stickToBottom`；② 新增 ResizeObserver 监听内容根高度变化，stickToBottom 时自动滚到底；③ `scrollToBottom` 的 `await nextTick()` 之后追加一次 `requestAnimationFrame` 等待，覆盖同步布局；异步 markdown 渲染完成的事件由 ResizeObserver 兜底捕获（DOM 变高触发 observer）。
- **修改 `src-electron/renderer/src/components/panel/MessageStream.vue:95-114`** — 滚动触发 watcher 补全：watch 最后一条 message 的 `thinking.length` / `toolCalls.length` 变化（当前只 watch `content.length`，漏了 thinking/tool 块增高）；或改用 ResizeObserver 方案后简化为单一高度监听（推荐后者，更彻底）。

### 问题 3：跳转按钮不重现

- **修改 `src-electron/renderer/src/composables/effects/useChatScroll.ts`** — `onScroll`（:28-35）增加：非贴底时（distance > 阈值）置 `showJumpButton.value = true`。新增 `showJumpButton` ref（语义="用户当前不在底部"，区别于 `unreadBelow`="有未读新内容"）。按钮显隐改由 `showJumpButton` 驱动。`scrollToBottom` 实际滚动后置 `showJumpButton=false`。
- **修改 `src-electron/renderer/src/components/panel/MessageStream.vue:35`** — 按钮 `v-if="unreadBelow"` 改 `v-if="showJumpButton"`。

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | chunk-processor.ts、message-converter.ts、data.ts | — | A | 数据层：流式路径补 contentBlocks + history unshift→push + mock 校对。纯数据逻辑，可独立验证。|
| W2 | Turn.vue、messageTurns.ts | W1 | B | 渲染层：按 contentBlocks 到达顺序遍历，合并 trace+summary。依赖 W1 的 contentBlocks 已填充。|
| W3 | useChatScroll.ts、MessageStream.vue（按钮部分） | — | A | 问题 3：跳转按钮语义修正。与 W1/W2 无数据依赖，可并行。|
| W4 | useChatScroll.ts、MessageStream.vue（滚动部分） | W3 | B | 问题 2：ResizeObserver 锚定 + watcher 补全。依赖 W3（同文件 useChatScroll 先完成按钮语义）。|
| W5 | 验收 Wave：全量测试 + 覆盖率 | W1-W4 | — | 跑全部单测 + E2E + 覆盖率 gate。|

- 并行组 A（W1 ‖ W3）：文件无交集（W1 改 stores/runtime，W3 改 composable + 模板按钮行），可并行。
- 并行组 B（W2 ‖ W4）：W2 改 Turn.vue，W4 改 useChatScroll/MessageStream 滚动部分——**注意 W2 和 W4 都可能动 MessageStream.vue**，若 W4 仅改 watcher（script 区）而 W2 改 template 中 Turn 引用，文件内分区不重叠但仍建议串行 W2→W4 以免合并冲突。保守起见 W4 blocked_by W2。

## 单测用例清单（AC 级）

> 测试框架 vitest，运行 `cd src-electron/renderer && npx vitest run 指定测试文件`（renderer 子项目，happy-dom 环境，`@` alias 在 renderer/vitest.config.ts）。happy-dom 无 ResizeObserver，W4 测试需 `global.ResizeObserver = mockClass`。

### W1 — 数据层（chat-chunk-processor / message-converter）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | chunk-processor.ts:message_start | applyChunk 处理 message_start，prev 空 | 新 message 含 `contentBlocks: []`（空数组初始化）| 正常 |
| U2 | chunk-processor.ts:text_delta 首次 | assistant.content='' + contentBlocks=[]，收到首个 text_delta 'h' | content='h' 且 `contentBlocks=[{type:'text',refId:'text'}]`（push 一次） | 正常 |
| U3 | chunk-processor.ts:text_delta 后续 | contentBlocks 已含 text 块，再收 text_delta 'i' | content='hi'，contentBlocks **不**新增 text 块（仅 1 个 text 块） | 边界 |
| U4 | chunk-processor.ts:thinking_start | 收 thinking_start（thinkingId='th1'） | thinking=[{id:'th1'}] 且 contentBlocks 尾部 push `{type:'thinking',refId:'th1'}` | 正常 |
| U5 | chunk-processor.ts:tool_call_start | 收 tool_call_start（toolCallId='tc1'） | toolCalls=[{id:'tc1'}] 且 contentBlocks 尾部 push `{type:'toolCall',refId:'tc1'}` | 正常 |
| U6 | chunk-processor.ts:交错顺序 | 依次 message_start→thinking_start(th1)→text_delta('hi')→tool_call_start(tc1)→thinking_start(th2) | contentBlocks 顺序 = `[thinking:th1, text, toolCall:tc1, thinking:th2]`（严格按各自首次到达顺序：th1 在 text_delta 之前到，故在前） | 正常 |
| U7 | chunk-processor.ts:thinking_end/delta 不改顺序 | contentBlocks 已定，收 thinking_end + thinking_delta | contentBlocks 数组不变（长度/顺序不变），仅 thinking[].content/endTime 更新 | 边界 |
| U8 | chunk-processor.ts:无 assistant 时 text_delta | prev 无 assistant，收 text_delta | findLastAssistantIndex 返回 -1，函数 return，不抛错 | 异常 |
| U9 | message-converter.ts:循环内 push | pi parts=[thinking, text, toolCall]（三种 part 类型各一），convertPiHistory | contentBlocks 顺序=`[thinking, text, toolCall]`（循环内按 part 出现顺序 push，text 落在真实位置） | 正常 |
| U10 | message-converter.ts:纯 text | parts=[{type:'text'}] | contentBlocks=[{type:'text',refId:'text'}]（仅一个） | 边界 |
| U10b | message-converter.ts:text 先于 thinking | parts=[text, thinking]（text part 在前） | contentBlocks=`[text, thinking]`（验证循环内 push 能让 text 落在非末位——unshift/循环外 push 都做不到，这是循环内 push 的判别用例） | 边界 |
| U11 | chunk-processor.ts:跨轮 message_start 保留 | a1 已有 contentBlocks=[text,thinking] → message_start(a2) → text_delta | a1.contentBlocks **原样保留**；text_delta 写入 a2（findLastAssistantIndex 命中 a2） | 正常 |
| U11b | chunk-processor.ts:thinkingId 缺失一致性 | thinking_start **无 thinkingId** | 生成的 fallback blockId 同时用于 thinking[].id 与 contentBlocks[].refId，两者相等（防两处分别 randomUUID 断链） | 边界 |
| U11c | chunk-processor.ts:toolCallId 缺失一致性 | tool_call_start **无 toolCallId** | fallback UUID 在 toolCalls[].id 与 contentBlocks[].refId 间一致 | 边界 |
| U11d | chunk-processor.ts:tool_call_end 不 push | contentBlocks 已定，收 tool_call_end | contentBlocks 长度/顺序不变，仅 toolCalls[].status 更新（防误 push 重复块） | 边界 |

### W2 — 渲染层（Turn.vue 按到达顺序）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U12 | Turn.vue:按 contentBlocks 渲染 | mount Turn，assistant 含 contentBlocks=[thinking:th1, text, toolCall:tc1]，对应内容，working 态 | DOM 中 Block 顺序：thinking(th1) → text → tool(tc1)，**与 contentBlocks 顺序一致**（用 stub Block 捕获 attrs 顺序） | 正常 |
| U13 | Turn.vue:text 不在末尾 | contentBlocks=[text, thinking:th1]（text 先到），working 态 | Block DOM 顺序：text → thinking，text 不被强制移到末尾 | 正常 |
| U14 | Turn.vue:折叠态 text 仍可见（核心回归） | complete turn，hasFoldable=true，**expanded=false**（非 working） | thinking/tool 块被折叠隐藏，但 **text 块仍渲染可见**（不能折叠后整个回合空白——用户能看到 AI 回答） | 正常 |
| U15 | Turn.vue:跨轮不跳变 | 两 assistant：a1(contentBlocks=[text])，a2(contentBlocks=[thinking:th1, text])，streaming 中 | a1 的 text 保持在原位（不被折叠进 trace），a2 的块 append 在其后；无元素从底部"跳"到上方 | 边界 |
| U16 | Turn.vue:无 contentBlocks 回退 | assistant 无 contentBlocks（旧数据），有 thinking/toolCalls | 回退渲染 thinking→tool 过程块（受折叠），text 仍取 content 恒显，不报错 | 边界 |
| U17 | Turn.vue:toolCall→tool 映射 | contentBlocks 含 toolCall 块 | 传给 Block 的 type='tool'（非 'toolCall'），Block 正常渲染 | 正常 |
| U18 | Turn.vue:streaming 光标 + hover actions | 末尾 assistant streaming，末块为 text | streaming 光标接在该 text 块后；complete 后 hover actions（复制/复制MD/fork）挂载在该 text 块区 | 正常 |
| U18b | Turn.vue:dangling refId 防御 | contentBlocks=[{thinking,th1}] 但 thinking=[]（refId 不匹配） | 跳过该块不渲染，不抛错 | 异常 |
| U18c | Turn.vue:空 text 块 | contentBlocks 含 text 类型块但 assistant.content='' | 不渲染空 text 块（沿用 .trim() 守卫） | 边界 |
| U19 | messageTurns.ts:hasFoldable 新逻辑 | assistant contentBlocks 仅含 text 块 → false；含 thinking 块 → true | 新判定（contentBlocks 含非 text 块）正确，与旧（看 thinking/toolCalls 数组）等价 | 正常 |

### W3 — 跳转按钮（useChatScroll）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U20 | useChatScroll.ts:onScroll 上滑 | setScroll(1000,800,100)（差 120px），onScroll() | `showJumpButton.value === true` | 正常 |
| U21 | useChatScroll.ts:onScroll 贴底 | setScroll(1000,800,200)（差 0），onScroll() | `showJumpButton.value === false` | 正常 |
| U22 | useChatScroll.ts:onScroll 滚轮回底清按钮 | 上滑(showJumpButton=true) → setScroll 回贴底 → onScroll() | showJumpButton=false（不只是点按钮才清，滚轮回底也清） | 正常 |
| U23 | useChatScroll.ts:点击后清按钮 | showJumpButton=true，scrollToBottom('smooth',true) | scrollTo 调用 + showJumpButton=false + stickToBottom=true | 正常 |
| U24 | useChatScroll.ts:上滑后回底再上滑（核心回归） | 贴底→上滑→点按钮回底→再上滑 | 按钮每次上滑都出现（不依赖新消息到达） | 正常 |
| U25 | useChatScroll.ts:阈值边界 | setScroll 差 41px → onScroll → showJumpButton=true；差 40px → onScroll → showJumpButton=false | 阈值边界与 stickToBottom 一致（互斥不变量：showJumpButton === !stickToBottom） | 边界 |
| U25b | useChatScroll.ts:切 session 重置按钮 | showJumpButton=true → 触发 session 切换的 scrollToBottom(force=true) | showJumpButton=false（切到新会话不该还显示"回到底部"） | 正常 |

### W4 — 滚动锚定（ResizeObserver）

> happy-dom 无 ResizeObserver，测试需在 beforeEach `global.ResizeObserver = mockClass`（构造返回带 observe/disconnect 的实例，回调可通过实例引用触发）。

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U26 | useChatScroll.ts:高度增长+贴底 | mock ResizeObserver，stickToBottom=true，触发高度变化回调 | scrollToBottom 被调用（内容增高自动跟随） | 正常 |
| U27 | useChatScroll.ts:高度增长+非贴底 | stickToBottom=false，触发高度变化 | scrollToBottom **不**被调用（不强制拉回，尊重用户上滑） | 正常 |
| U28 | useChatScroll.ts:异步 markdown 竞态 | stickToBottom=true → 高度变化回调入队 → 回调执行前 onScroll 置 stickToBottom=false → 回调执行 | 回调读当前 stickToBottom=false → 不滚（不拉回已上滑的用户） | 边界 |
| U29 | useChatScroll.ts:complete 折叠高度减小 | trace 折叠致高度减小，stickToBottom=true | 不触发 scrollTo（高度减小无需跟随）；视口不被拉偏 | 边界 |
| U30 | useChatScroll.ts:disconnect 清理（防泄漏） | mount composable → 触发 onUnmounted / 切 session | `observer.disconnect()` 被调用，无泄漏 | 正常 |
| U31 | MessageStream.vue:watch thinking/toolCalls 触发 | thinking 块新增（content.length 不变） | MessageStream 的滚动 watcher 触发（覆盖因素 2：thinking 不改 content 故旧 watcher 漏触发） | 正常 |

### 适配修改（现有测试）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U32 | use-chat-scroll.test.ts 适配 | 现有 U13-U17 测 stickToBottom/unreadBelow | 保留（unreadBelow 语义不变，仅新增 showJumpButton）；新增 U20-U25 互补 | 适配 |
| U33 | block-working.test.ts 回归 | 现有 Block working 态测试 | 仍全绿（Block.vue 不改，仅 Turn 遍历方式变） | 回归 |
| U34 | turn-working.test.ts 回归 | 现有 Turn working 态测试 | isWorking true→false 折叠逻辑仍工作（折叠只藏过程块，text 恒显） | 回归 |
| U35 | fg5-message-stream.test.ts 回归 | 现有 applyChunk 全分支测试 | 补充 contentBlocks 断言后全绿（mock fixture 可能需加 contentBlocks 字段） | 回归 |

## E2E 用例清单

> 项目已配 `@playwright/test`（package.json:27），E2E 命令 `npx playwright test`。但 `docs/testing/03-chat-flow.md:44` 标注 MessageStream/Turn/Block **均无 data-testid**，E2E 前需补 testid。Mock 模式（VITE_MOCK=true）可驱动流式回放（`mock/run-send-stream.ts` 产出 thinking→tool→text 序列）。
>
> **状态诚实声明**：当前 testid 缺失，下表 E1-E5 默认执行方式为 `[需手工]`（按 docs/testing/03-chat-flow.md mock 文案锚点 + 视觉检查）。若在实现期补齐 `scroll-to-bottom` 按钮和 `block-thinking 加 id 后缀、block-tool 加 id 后缀` testid，则 E1/E3 可转自动化。**不把缺 testid 的用例计入"自动化 E2E 覆盖"假象。**

| 用例ID | 场景 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|------|------|------|---------|
| E1 | 顺序：交错到达序渲染 | VITE_MOCK=true | 发送消息 → mock 流式回放（thinking→text→tool 序列）→ 等 complete | DOM 中 block 顺序与 mock 产出顺序一致（block-thinking 块在 block-text 之前，若 mock 先产 thinking） | 需手工（补 block testid 后可 `npx playwright test`）|
| E2 | 顺序：跨轮不跳变 | VITE_MOCK=true | mock 多轮（tool loop 迭代产生新 assistant）→ 观察首轮 text | 首轮 text 不因二轮 message_start 到达而从底部消失/跳入折叠区 | 需手工 |
| E3 | 按钮：上滑重现 | VITE_MOCK=true，消息已到底 | ① 点回到底部按钮 ② 手动上滑 200px | 按钮再次出现（核心 bug 回归断言） | 需手工（补 scroll-to-bottom testid 后可自动化）|
| E4 | 按钮：贴底不显示 | 消息在底部 | 视口贴底 | 按钮不可见 | 需手工 |
| E5 | 锚定：流式中保持贴底 | VITE_MOCK=true | 贴底 → 流式回放过程持续观察 scrollTop | 全程 scrollTop ≈ scrollHeight-clientHeight（距底 ≤8px），无可见上漂 | 需手工（轮询 scrollTop 断言）|

> 若补 testid 超出本次范围，E1-E5 降级为**手动验证**（按 docs/testing/03-chat-flow.md mock 文案锚点 + 视觉检查），并在测试报告中标注 `[需手工]`。建议至少补 `scroll-to-bottom` 按钮和 `block-thinking 加 id 后缀、block-tool 加 id 后缀` testid 以支撑 E1/E3 自动化。

## 覆盖率 gate

- gate 命令：`cd src-electron/renderer && npx vitest run --coverage`（vitest 原生 coverage，renderer/vitest.config.ts environment:happy-dom）。
- 增量算法：vitest 无原生 diff 过滤，用 `--coverage` 全量跑后人工核对改动文件的行覆盖率。重点文件阈值：
  - `chat-chunk-processor.ts` ≥ 85%（W1 核心，分支多）
  - `useChatScroll.ts` ≥ 80%（W3/W4 核心）
  - `Turn.vue` 新增遍历逻辑 ≥ 75%（渲染逻辑，happy-dom DOM 断言）
- 总体增量覆盖率 ≥ 60%（项目未设更高阈值，就高取 60%）。
- runtime 侧 message-converter.ts 改动（循环内 push text）：`cd src-electron/runtime && npx vitest run --coverage`，单文件 ≥ 80%。
- **E2E 诚实声明**：E1-E5 因 testid 缺失当前为手动验证，不计入自动化覆盖率统计。实现期若补齐 testid 则 E1/E3 转自动化，届时计入 E2E 覆盖。

## 实现步骤

1. [W1] 写 U1-U11d 失败测试（chunk-processor contentBlocks 填充 + message-converter 循环内 push）→ 实现 chunk-processor.ts 四个 case 补 push + message-converter.ts 循环内 push text → 测试通过 → 提交
2. [W3]（与 W1 并行）写 U20-U25 失败测试（useChatScroll showJumpButton）→ 实现 onScroll 上滑置 showJumpButton=true + MessageStream.vue 按钮改 v-if="showJumpButton" → 测试通过 → 提交
3. [W2] 写 U12-U19 失败测试（Turn 按 contentBlocks 渲染，**U14 折叠态 text 可见是核心**）→ 实现 Turn.vue 合并 trace+summary、text 恒显、按到达序遍历 + messageTurns.ts hasFoldable 适配 → 测试通过 → 跑 block-working/turn-working 回归（U33/U34）→ 提交
4. [W4] 写 U26-U31 失败测试（ResizeObserver，happy-dom mock ResizeObserver）→ 实现 useChatScroll ResizeObserver 高度监听 + disconnect 清理 + MessageStream.vue watcher 补 thinking/tool 块触发 → 测试通过 → 提交
5. [W5] 验收 Wave：跑全量单测 `cd src-electron/renderer && npx vitest run` + runtime `cd src-electron/runtime && npx vitest run` + 覆盖率 gate + E2E（补 testid 后 `npx playwright test`，或降级手动）→ 全绿才算完成
