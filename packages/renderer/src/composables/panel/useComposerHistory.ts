/**
 * Composer 输入历史导航（shell 风格 ↑/↓ 翻阅已发送消息）。
 *
 * 行为规格（bash 风格，用户确认）：
 * - ↑（仅光标在第一行时触发）：
 *   - edit 态 + history 非空：保存当前草稿 → browsing → 回填 H[0]（最近一条）
 *   - edit 态 + history 空：清空 composer（无历史可翻）
 *   - browsing + 未到最老：index++ → 回填 H[index]
 *   - browsing + 已在最老：保持不动（不循环、不清空，用户要往回走只能按 ↓）
 * - ↓（仅 browsing 态触发；edit 态按 ↓ 是正常光标移动）：
 *   - browsing + 未到最近：index-- → 回填 H[index]
 *   - browsing + 已在最近（index=0）：恢复进 browsing 前的草稿 → 回到 edit 态
 *   - browsing 态不要求光标在末行：一旦在翻历史，↓ 就是翻历史（与大多数 shell 一致），
 *     避免 contenteditable 行判定在真实 DOM 下不准导致 ↓ 完全失效
 * - 回填后光标定位在内容末尾（由 setText 的 collapse(false) 保证）。
 *
 * 历史来源（方案 A，session 消息流派生）：chatStore.messages[sessionId] 中
 * role==='user' && status==='complete' 的 content，按时间倒序，连续相同文本去重。
 * 符合架构约定 #7.5：历史是对消息流的读取视图，不另建存储；重开 session 仍可见。
 *
 * 状态机每 Composer 实例私有，session 切换时重置（不同 session 历史不同）。
 */
import { computed, watch, type Ref } from 'vue'
import { useChatStore } from '@/stores/chat'

/** DOM 操作回调（由 ComposerInput composable 提供，避免直接耦合 contenteditable 实现） */
interface HistoryDeps {
  /** 取当前 composer 文本（进 browsing 前保存草稿用） */
  getText: () => string
  /** 写入文本并把光标移到末尾（回填历史） */
  setText: (text: string) => void
  /** 清空 composer（↑ 无历史时） */
  clear: () => void
  /** 光标是否在第一行（决定 ↑ 是否触发翻历史；多行编辑时 ↑ 应是正常光标移动） */
  isCaretOnFirstLine: () => boolean
}

/**
 * @param sessionIdRef 当前 session id（null 时无历史可翻）
 * @param deps DOM 操作回调
 */
export function useComposerHistory(
  sessionIdRef: Ref<string | null>,
  deps: HistoryDeps,
): {
  handleArrowUp: () => boolean
  handleArrowDown: () => boolean
} {
  const chatStore = useChatStore()

  /**
   * 派生历史（倒序、去重连续相同文本）。
   * H[0] = 最近一条已发送消息，H[last] = 最老一条。
   * 仅取 status==='complete'（排除 pending 的 steer/followup，用户尚未确认投递成功）。
   */
  const history = computed<string[]>(() => {
    const sid = sessionIdRef.value
    if (!sid) return []
    const msgs = chatStore.getMessages(sid)
    const result: string[] = []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'user' || m.status !== 'complete') continue
      const text = m.content
      // 连续相同文本去重（用户连发两次同样的话只留一条，与 shell 行为一致）
      if (result.length > 0 && result[result.length - 1] === text) continue
      result.push(text)
    }
    return result
  })

  /** browsing 态指针：指向 history[index]；edit 态无意义 */
  let index = 0
  /** 进 browsing 前保存的草稿（↓ 越过最近一条时恢复） */
  let savedDraft = ''
  /** 是否正在浏览历史（edit=用户正在打字，browsing=正在翻历史） */
  let browsing = false

  // session 切换重置：不同 session 历史不同，指针必须归位。
  // flush:'sync'——切换后若极快按键（程序化切换 session 后立即 handleArrow*），
  // 异步 watch（默认 'pre'）尚未 flush，browsing 仍是旧值会导致用旧 session 草稿回填。
  // 同步 watch 保证切换即重置。
  watch(sessionIdRef, () => {
    browsing = false
    index = 0
    savedDraft = ''
  }, { flush: 'sync' })

  /**
   * ↑ 处理。返回 true 表示已消费（调用方 preventDefault）。
   * 仅在光标位于第一行（或 browsing 态，光标已在末尾）时翻历史；
   * 否则返回 false，让浏览器做正常光标上移。
   */
  function handleArrowUp(): boolean {
    // browsing 态光标已在历史末尾（setText 放末尾），允许继续翻；
    // edit 态要求光标在第一行，避免多行编辑时 ↑ 替换内容
    if (!browsing && !deps.isCaretOnFirstLine()) return false

    const h = history.value
    if (!browsing) {
      // edit → browsing
      savedDraft = deps.getText()
      if (h.length === 0) {
        // 无历史可翻：清空 composer（用户确认的语义）。
        // 保持 browsing=false：再按 ↑ 仍走此分支，幂等清空，不会循环回填历史。
        deps.clear()
        return true
      }
      browsing = true
      index = 0
      deps.setText(h[0])
      return true
    }
    // browsing → 更老一条
    if (index + 1 < h.length) {
      index++
      deps.setText(h[index])
    }
    // 已在最老一条：保持不动（不循环、不清空、不退回 edit）。
    // 用户要往回走只能按 ↓。这避免“越过最老→清空→再按↑又回最近一条”的循环。
    return true
  }

  /**
   * ↓ 处理。返回 true 表示已消费。
   * 仅 browsing 态响应（edit 态按 ↓ 是正常光标下移）。
   * browsing 态不要求光标在最后一行——一旦在翻历史，↓ 就是翻历史（与大多数 shell 一致），
   * 避免行判定在真实 DOM 下不准导致 ↓ 完全失效。光标行判定只用于首次 ↑（保护多行编辑）。
   */
  function handleArrowDown(): boolean {
    if (!browsing) return false

    const h = history.value
    if (index > 0) {
      // 回到更新一条
      index--
      deps.setText(h[index])
    } else {
      // 已在最近一条：恢复草稿，回到 edit 态
      deps.setText(savedDraft)
      browsing = false
    }
    return true
  }

  return { handleArrowUp, handleArrowDown }
}
