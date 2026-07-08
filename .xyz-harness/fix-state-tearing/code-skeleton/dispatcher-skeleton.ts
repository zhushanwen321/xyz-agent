/**
 * code-skeleton: runtime message-dispatcher.ts + session-message-handler.ts —— 预检 + catch 分类（#4）
 *
 * 对应 packages/runtime/src/services/session/message-dispatcher.ts +
 * packages/runtime/src/transport/session-message-handler.ts 改动：
 * - sendPrompt 入口加 activeSession.isGenerating 预检（D-009）
 * - catch 路径一律 message.error（F6/D-014 决断：不分类，send.rejected 只走预检）
 * - sendMessage/sendSubagentMessage 返回类型扩展 { blocked, rejected? }
 * - session-message-handler rejected 消费分支
 *
 * 接线层级：
 * - adapter 真引 SDK：broker.broadcast（WS 推送）
 * - 模块内直调：svc.getSessionByClient（sessionService 现有能力）
 *
 * 骨架密度（Level 1）：预检分支 + catch 一律 message.error + 返回类型 + reply 分支真接线。
 */
// 内联类型声明（落地时用真实 import）
interface Broker {
  broadcast: (msg: { type: string; payload: Record<string, unknown> }) => void
}
interface PiSessionService {
  getSessionByClient: (clientId: string) => {
    isGenerating: boolean
    client: { prompt: (text: string) => Promise<void> }
  } | null
}

/** sendMessage 返回类型（扩展 rejected 字段） */
interface SendMessageResult {
  blocked: boolean
  /** true = 操作已被预检拦截并广播 send.rejected，调用方应 reply success（pending 干净 resolve） */
  rejected?: boolean
}

/**
 * sendPrompt（private，改造）—— 入口预检 + catch 一律 message.error。
 *
 * [D-009 预检] 入口检查 activeSession.isGenerating，忙则广播 send.rejected 不调 pi.prompt。
 * [F6/D-014 catch 决断] catch 路径一律 message.error（不分类）——D-009 禁字符串匹配 +
 *   无可靠结构化判据区分 pi 拒绝。send.rejected 只由预检触发。
 */
async function sendPrompt(
  svc: PiSessionService,
  broker: Broker,
  clientId: string,
  sessionId: string,
  text: string,
): Promise<SendMessageResult> {
  // [接线] 预检：runtime 侧 activeSession.isGenerating（sessionService 现有能力，非 renderer #2）
  const activeSession = svc.getSessionByClient(clientId)
  if (activeSession?.isGenerating) {
    // [D-009] 忙则广播 send.rejected（不调 pi.prompt）
    // [adapter] 真引 broker.broadcast
    broker.broadcast({
      type: 'send.rejected',
      payload: { sessionId, reason: 'busy', message: 'Agent 正在处理' },
    })
    // [可观测] M2：预检拦截日志落盘
    console.warn(`[dispatcher] preemptive reject (busy), sid=${sessionId}`)
    return { blocked: true, rejected: true }
  }

  try {
    // [adapter] 正常路径：调 pi.prompt
    await activeSession!.client.prompt(text)
    return { blocked: false }
  } catch (e) {
    // [F6/SV-4 决断] catch 路径一律走现行 message.error（流终止语义）。
    // 不尝试区分 pi already-processing vs 其他错误——D-009 禁止字符串匹配，
    // 且无可靠结构化判据。send.rejected 只由预检触发（runtime isGenerating=true 拦截），
    // catch 里所有 prompt 失败都走 message.error（安全降级，错误进对话流）。
    // NFR SV-4 的「所有 prompt 失败走 send.rejected」选项被显式排除（会误导用户为「Agent 正在处理」）。
    broker.broadcast({
      type: 'message.error',
      payload: { sessionId, message: e instanceof Error ? e.message : String(e) },
    })
    return { blocked: true }
  }
}

// [F6 决断] isPiAlreadyProcessing 不再需要——catch 一律 message.error，send.rejected 只走预检。
// 保留此注释作为决策记录，函数已删除。

// ── session-message-handler.ts rejected 消费分支 ──

/**
 * sendMessage 返回消费（改造）—— 加 rejected 分支。
 *
 * rejected:true → reply message.status{status:'rejected'}（pending 干净 resolve，
 *   拒绝经 send.rejected 广播传达，避免双 toast）。
 * blocked:true（无 rejected）→ sendError('message_blocked')（原逻辑保持）。
 */
function consumeSendMessageResult(
  result: SendMessageResult,
  reply: (type: string, payload: Record<string, unknown>) => void,
  sendError: (code: string) => void,
): void {
  if (result.rejected) {
    // [接线] rejected → reply success（send.rejected 已广播，pending 干净 resolve）
    reply('message.status', { status: 'rejected' })
    return
  }
  if (result.blocked) {
    // [接线] blocked（非 rejected）→ sendError（原逻辑）
    sendError('message_blocked')
    return
  }
  // 正常成功
  reply('message.status', { status: 'sent' })
}

// 验证：预检分支真接 broker.broadcast + return {blocked, rejected}（tsc 实证）
// 验证：catch 一律 message.error（无 isPiAlreadyProcessing 分流，D-014）
// 验证：consumeSendMessageResult 真接 reply/sendError 三分支
