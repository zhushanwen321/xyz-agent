/**
 * useChat —— chat 业务编排（R2 features 层，唯一跨 api + stores 的层）。
 *
 * 数据流链（plan-frontend §3 UC-2）：
 *   Composer → useChat.send → store.appendUser + api.chat.send
 *            → api.transport.send(ws) → mock 回流 ServerMessage
 *            → api.events.streamSubscribe → store.applyMessageEvent（message.* 单一入口）
 *            → MessageStream 响应式渲染 + useChatScroll.scrollToBottom
 *
 * hydrate：首次进入 session 调 api.chat.getHistory 注入历史 fixture（含 tool_call/summary），
 * 让 UC-2 切换会话可见块类型丰富度（G2-006）。
 *
 * abort：调 api.chat.abort（方法存在，中断流转 DEFERRED G-025）。
 */
import { computed, reactive, ref } from 'vue'
import { chat as chatApi } from '@/api'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import i18n from '@/i18n'
import type { Message, Segment } from '@xyz-agent/shared'
import { IMAGE_LIMITS, segmentsToPrompt } from '@xyz-agent/shared'
import { fileBytesToBase64 } from '@/composables/panel/useImageAttachment'
import { resolveSupportsVision } from '@/composables/panel/useModelCapabilities'

const t = i18n.global.t

/** message.send images 形状（对齐 shared protocol.ts:199，base64 不含 data: 前缀）。 */
type SendImage = { data: string; mimeType: string }

/**
 * 从 segments 提取 image 段，并行读 local-file 文件转 base64，组装 message.send images。
 *
 * [feature:add-file-picture-attach slice6] 发送闭环：composer 的 image segment 在 send 时
 * 读文件转 base64 填入 message.send images 字段。image 段的 path 是 write-session-image
 * 落到 <getDataDir>/attachments/<sessionId>/ 的绝对路径（landing 态或拖拽/+菜单图片项可能是
 * tmpdir / 用户磁盘原 path），均在 local-file 协议白名单内（main.ts allowedPrefixes 含
 * attachments/tmpdir/cwd/用户子目录）。
 *
 * 降级矩阵（C2 契约）：
 * - 无 image 段 → 返回 undefined（不传 images 键，行为不变）
 * - fetch 读失败（web/mock 无 protocol.handle / 文件删 / 白名单 403）→ Promise.allSettled
 *   收集，rejected 项 console.warn 后跳过，不 throw 不阻断发送（AGENTS.md L411 allSettled 硬规则）
 * - 全部失败 → 返回 undefined（退化为纯文本发送，文本 prompt 的 [图片:name] 占位仍发）
 *
 * base64 经 fileBytesToBase64（分块 btoa 防 stack 溢出），mimeType 取 blob.type 缺省 image/png。
 *
 * 导出供单测 mock fetch 验证（纯模块函数，不依赖 this）。
 */
export async function extractImages(
  segments: Segment[],
): Promise<SendImage[] | undefined> {
  const imageSegs = segments.filter((s): s is Extract<Segment, { type: 'image' }> => s.type === 'image')
  if (imageSegs.length === 0) return undefined

  const results = await Promise.allSettled(
    imageSegs.map(async (seg) => {
      // local-file:// 协议由 main.ts:172 protocol.handle 注册（DetailPane 图片渲染既用同一路径）。
      // encodeURIComponent 防 path 含特殊字符破坏 URL 解码（main.ts:173 decodeURIComponent 对称）。
      const res = await fetch(`local-file:///${encodeURIComponent(seg.path)}`)
      if (!res.ok) throw new Error(`local-file ${seg.path} ${res.status}`)
      const blob = await res.blob()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return {
        data: fileBytesToBase64(bytes),
        mimeType: blob.type || 'image/png',
      } satisfies SendImage
    }),
  )

  const images: SendImage[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled') {
      images.push(r.value)
    } else {
      // 读失败的图跳过（不阻断发送）；文本 prompt 的 [图片:name] 占位仍发，LLM 知道用户贴了图。
      console.warn(`[useChat] image 读取失败，已跳过: ${imageSegs[i].path}`, r.reason)
    }
  }
  return images.length > 0 ? images : undefined
}

/**
 * 估算会话历史累积图片字节数（P2-c 层 2/3 阈值判断）。
 *
 * 遍历历史 messages 中 user message 的 image segment，fetchSize 注入并行拿字节数累加。
 * 失败计入 failed 不 throw（ERR4：单个 fetch 失败不阻断估算，totalBytes 基于 partial）。
 *
 * fetchSize 注入签名 (path: string) => Promise<number>，生产实现用 fetch local-file://
 * 拿 blob.size，测试 mock 直接返数字。
 *
 * 导出供单测 mock（纯模块函数，不依赖 this）。
 */
export async function estimateAccumulatedImageBytes(
  messages: Message[],
  fetchSize: (path: string) => Promise<number>,
): Promise<{ totalBytes: number; counted: number; failed: number }> {
  const imagePaths: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    const segments = Array.isArray(msg.content) ? msg.content : []
    for (const seg of segments) {
      if (seg.type === 'image') {
        imagePaths.push(seg.path)
      }
    }
  }
  if (imagePaths.length === 0) return { totalBytes: 0, counted: 0, failed: 0 }

  const results = await Promise.allSettled(imagePaths.map((p) => fetchSize(p)))
  let totalBytes = 0
  let counted = 0
  let failed = 0
  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalBytes += r.value
      counted++
    } else {
      failed++
    }
  }
  return { totalBytes, counted, failed }
}

/**
 * 会话级流式订阅表（sessionId → 取消函数）。
 *
 * [HISTORICAL] 为什么不能 per-send 订阅：
 *   原 send() 在 `await chatApi.send()` resolve 后于 finally 里 unsub。但服务端 message.send
 *   在 pi ack（prompt 已接收，非生成完成）即回 message.status{sent}，rpc-client.prompt()
 *   明确「resolves when pi acknowledges receipt (not when generation completes)」。
 *   故 finally 在首个 chunk 到达前就拆订阅 → 流式事件全丢。
 *   改为会话级长订阅：首次 send 时订阅一次，由 message_start/complete/error 驱动 streaming 状态，
 *   不在 ack 时拆订阅。
 */
const streamSubscriptions = new Map<string, () => void>()

/**
 * W4/N1：记录哪些 session 的历史被尾读截断了（有更早的 turn 可加载）。
 * MessageStream 据此显隐「加载更多历史」按钮。hydrate 时设置。
 * 用 ref<Set> 保证响应式（MessageStream 的 computed showLoadMore 能自动更新）。
 */
const historyTruncatedSessions = ref<Set<string>>(new Set())

/**
 * 重置 useChat 模块级状态（测试隔离用）。
 *
 * useChat() 是 composable 工厂但把会话级状态（streamSubscriptions Map、
 * historyTruncatedSessions Set）放在模块顶层，跨 useChat() 调用共享
 * （Composer/Panel/Sidebar/useNewTaskFlow 共用同一份）。测试间不 reset
 * 会泄漏到下一用例：streamSubscriptions 残留 + historyTruncatedSessions
 * 永久 true。测试需在 beforeEach 调用本函数重置。
 *
 * 生产代码无需调用（session 切换/删除时各自清理：disposeSession 取消订阅，
 * loadMoreHistory 清截断标记）。
 */
export function resetChatModuleState(): void {
  // 清空 stream 订阅：逐个调 unsub（解除 WS 订阅）+ 清空 Map
  for (const [, unsub] of streamSubscriptions) {
    try {
      unsub()
    // eslint-disable-next-line taste/no-silent-catch -- 测试隔离用：unsub 失败不应阻断其余订阅清理，仅记录便于诊断
    } catch (e) {
      console.warn('[useChat] stream unsub failed:', e)
    }
  }
  streamSubscriptions.clear()
  // 重置 history 截断标记
  historyTruncatedSessions.value = new Set()
}

/**
 * 确保指定 session 已订阅流式事件（幂等：已订阅则 no-op）。
 *
 * 导出供 forkSessionAsk 复用：fork-to-ask 发送的首条消息需要与正常 send 同样的
 * 订阅建立（否则 pi 生成的流式回复被 events.dispatchSession 静默丢弃——无订阅者）。
 * forkSessionAsk 不走 useChat().send：send 内部 try/catch 吞错（仅 toast）会阻断
 * fork 占位 session 的回滚，且其 busy→steer 路由对新 fork session 不适用。
 */
export function ensureStreamSubscription(
  sid: string,
  chat: ReturnType<typeof useChatStore>,
  sessionStore: ReturnType<typeof useSessionStore>,
): void {
  if (streamSubscriptions.has(sid)) return
  const unsub = chatApi.streamSubscribe(sid, (msg) => {
    // [send.rejected] 防御性反馈通道（D-006 独立类型，不进对话流）
    if (msg.type === 'send.rejected') {
      const payload = msg.payload as { sessionId: string; reason: string; message: string }
      chat.clearPendingSend(sid)
      const { error } = useToast()
      error(payload.message ?? t('composable.agentProcessing'))
      return
    }
    // message.* → 单一入口（F2 重构：消除 double-dispatch）。
    // applyMessageEvent 内部经 effect 注册表执行该 type 的全部副作用（chunk 状态更新
    // + finalizeSession 收口），useChat 不再自己 switch message.*。message.* 处理完即 return，
    // 下方 session.* 分支仅处理跨 store 事件（compacting/renamed 等）。
    if (msg.type.startsWith('message.')) {
      chat.applyMessageEvent(sid, msg)
      return
    }
    // session.* → 跨 store 协调（sessionStore.updateLabel/updateSessionState/setCompacting），
    // 保留在 useChat（stores 间禁止互相 import）。
    switch (msg.type) {
      case 'session.compacting':
        // #6：compact 生命周期开始（runtime server-push，走 session 通道）
        chat.setCompacting(sid, true)
        break
      case 'session.compacted':
        // #6：compact 生命周期结束（成功/失败均广播）。错误反馈走 compact() 的 catch，此处仅复位态。
        chat.setCompacting(sid, false)
        break
      case 'session.renamed': {
        // pi 改写 session 名（session_info_changed → session.renamed，见 event-adapter.ts）。
        // guard：payload.name 为空时跳过 —— 防 pi 推空名/旧名覆盖用户手动 rename 的值。
        // 用闭包 sid（对称 compacting/compacted handler）：session.* 走 session 级通道
        // (events.on(sid, ...))，payload.sessionId 恒等于订阅 sid，不信任 payload 可能的篡改。
        const payload = msg.payload as { name?: string }
        if (payload.name) {
          sessionStore.updateLabel(sid, payload.name)
        }
        break
      }
      case 'session.state_changed': {
        // 模型切换后 runtime 推送（model-service switchModel 末尾广播，含新 modelId/thinkingLevel
        // + 按新 contextWindow 重算的用量）。局部更新 session 状态，不触发整表 setGroups。
        // thinkingLevel optional：未设置时（undefined）不更新，保留旧值。
        const p = msg.payload as { sessionId?: string; modelId?: string; thinkingLevel?: string }
        if (p.sessionId) {
          sessionStore.updateSessionState(p.sessionId, {
            ...(p.modelId !== undefined && { modelId: p.modelId }),
            ...(p.thinkingLevel !== undefined && { thinkingLevel: p.thinkingLevel }),
          })
        }
        break
      }
      case 'session.thinkingLevelSet': {
        // pi 切模型 / 用户手切档位后推 thinking_level_changed（runtime event-adapter 转为此类型）。
        // 补 state_changed 的时序缺口：switchModel 的 broadcastSessionState 在 set_model RPC resolve 后
        // 立即广播，而 thinking_level_changed 事件可能晚到（异步），此时 state_changed 的 thinkingLevel 为空。
        // 本 handler 独立更新 thinkingLevel，不依赖两条消息的先后顺序。
        const p = msg.payload as { sessionId?: string; level?: string }
        if (p.sessionId && p.level) {
          sessionStore.updateSessionState(p.sessionId, { thinkingLevel: p.level })
        }
        break
      }
      default:
        break
    }
  })
  streamSubscriptions.set(sid, unsub)
}

export function useChat() {
  const chat = useChatStore()
  const session = useSessionStore()
  const settings = useSettingsStore()
  const { warning } = useToast()

  /**
   * per-session-model vision 降级去重表（W1 vision-toast）。
   *
   * 为什么放 useChat setup 内而非模块顶层：useSessionScopedState 的 onScopeDispose 注册
   * 需 active effect scope（<script setup> 提供）。sid ref 取 session.activeId 仅满足构造签名——
   * 实际去重用 updateFor(sendSid, ...)（send 显式入参 sid，与 WS handler 捕获订阅 sid 同范式，
   * 见 useSessionScopedState.ts:168-183 updateFor 设计动机），不读 activeId（避免 standby panel 串扰）。
   *
   * init 必须返回 reactive 容器（useSessionScopedState 响应式契约 L20-23），否则 mutate 不触发下游。
   * models: Set<string> 记录本 session 已警告过的 modelId，切 session 自然分区（Map 隔离）。
   *
   * sid ref 用 computed(() => session.activeId) 包装而非 storeToRefs(session).activeId：
   * computed 对 null/未初始化 store 安全（Sidebar 测试 mock session store 为 plain object，
   * storeToRefs 读 mock 的 $state.effect 会抛 TypeError）。实际去重不读 activeId（见上），
   * 这里仅满足构造签名。
   */
  const warnedModels = useSessionScopedState(
    computed(() => session.activeId),
    () => reactive({ models: new Set<string>() }),
  )

  /**
   * 统一发送编排器：把 segments 转成 promptText + images 并发送。
   *
   * 三条发送通路（send / editAndResend / 后续 landing）共享此逻辑，消除
   * 「landing/editAndResend 绕过 extractImages / size cap / vision toast」的分裂。
   *
   * 调用方负责：appendUser / truncateFrom / pendingSend 等状态机编排
   * （submitSegments 只管「提取 + 发送」核心步骤）：
   *   1. extractImages（image segment → base64，allSettled 不阻断）
   *   2. segmentsToPrompt（trim 后的 pi prompt 文本）
   *   3. vision 降级 toast（per-session-model 去重）
   *   4. size cap 层 2/3（累积 bytes 超阈值预警 / 剥离）
   *   5. chatApi.send(promptText, sendImages)
   *
   * @param sessionId  目标 session
   * @param segments   结构化 segments（含 image/file/text/skill/mention）
   */
  async function submitSegments(sessionId: string, segments: Segment[]): Promise<void> {
    // extractImages：image segment 读 local-file 文件转 base64（allSettled 不阻断，无图返 undefined）。
    // 删除 file inline 后不再并行读 file 内容，单调用即可。
    const images = await extractImages(segments)
    const promptText = segmentsToPrompt(segments)
    // vision 降级（should 优先级）：当前 model 不支持 image 输入时 toast 提示用户，
    // 不阻断不剥离 images（runtime/pi 自然丢弃不支持的多模态，文本占位仍发）。
    // per-session-model 去重：同 session 同 modelId 仅警告一次（切回/切走 model 可再次触发）。
    if (images && images.length > 0) {
      const modelId = session.list.find((s) => s.id === sessionId)?.modelId ?? ''
      if (modelId && !resolveSupportsVision(modelId, settings.providers)) {
        // updateFor 内原子 check+add（闭包捕获 sessionId，与 WS handler 同范式，防 standby 串扰）。
        let alreadyWarned = true
        warnedModels.updateFor(sessionId, (s) => {
          if (!s.models.has(modelId)) {
            s.models.add(modelId)
            alreadyWarned = false
          }
        })
        if (!alreadyWarned) {
          warning(t('panel.visionNotSupportedWarning', { modelName: modelId, count: images.length }))
        }
      }
    }
    // P2-c 层 2/3：会话级累积图片 size cap 防护。
    // 层 2：累积超 warnThreshold → toast.warning 预警（不阻断）。
    // 层 3：累积超 hardThreshold → 剥离当轮 images + toast.warning。
    // estimateAccumulatedImageBytes 内部 allSettled 并行 fetchSize，失败不 throw（ERR4）。
    let sendImages = images
    if (images && images.length > 0) {
      try {
        // eslint-disable-next-line no-magic-numbers
        const warnBytes = (settings.system.imageAccumulationWarnMB ?? IMAGE_LIMITS.ACCUMULATION_WARN_BYTES_DEFAULT / (1024 * 1024)) * 1024 * 1024
        // eslint-disable-next-line no-magic-numbers
        const hardBytes = (settings.system.imageAccumulationHardMB ?? IMAGE_LIMITS.ACCUMULATION_HARD_BYTES_DEFAULT / (1024 * 1024)) * 1024 * 1024
        const historyMessages = chat.getMessages(sessionId)
        const accumulated = await estimateAccumulatedImageBytes(
          historyMessages,
          async (path: string) => {
            const res = await fetch(`local-file:///${encodeURIComponent(path)}`)
            if (!res.ok) throw new Error(`local-file ${path} ${res.status}`)
            const blob = await res.blob()
            return blob.size
          },
        )
        if (accumulated.totalBytes > hardBytes) {
          // 层 3：剥离当轮 images（ERR6 ACCUMULATION_LIMIT_STRIP）
          sendImages = undefined
          // eslint-disable-next-line no-magic-numbers
          const sizeMB = Math.round(accumulated.totalBytes / (1024 * 1024))
          warning(t('panel.accumulationHardWarning', { size: sizeMB }))
        } else if (accumulated.totalBytes > warnBytes) {
          // 层 2：toast 预警（不阻断）
          // eslint-disable-next-line no-magic-numbers
          const sizeMB = Math.round(accumulated.totalBytes / (1024 * 1024))
          warning(t('panel.accumulationWarnWarning', { size: sizeMB }))
        }
      } catch {
        // 累积估算失败不阻断发送（与 extractImages 错误策略一致）
        console.warn('[useChat] estimateAccumulatedImageBytes failed, skipping accumulation check')
      }
    }
    await chatApi.send(sessionId, promptText, sendImages)
  }

  /**
   * 发送消息：appendUser → 确保会话级订阅 → submitSegments（提取 + api.send）。
   *
   * 流式状态由会话级订阅的事件驱动（message_start→true，complete/error→false），
   * 不依赖 send() 的 resolve 时机——避免 ack 早于首个 chunk 导致订阅被提前拆除。
   *
   * dispatching 态在 send 前置位（填 isGenerating 空窗期，让 Composer 停止按钮/steer 立即可用），
   * message_start 到达时 clearPendingSend 自动清；失败也清（catch）。
   *
   * 显式接收 sessionId：双 panel 下 Composer 各自有独立 sessionId（panel leaf 绑定），
   * send 目标由调用方传入，不读全局 session.activeId（否则 standby panel 发消息会串到 active panel）。
   */
  async function send(sessionId: string, segments: Segment[]): Promise<void> {
    const sid = sessionId
    if (segments.length === 0) return
    const promptTextCheck = segmentsToPrompt(segments)
    if (!promptTextCheck.trim()) return

    // [B 策略 D-001] busy 时自动转 steer（追加上下文，不打断当前回合）
    if (chat.isActive(sid)) {
      await steer(sid, segments)
      return
    }

    chat.appendUser(sid, segments)
    ensureStreamSubscription(sid, chat, session)
    chat.addPendingSend(sid)
    try {
      await submitSegments(sid, segments)
    } catch (e) {
      // [W2] 错误处理策略与 steer/followUp/abort 对齐：清 pendingSend + toast，不 throw。
      // 消费侧 Composer.onSend 已有 try/catch+toast 防御，此处不 throw 后 Composer 的 catch 不再触发；
      // Turn.vue submitEdit（调 editAndResend，无 try/catch）也不再产生 unhandled rejection。
      // throw 只会变 unhandled rejection，错误已通过 toast 消化。
      chat.clearPendingSend(sid)
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(t('composable.sendFailed', { msg }))
    }
  }

  /**
   * 追加 steer：AI 执行中（isGenerating）时，把补充消息排入 steering 队列，
   * 当前回合工具调用结束后、下次 LLM 调用前投递，不打断当前回合。
   *
   * 显式接收 sessionId：与 send 同理，per-panel 隔离，不读全局 activeId。
   */
  async function steer(sessionId: string, segments: Segment[]): Promise<void> {
    const sid = sessionId
    if (segments.length === 0) return
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim() || !chat.isActive(sid)) return

    // pending 气泡（S7）：steer 发出后立即入流，投递时（queue_update 移除）转 complete。
    // [W1] API 失败（WS 断连/steer_failed envelope/hook 拦截）回滚 pending + toast 提示，
    // 不 throw（错误已消化：pending 已回滚 + 用户已得反馈；throw 只会变 unhandled rejection）。
    chat.appendPending(sid, segments, 'steer')
    try {
      await chatApi.steer(sid, promptText)
    } catch (e) {
      chat.removePending(sid, segments, 'steer')
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(t('composable.supplementSendFailed', { msg }))
    }
  }

  /**
   * 追加 follow-up：把消息排入 followUp 队列，当前回合结束后另起一轮处理。
   * 非执行中按普通发送处理（避免 Alt+⏎ 死键）。
   *
   * 显式接收 sessionId：与 send 同理，per-panel 隔离。
   */
  async function followUp(sessionId: string, segments: Segment[]): Promise<void> {
    const sid = sessionId
    if (segments.length === 0) return
    const promptText = segmentsToPrompt(segments)
    if (!promptText.trim()) return

    // 非活跃（含空窗期）退化为普通发送，避免 Alt+⏎ 死键
    if (!chat.isActive(sid)) {
      await send(sid, segments)
      return
    }

    // pending 气泡（S7）：followUp 发出后立即入流，投递时（queue_update 移除）转 complete。
    // [W1] API 失败回滚 pending + toast 提示（同 steer，不 throw）。
    chat.appendPending(sid, segments, 'follow-up')
    try {
      await chatApi.followUp(sid, promptText)
    } catch (e) {
      chat.removePending(sid, segments, 'follow-up')
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(t('composable.nextTurnSendFailed', { msg }))
    }
  }

  /**
   * 中断当前回合（G-025 流转 DEFERRED：方法存在，实际中断留联调）。
   * [W3/W4] abort 乐观清 dispatching——abort 语义就是「结束当前活跃态」，即便 pi 没真正停也无害。
   * 正常成功路径由 MessageDispatcher.abort 广播的 message.complete 驱动 finalizeSession 收口；
   * 失败路径（pi 死/getClientOrThrow 抛 handler_error → abort reject）若无此 catch，dispatching 永挂。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function abort(sessionId: string): Promise<void> {
    const sid = sessionId
    // [D-008] 乐观清 pendingSend（即便 pi 没真正停也无害）
    chat.clearPendingSend(sid)
    try {
      await chatApi.abort(sid)
    } catch (e) {
      // abort 失败不重抛——用户已表达「停止」意图，UI 不应因 abort RPC 失败而卡住。
      // pendingSend 已清（乐观），实体收口靠 runtime 广播 message.complete{aborted} 兑底。
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(t('composable.stopFailed', { msg }))
    }
  }

  /**
   * 压缩上下文（#6）：确保会话级订阅（消费 session.compacting/compacted）→ 调 api.compact。
   *
   * 错误反馈（§4.4 异常路径）：session 不存在 / pi 错误 → sendError（pending reject）→
   * 在此 catch，以 toast 提示用户，不卡 UI（toast 非顶部 banner，不违反规则 #3）。compacting 态
   * 由 session.compacted 广播复位（broadcast 必达：compacting 后无论成败都广播 compacted）。
   *
   * 显式接收 sessionId：per-panel 隔离，不读全局 activeId。
   */
  async function compact(sessionId: string, customInstructions?: string): Promise<void> {
    const sid = sessionId
    ensureStreamSubscription(sid, chat, session)
    try {
      await chatApi.compact(sid, customInstructions)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(t('composable.compactFailed', { msg }))
    }
  }

  /**
   * 编辑 user 消息并重新发送（原地替换语义，非 fork）：
   * 截断该 user 消息（含）及其后所有 → appendUser 新 segments → 走 submitSegments 流式。
   *
   * 与 fork 的区别：fork 复制到新 session 保留原 session；editAndResend 在当前 session
   * 原地替换（删旧 user + 其后 assistant，重新发送）。UI 层用 canEdit 守卫仅最后一条 user 可编辑，
   * 避免删除中间 user 导致其后对话丢失。
   *
   * 签名变更（阶段 3a）：从 `(sessionId, userMessageId, text: string)` 改为
   * `(sessionId, userMessageId, segments: Segment[])`。调用方（Turn.vue submitEdit）
   * 负责构造 segments——从原 user message 保留 image segments + 编辑后的 text segment。
   *
   * 委托 submitSegments：消除原 editAndResend 用 `chatApi.send(trimmed)` 绕过
   * extractImages / size cap / vision toast 的分裂（image segment 编辑后不再丢失）。
   *
   * 显式接收 sessionId：编辑可发生在非 active 的 standby panel，不能依赖全局 activeId。
   */
  async function editAndResend(sessionId: string, userMessageId: string, segments: Segment[]): Promise<void> {
    const promptTextCheck = segmentsToPrompt(segments)
    if (!promptTextCheck.trim() || chat.isActive(sessionId)) return
    chat.truncateFrom(sessionId, userMessageId, true)
    chat.appendUser(sessionId, segments)
    ensureStreamSubscription(sessionId, chat, session)
    chat.addPendingSend(sessionId)
    try {
      await submitSegments(sessionId, segments)
    } catch (e) {
      // [W2] 错误处理策略与 send/steer/followUp/abort 对齐：清 pendingSend + toast，不 throw。
      // 消费侧 Turn.vue submitEdit 无 try/catch，不 throw 避免其产生 unhandled rejection（错误已通过 toast 消化）。
      chat.clearPendingSend(sessionId)
      const msg = e instanceof Error ? e.message : String(e)
      const { error } = useToast()
      error(t('composable.sendFailed', { msg }))
    }
  }

  /**
   * 拉取并注入历史（首次进入 session）。
   * 无历史（空 session）也标记 hydrated，避免反复请求。
   */
  async function hydrateHistory(sessionId: string): Promise<void> {
    if (chat.isHydrated(sessionId)) return
    const { messages, historyTruncated } = await chatApi.getHistory(sessionId)
    chat.hydrate(sessionId, messages)
    setHistoryTruncated(sessionId, historyTruncated)
  }

  /** N1: 查询 session 历史是否被截断（有更早的 turn 可加载） */
  function hasMoreHistory(sessionId: string): boolean {
    return historyTruncatedSessions.value.has(sessionId)
  }

  /** N1: 设置 session 历史截断标记（selectSession hydrate 时调用） */
  function setHistoryTruncated(sessionId: string, truncated: boolean): void {
    const next = new Set(historyTruncatedSessions.value)
    if (truncated) next.add(sessionId)
    else next.delete(sessionId)
    historyTruncatedSessions.value = next
  }

  /** N1: 加载更多成功后清除截断标记（已全量加载） */
  function clearHistoryTruncated(sessionId: string): void {
    if (historyTruncatedSessions.value.has(sessionId)) {
      const next = new Set(historyTruncatedSessions.value)
      next.delete(sessionId)
      historyTruncatedSessions.value = next
    }
  }

  /**
   * W4 H4：加载更多历史（fallback 全量读 + 合并去重）。
   *
   * 调 getFullHistory RPC（runtime 全量文件读取），与 store 现有消息按 id 去重后
   * 合并到列表头部。幂等：重复调用不追加已有消息（FR-4/AC-7）。
   * RPC 失败时不破坏现有消息（catch 吞错，与 hydrateHistory 的 markHistoryFailed 同策略）。
   */
  async function loadMoreHistory(sessionId: string): Promise<void> {
    try {
      const fullHistory = await chatApi.getFullHistory(sessionId)
      chat.prependHistory(sessionId, fullHistory)
      clearHistoryTruncated(sessionId) // N1: 全量加载后不再有更多历史
    // eslint-disable-next-line taste/no-silent-catch -- 加载更多是 best-effort：失败不破坏现有消息，用户可重试。与 hydrateHistory markHistoryFailed 同策略。
    } catch (e) {
      console.warn(`[useChat] loadMoreHistory failed for session ${sessionId}:`, e)
    }
  }

  /**
   * 清理指定 session 的全部资源（W1 / S3：deleteSession 调用）。
   *
   * 取消 WS 流式订阅（streamSubscriptions 模块级 Map）+ 清理 chat store per-session 状态
   * + 清 historyTruncatedSessions 标记。session 删除后若不取消订阅，WS 事件仍会推给已删
   * session 的 handler，且 Map 永久增长；historyTruncated 标记同理残留（SUGGESTION）。
   */
  function disposeSession(sessionId: string): void {
    const unsub = streamSubscriptions.get(sessionId)
    if (unsub) {
      unsub()
      streamSubscriptions.delete(sessionId)
    }
    clearHistoryTruncated(sessionId) // SUGGESTION：已删 session 的截断标记不再有意义
    chat.disposeSession(sessionId)
  }

  return { send, steer, followUp, abort, compact, editAndResend, hydrateHistory, loadMoreHistory, hasMoreHistory, setHistoryTruncated, disposeSession }
}
