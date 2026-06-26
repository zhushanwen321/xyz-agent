/**
 * mock 流式回复序列 —— 从 mock/index.ts 抽出（降低 index.ts 行数，行为零改变）。
 *
 * 由 chat.send fire-and-forget 启动（不阻塞 ack）。index.ts 通过 deps 注入模块私有
 * 依赖（nextId/emit/sleep/pushSession/isCancelled/TIMING），splitChunks 与 CANNED_REPLY
 * 仅本函数使用，留在此文件作 local。
 *
 * 生命周期：message_start → [auto_retry] → thinking → tool_call → extension widget/status
 *           → text → file_changes → system 提示行（bashExecution）→ complete。
 * 全程检查 cancelled，abort 后提前返回。extension:widget/status 走 session 通道（pushSession），
 * 与 chat streamSubscribe（streamHandlers）独立，对称于 real extension.onWidget/onStatus。
 */
import type { ServerMessage } from '@xyz-agent/shared'

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

  // tool_call 块（start → update → end），证明 tool 卡渲染 + 进度更新
  if (isCancelled(sessionId)) return
  await sleep(TIMING.toolGap)
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
    payload: { sessionId, toolCallId, output: '…文件内容（mock）…', status: 'completed' },
  })

  // 任务3：extension widget + status 推送（走 session 通道，对齐 real extension.onWidget/onStatus）。
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
  pushSession(sessionId, {
    type: 'extension:status',
    id: nextId('ws'),
    payload: { sessionId, statusKey: 'build', text: '构建完成（mock）' },
  })

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

  // file_changes（accumulating → ready），证明 ChangeSetCard/FileView 渲染 + 跨帧合并。
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
      isFullSet: false,
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

  // 任务2：SystemNotice 推送（bashExecution system 提示行）。
  // 不推 compactionSummary（刻意设计，见 compact 注释）。bashExecution 代表流转中的元信息提示，
  // 让 SystemNotice.vue 在 mock 下可验。走 stream 通道（streamHandlers），由 chat-chunk-processor 消费。
  if (isCancelled(sessionId)) return
  await sleep(TIMING.done)
  emit(sessionId, {
    type: 'message.bashExecution',
    id: nextId('b'),
    payload: {
      sessionId,
      command: 'npm run build',
      exitCode: 0,
      timestamp: Date.now(),
    },
  })

  // complete（含 usage，证明 W05-A usage 回填）
  if (isCancelled(sessionId)) return
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
