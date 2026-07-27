/**
 * mock 流式回复序列 —— 从 mock/index.ts 抽出（降低 index.ts 行数，行为零改变）。
 *
 * 由 chat.send fire-and-forget 启动（不阻塞 ack）。index.ts 通过 deps 注入模块私有
 * 依赖（nextId/emit/sleep/pushSession/isCancelled/TIMING），splitChunks 与 CANNED_REPLY
 * 仅本函数使用，留在此文件作 local。
 *
 * 生命周期：message_start → [auto_retry] → thinking → tool_call → extension widget/status
 *           → text → file_changes → complete。
 * 全程检查 cancelled，abort 后提前返回。extension:widget/status 走 session 通道（pushSession），
 * 与 chat streamSubscribe（streamHandlers）独立，对称于 SideDrawer useSessionEvents.onMessage。
 */
import type { ServerMessage } from '@xyz-agent/shared'
import { guiResult, guiComponent } from '@xyz-agent/extension-protocol'

/** 流式时序（ms）—— 仅用于视觉演示节奏，不影响契约。index.ts 的 TIMING 实现此接口 */
export interface Timing {
  ack: number
  startGap: number
  chunk: number
  done: number
  switchCmd: number
  thinkingGap: number
  toolGap: number
  fileChangesGap: number
  retryGap: number
  steerDrain: number
}

/** index.ts 注入的模块私有依赖（行为与抽离前完全一致） */
export interface SendStreamDeps {
  nextId(prefix: string): string
  emit(sessionId: string, msg: ServerMessage): void
  sleep(ms: number): Promise<void>
  pushSession(sessionId: string, msg: ServerMessage): void
  isCancelled(sessionId: string): boolean
  TIMING: Timing
}

/** mock 固定回复前缀（不模拟失败，D7）—— 仅 runSendStream 使用 */
const CANNED_REPLY = '好的，我来处理这个请求。（mock 模拟回复）'

/**
 * E2E 场景分支专用保持时长（ms）—— 远大于 TIMING.toolGap(90ms)。
 *
 * 场景 1/2 的核心断言依赖「在 streaming 中间态断言 merged 卡」(toBeVisible 轮询 100ms 间隔)，
 * 默认 TIMING 的窗口（90-250ms）太短，轮询易错过 merged 卡的可见窗口导致 flaky。
 * E2E 分支是测试专用慢路径，确定性优先于真实时序，故用固定 2000ms 宽裕窗口。
 */
const SCENARIO_HOLD_MS = 2000

/** 按字符/词切分，证明逐块推送 —— 仅 runSendStream 使用 */
function splitChunks(text: string): string[] {
  return text.match(/[\u4e00-\u9fa5]|[A-Za-z]+|\s+|[^\sA-Za-z\u4e00-\u9fa5]/g) ?? [text]
}

export async function runSendStream(sessionId: string, text: string, deps: SendStreamDeps): Promise<void> {
  const { nextId, emit, sleep, pushSession, isCancelled, TIMING } = deps
  const messageId = nextId('m')
  const reply = `已处理："${text}"。\n${CANNED_REPLY}`

  emit(sessionId, {
    type: 'message.message_start',
    id: messageId,
    payload: { sessionId, messageId },
  })

  // ── E2E 专用分支：场景 1（并发 running tool 中途失败）/ 场景 2（连续 thinking 块）──
  // 关键字触发后短路默认序列（thinking/tool/text/file_changes），直接跑自定义流后 complete 返回。
  // 这些分支专供 chat-flow-merged.spec.ts 验证 streaming 边界行为，不污染默认路径。
  if (/test-fail-mid-stream/i.test(text)) {
    return emitFailMidStreamBranch(sessionId, { nextId, emit, sleep, isCancelled, TIMING })
  }
  if (/test-multi-thinking/i.test(text)) {
    return emitMultiThinkingBranch(sessionId, { nextId, emit, sleep, isCancelled, TIMING })
  }

  // FR-1：auto_retry 演示（关键词触发，让 RetryIndicator 渲染可验证）。
  // 默认不触发（不污染每条消息）；用户输入含 'retry' 时模拟一次瞬态失败→重试→恢复。
  if (/retry/i.test(text)) {
    if (isCancelled(sessionId)) return
    emit(sessionId, {
      type: 'message.auto_retry_start',
      payload: {
        sessionId,
        attempt: 1,
        maxAttempts: 3,
        delayMs: TIMING.retryGap,
        errorMessage: 'upstream 503 (mock)',
      },
    })
    await sleep(TIMING.retryGap)
    if (isCancelled(sessionId)) return
    emit(sessionId, { type: 'message.auto_retry_end', payload: { sessionId, success: true, attempt: 1 } })
  }

  // thinking 块（thinking_start → delta×N → end）
  if (isCancelled(sessionId)) return
  await sleep(TIMING.startGap)
  const thinkingId = nextId('th')
  emit(sessionId, {
    type: 'message.thinking_start',
    payload: { sessionId, thinkingId },
  })
  for (const chunk of splitChunks('让我分析一下这个请求……')) {
    if (isCancelled(sessionId)) return
    await sleep(TIMING.chunk)
    emit(sessionId, { type: 'message.thinking_delta', payload: { sessionId, delta: chunk } })
  }
  if (isCancelled(sessionId)) return
  emit(sessionId, { type: 'message.thinking_end', payload: { sessionId } })

  // tool_call 块 + extension widget 块：按用户输入 text 分支，让不同 E2E 场景各取所需序列。
  // 默认（read）：tool_call_start/update/end（card 嵌套 GUI）+ terminal widget + widgetGui × 2 + status
  //   → 覆盖 gui-components.spec.ts 的路径 A/B 验证（零回归）
  // 含 'todo'/'任务'：todo tool_call 序列（details.todos + __gui__ list-tree），不推 extension widget
  //   → 让 Tasks Drawer P0 Case 1 验证 5 项 + 三态 + VERIFY
  // 含 'goal'/'目标'：goal_control tool_call 序列（details.slug + __gui__ card）+ goal ANSI widget
  //   → 让 Tasks Drawer P0 Case 2/3 验证 GoalCard + objective 提取
  if (isCancelled(sessionId)) return
  await sleep(TIMING.toolGap)
  const branch = detectBranch(text)
  if (branch === 'todo') {
    await emitTodoBranch(sessionId, { nextId, emit, sleep, isCancelled, TIMING })
  } else if (branch === 'goal') {
    await emitGoalBranch(sessionId, { nextId, emit, sleep, pushSession, isCancelled, TIMING })
  } else {
    await emitReadBranch(sessionId, { nextId, emit, sleep, pushSession, isCancelled, TIMING })
  }

  // 文本流式
  for (const chunk of splitChunks(reply)) {
    if (isCancelled(sessionId)) return
    await sleep(TIMING.chunk)
    emit(sessionId, {
      type: 'message.text_delta',
      id: messageId,
      payload: { sessionId, messageId, delta: chunk },
    })
  }

  // file_changes（accumulating → ready），证明 ChangeSetCard/FileView 渲染。
  // ADR-0024 D5 重构：baseline diff，isFullSet 恒 true（每次 diff 都是全量结果，全集替换不增量合并）。
  // 任务4：ready 帧加 unmerged 样本，让 FileView U 标注在 mock 下可验。
  if (isCancelled(sessionId)) return
  await sleep(TIMING.fileChangesGap)
  emit(sessionId, {
    type: 'message.file_changes',
    payload: {
      sessionId,
      messageId,
      fileChanges: [
        { filePath: 'src/mock-feature.ts', status: 'modified', addLines: 10, delLines: 2 },
      ],
      changeSetStatus: 'accumulating',
      isFullSet: true,
    },
  })
  await sleep(TIMING.fileChangesGap)
  if (isCancelled(sessionId)) return
  emit(sessionId, {
    type: 'message.file_changes',
    payload: {
      sessionId,
      messageId,
      fileChanges: [
        { filePath: 'src/mock-feature.ts', status: 'modified', addLines: 10, delLines: 2 },
        { filePath: 'src/new-file.ts', status: 'added', addLines: 24 },
        { filePath: 'src/merge-conflict.ts', status: 'unmerged', addLines: 5, delLines: 3 },
      ],
      changeSetStatus: 'ready',
      isFullSet: true,
    },
  })

  // Extension UI 交互请求（extension.ui_request）：pi extension 调 ctx.ui.select/confirm/input 时，
  // runtime 经 event-adapter 翻译后推此帧。useExtensionUI composable 经 events.on(sessionId) 订阅，
  // mock 走 pushSession(dispatchSession) 同构透传，让 ExtensionUIDialog 在 mock 下可验证。
  // 仅关键词触发（不污染所有消息，避免 modal 弹窗挡住后续 E2E 交互——如 ST-1 的 complete 后输入）。
  // 用 'ui-select' 哨兵词 + '部署' 中文，避免 /select/i 匹配自然语言中含 "select" 的普通输入。
  if (/ui[-_ ]?select|部署/i.test(text)) {
    if (isCancelled(sessionId)) return
    await sleep(TIMING.done)
    pushSession(sessionId, {
      type: 'extension.ui_request',
      id: nextId('uir'),
      payload: {
        sessionId,
        requestId: `mock-ui-${Date.now()}`,
        method: 'select',
        title: 'Mock: 选择部署目标',
        message: '选择部署环境',
        options: ['生产环境', '预发环境', '测试环境'],
      },
    })
  }

  // complete（含 usage，证明 W05-A usage 回填）
  if (isCancelled(sessionId)) return
  await sleep(TIMING.done)
  emit(sessionId, {
    type: 'message.complete',
    id: messageId,
    payload: {
      sessionId,
      messageId,
      stopReason: 'complete',
      usage: { inputTokens: 1280, outputTokens: 642, totalTokens: 1922 },
    },
  })
}

// ── tool_call + widget 分支：按用户输入分发不同序列 ──────────────────────────

type BranchDeps = Pick<SendStreamDeps, 'nextId' | 'emit' | 'sleep' | 'isCancelled' | 'TIMING'>
type BranchDepsWithPush = BranchDeps & Pick<SendStreamDeps, 'pushSession'>

/** 按 text 关键词判分支：todo / goal / 默认（read） */
function detectBranch(text: string): 'todo' | 'goal' | 'read' {
  const lower = text.toLowerCase()
  if (/\btodo\b|任务/.test(lower)) return 'todo'
  if (/\bgoal\b|目标/.test(lower)) return 'goal'
  return 'read'
}

/**
 * 默认分支（read tool + extension widget × 3 + status）。
 * 行为与重构前完全一致（gui-components.spec.ts 路径 A/B 零回归）。
 */
async function emitReadBranch(sessionId: string, deps: BranchDepsWithPush): Promise<void> {
  const { nextId, emit, sleep, pushSession, isCancelled, TIMING } = deps
  const toolCallId = nextId('tc')
  emit(sessionId, {
    type: 'message.tool_call_start',
    payload: { sessionId, toolCallId, toolName: 'read', input: { path: '/mock/file.ts' } },
  })
  await sleep(TIMING.toolGap)
  if (isCancelled(sessionId)) return
  emit(sessionId, {
    type: 'message.tool_call_update',
    payload: { sessionId, toolCallId, detail: '读取 42 行' },
  })
  await sleep(TIMING.toolGap)
  if (isCancelled(sessionId)) return
  emit(sessionId, {
    type: 'message.tool_call_end',
    payload: {
      sessionId,
      toolCallId,
      output: '…文件内容（mock）…',
      outputRaw: '\x1b[32mSuccess\x1b[0m: operation completed',
      status: 'completed',
      // 路径 B：details.__gui__ 让 Block.vue extractGui 提取并路由到 GuiComponentRenderer。
      // 用 card 嵌套 progress-bar + stats-line，一次覆盖递归嵌套 + 3 种 type 的 E2E 验证。
      details: {
        __gui__: guiResult(guiComponent('card', {
          variant: 'elevated',
          header: 'CI Pipeline',
          body: [
            guiComponent('progress-bar', { label: 'build', current: 7, total: 8, severity: 'ok' }),
            guiComponent('stats-line', { items: [
              { label: 'turns', value: '15' },
              { label: 'tokens', value: '2.1k' },
            ] }),
          ],
        })),
      },
    },
  })

  // 任务3：extension widget + status 推送（走 session 通道，对齐 SideDrawer useSessionEvents.onMessage）。
  // 在 tool_call 后推，模拟扩展输出（terminal widget 行 + 状态栏文本），让 SideDrawer 在 mock 下可验。
  if (isCancelled(sessionId)) return
  await sleep(TIMING.toolGap)
  pushSession(sessionId, {
    type: 'extension:widget',
    id: nextId('w'),
    payload: {
      sessionId,
      widgetKey: 'terminal',
      lines: ['$ npm run build', '✓ built in 1.42s', '（mock widget 输出）'],
    },
  })
  // 结构化 GUI widget（extension:widgetGui）：解包后的 GuiComponent 形状（{ type, props }），
  // 对齐 event-adapter 解码 NUL marker 后发出的 gui（非 GuiRenderResult 的 { v, component } 包装）。
  // 让 SideDrawer / GuiComponentRenderer 在 mock 下可验证 GUI widget 渲染。
  pushSession(sessionId, {
    type: 'extension:widgetGui',
    id: nextId('wg'),
    payload: {
      sessionId,
      widgetKey: 'gui-demo',
      gui: {
        type: 'stats-line',
        props: {
          items: [
            { value: '3', label: 'turns' },
            { value: '2.1k', label: 'tokens' },
            { value: '4.5s', label: 'duration' },
          ],
        },
      },
    },
  })
  // 第二个 GUI widget：list-tree，widgetKey 含 'browser' → 落到 SideDrawer browser tab，
  // 与 terminal tab 的 stats-line 互不覆盖。让 E2E 可切 tab 验证不同 type 渲染。
  pushSession(sessionId, {
    type: 'extension:widgetGui',
    id: nextId('wg2'),
    payload: {
      sessionId,
      widgetKey: 'gui-browser-demo',
      gui: {
        type: 'list-tree',
        props: {
          items: [
            { label: 'Deploy', icon: 'arrow', children: [
              { label: 'VPC', status: 'done' },
              { label: 'RDS', status: 'running' },
              { label: 'Redis', status: 'failed' },
            ] },
          ],
        },
      },
    },
  })
  pushSession(sessionId, {
    type: 'extension:status',
    id: nextId('ws'),
    payload: {
      sessionId,
      statusKey: 'mock-status',
      text: 'Mock: Running',
      textRaw: '\x1b[32m● Mock: Running\x1b[0m',
    },
  })
}

/**
 * todo 分支：todo tool_call_start + tool_call_end（details.todos 原始数组 + __gui__ list-tree）。
 * chat-message-effects.routeToolResultToTasks 消费这两段，写入 tasks store 的 todos/todo/todoDone/todoTotal。
 * 不推 extension widget（todo 不走 widget 通道，TasksPanel 直读 store）。
 */
async function emitTodoBranch(sessionId: string, deps: BranchDeps): Promise<void> {
  const { nextId, emit, sleep, isCancelled, TIMING } = deps
  const toolCallId = nextId('tc')
  emit(sessionId, {
    type: 'message.tool_call_start',
    payload: {
      sessionId,
      toolCallId,
      toolName: 'todo',
      input: {
        action: 'add',
        texts: [
          '复现 token 过期场景',
          '定位 refreshToken 循环点',
          '添加 maxRetry 守卫',
          '编写单元测试覆盖边界',
          '更新 auth 模块文档',
        ],
      },
    },
  })
  await sleep(TIMING.toolGap)
  if (isCancelled(sessionId)) return
  // 5 项任务，覆盖三态 + 2 个 isVerification（#3 #4）
  // 对齐 chat-message-effects.isTodoItem 类型守卫：id:number / text:string / status 枚举
  const todos = [
    { id: 1, text: '复现 token 过期场景', status: 'completed' as const },
    { id: 2, text: '定位 refreshToken 循环点', status: 'completed' as const },
    { id: 3, text: '添加 maxRetry 守卫', status: 'completed' as const, isVerification: true },
    { id: 4, text: '编写单元测试覆盖边界', status: 'in_progress' as const, isVerification: true },
    { id: 5, text: '更新 auth 模块文档', status: 'pending' as const },
  ]
  emit(sessionId, {
    type: 'message.tool_call_end',
    payload: {
      sessionId,
      toolCallId,
      toolName: 'todo',
      status: 'completed',
      // routeToolResultToTasks 读 details.todos（含 isVerification）+ details.__gui__.component（list-tree）
      details: {
        action: 'add',
        nextId: 6,
        todos,
        // list-tree 对齐 todo extension buildGui 映射：completed→done, in_progress→running, pending→无 status
        __gui__: guiResult(guiComponent('list-tree', { items: [
          { icon: 'check', label: '#1: 复现 token 过期场景', status: 'done', depth: 0 },
          { icon: 'check', label: '#2: 定位 refreshToken 循环点', status: 'done', depth: 0 },
          { icon: 'check', label: '#3: 添加 maxRetry 守卫', status: 'done', depth: 0 },
          { icon: 'circle', label: '#4: 编写单元测试覆盖边界', status: 'running', depth: 0 },
          { icon: 'dot', label: '#5: 更新 auth 模块文档', depth: 0 },
        ] })),
      },
    },
  })
}

/**
 * goal 分支：goal_control tool_call_start（input.objective/slug，routeToolStartToTasks 提 objective）
 * + tool_call_end（details.slug + __gui__ card，routeToolResultToTasks 写 goal.gui/slug）
 * + goal ANSI widget（extension:widget widgetKey='goal'，SideDrawer 解析后 merge 实时字段）。
 */
async function emitGoalBranch(sessionId: string, deps: BranchDepsWithPush): Promise<void> {
  const { nextId, emit, sleep, pushSession, isCancelled, TIMING } = deps
  const toolCallId = nextId('tc')
  // tool_call_start：input.objective 是 Case 3 断言的目标文本
  emit(sessionId, {
    type: 'message.tool_call_start',
    payload: {
      sessionId,
      toolCallId,
      toolName: 'goal_control',
      input: {
        action: 'create',
        objective: '修复登录模块 token 过期无限重定向问题',
        slug: 'fix-auth-bug',
      },
    },
  })
  await sleep(TIMING.toolGap)
  if (isCancelled(sessionId)) return
  emit(sessionId, {
    type: 'message.tool_call_end',
    payload: {
      sessionId,
      toolCallId,
      toolName: 'goal_control',
      status: 'completed',
      // routeToolResultToTasks 读 details.slug + details.__gui__.component（card）
      details: {
        action: 'create',
        goalId: 'g-mock',
        status: 'active',
        slug: 'fix-auth-bug',
        // GoalCard 遍历 card body 找 progress-bar，severity 控制填充色（warn→warning）
        // 不传 unit：value 显示 '71/200'（避免 '71000k/200000k' 的单位错配）
        __gui__: guiResult(guiComponent('card', {
          variant: 'default',
          header: 'fix-auth-bug',
          body: [
            guiComponent('progress-bar', { label: 'tokens', current: 71, total: 200, severity: 'warn' }),
            guiComponent('progress-bar', { label: 'time', current: 720, total: 1800, severity: 'ok' }),
            guiComponent('stats-line', { items: [
              { label: 'status', value: 'active', severity: 'ok' },
              { label: 'turn', value: '3' },
            ] }),
          ],
        })),
      },
    },
  })

  // goal ANSI widget：走 session 通道，widgetKey='goal'。
  // SideDrawer.onMessage('extension:widget') 识别 widgetKey==='goal'，调 tasksStore.mergeGoalWidget 解析实时字段。
  // header 行格式对齐 parseGoalWidget：`◆ <slug> Turn N | NN% tokens | NN% time`
  if (isCancelled(sessionId)) return
  await sleep(TIMING.toolGap)
  pushSession(sessionId, {
    type: 'extension:widget',
    id: nextId('gw'),
    payload: {
      sessionId,
      widgetKey: 'goal',
      lines: [
        '\x1b[36m◆ fix-auth-bug\x1b[0m\x1b[90m Turn 3\x1b[0m\x1b[33m | 36% tokens\x1b[0m\x1b[33m | 40% time\x1b[0m',
      ],
    },
  })
}

/**
 * 场景 1 分支（fail-mid-stream）：并发 2 个 running tool，A 完成、B 失败。
 *
 * 关键设计：两个 tool_call_start 连发（A 和 B 同时进入 running），构造 mergeConsecutiveBlocks
 * 合并窗口（连续 2 个 running tool 合并成 merged 卡）。随后 A→completed、B→error，触发
 * merged→single 重排（v-for key 从 merged-tool 变 single-tool，MergedBlockCard 卸载重挂）。
 *
 * 流序列：
 *   message_start → thinking → toolA start → toolB start（A B 同时 running = 合并窗口）
 *   → [toolGap 给测试断言 merged 卡 + 手动展开]
 *   → toolA end(completed) → toolB end(error, isError)  ← 触发 merged 卡重排
 *   → textDelta → complete
 *
 * 顺序流（A 完成→B 启动）测不出合并边界 bug，故必须并发 running。
 */
async function emitFailMidStreamBranch(sessionId: string, deps: BranchDeps): Promise<void> {
  const { nextId, emit, sleep, isCancelled, TIMING } = deps
  const messageId = nextId('m')

  // thinking 块（单段，证明流式开始）
  await sleep(TIMING.startGap)
  if (isCancelled(sessionId)) return
  const thinkingId = nextId('th')
  emit(sessionId, { type: 'message.thinking_start', payload: { sessionId, thinkingId } })
  for (const chunk of splitChunks('正在读取文件……')) {
    if (isCancelled(sessionId)) return
    await sleep(TIMING.chunk)
    emit(sessionId, { type: 'message.thinking_delta', payload: { sessionId, delta: chunk } })
  }
  emit(sessionId, { type: 'message.thinking_end', payload: { sessionId } })

  // tool A: read_file（running，不发 end）—— 进入 running 态
  await sleep(TIMING.toolGap)
  if (isCancelled(sessionId)) return
  const toolAId = nextId('tc')
  emit(sessionId, {
    type: 'message.tool_call_start',
    payload: { sessionId, toolCallId: toolAId, toolName: 'read_file', input: { path: 'A.txt' } },
  })

  // tool B: read_file（running，紧跟 A 后立即发）—— A B 同时 running，构造 merged 合并窗口
  // 关键：B 不等 A 完成。两个 tool 都处于 running 时 mergeConsecutiveBlocks 合并成 merged 卡。
  await sleep(TIMING.chunk)
  if (isCancelled(sessionId)) return
  const toolBId = nextId('tc')
  emit(sessionId, {
    type: 'message.tool_call_start',
    payload: { sessionId, toolCallId: toolBId, toolName: 'read_file', input: { path: 'B.txt' } },
  })

  // 留宽裕时间让测试断言 merged 卡出现 + 手动展开/收起交互。
  // 用 SCENARIO_HOLD_MS（远大于 TIMING.toolGap）而非默认 toolGap：默认 90ms 窗口太短，
  // 测试 toBeVisible 轮询（100ms 间隔）易错过 merged 卡（A B 同时 running 到 B 失败的窗口仅约 250ms）。
  // 测试分支可慢，确定性优先于真实时序。
  await sleep(SCENARIO_HOLD_MS)
  if (isCancelled(sessionId)) return

  // tool A end: completed —— A 完成，但 B 仍 running，此时两块仍属连续 tool（一 completed 一 running），
  // mergeBlocks 不拆（仅 failed/unfinished 断开合并），merged 卡仍存在
  emit(sessionId, {
    type: 'message.tool_call_end',
    payload: {
      sessionId,
      toolCallId: toolAId,
      toolName: 'read_file',
      output: 'content A',
      status: 'completed',
    },
  })

  await sleep(TIMING.toolGap)
  if (isCancelled(sessionId)) return
  // tool B end: error —— B 失败，isFailedTool=true 断开合并链，merged 卡卸载重排为两个 single 块
  // 这是触发场景 1 核心 bug 的时刻（MergedBlockCard expanded ref 随卸载丢失）
  emit(sessionId, {
    type: 'message.tool_call_end',
    payload: {
      sessionId,
      toolCallId: toolBId,
      toolName: 'read_file',
      output: 'File not found',
      status: 'error',
      error: 'File not found',
    },
  })

  // 文本流式（证明流继续）
  for (const chunk of splitChunks('读取完成。')) {
    if (isCancelled(sessionId)) return
    await sleep(TIMING.chunk)
    emit(sessionId, {
      type: 'message.text_delta',
      id: messageId,
      payload: { sessionId, messageId, delta: chunk },
    })
  }

  // complete（含 usage，对齐全局 complete 帧结构）
  if (isCancelled(sessionId)) return
  await sleep(TIMING.done)
  emit(sessionId, {
    type: 'message.complete',
    id: messageId,
    payload: {
      sessionId,
      messageId,
      stopReason: 'complete',
      usage: { inputTokens: 1280, outputTokens: 642, totalTokens: 1922 },
    },
  })
}

/**
 * 场景 2 分支（multi-thinking）：3 个连续 thinking 块逐个到达。
 *
 * 关键设计：第 1 块以 single 显，第 2 块到达触发 single→merged 重排（merged 卡首次 mount），
 * 第 3 块加入已有 merged 卡（只 update items，不重 mount）。
 *
 * 量化判定（场景 2 核心断言）：merged 卡 mount 次数应 = 1。
 *   - mount 次数 === 1：第 2 块触发 merged 卡创建，第 3 块只 update → 无闪烁（无 bug）
 *   - mount 次数 > 1：每加一块 merged 卡都重挂 → 闪烁 bug（v-for key 含 blk.kind 变化）
 *
 * 流序列（每个 thinking 块：thinking_start → delta×N → thinking_end，间隔 toolGap 构造边界）：
 *   message_start → [th1: start→delta→end] → [th2: start→delta→end] → [th3: start→delta→end] → complete
 *
 * 无 tool/text/file_changes（纯 thinking 边界验证，排除其他块干扰 mount 计数）。
 */
async function emitMultiThinkingBranch(sessionId: string, deps: BranchDeps): Promise<void> {
  const { nextId, emit, sleep, isCancelled, TIMING } = deps
  const messageId = nextId('m')
  const thoughts = ['分析需求……', '设计方案……', '实现代码……']

  await sleep(TIMING.startGap)
  for (const thought of thoughts) {
    if (isCancelled(sessionId)) return
    const thinkingId = nextId('th')
    emit(sessionId, { type: 'message.thinking_start', payload: { sessionId, thinkingId } })
    for (const chunk of splitChunks(thought)) {
      if (isCancelled(sessionId)) return
      await sleep(TIMING.chunk)
      emit(sessionId, { type: 'message.thinking_delta', payload: { sessionId, delta: chunk } })
    }
    emit(sessionId, { type: 'message.thinking_end', payload: { sessionId } })
    // 块间间隔（让 mergeConsecutiveBlocks 重算 + Vue 渲染，构造 single→merged 边界）
    await sleep(TIMING.toolGap)
  }

  // complete
  if (isCancelled(sessionId)) return
  await sleep(TIMING.done)
  emit(sessionId, {
    type: 'message.complete',
    id: messageId,
    payload: {
      sessionId,
      messageId,
      stopReason: 'complete',
      usage: { inputTokens: 1280, outputTokens: 642, totalTokens: 1922 },
    },
  })
}
