/**
 * Composer 输入历史导航（shell 风格 ↑/↓ 翻阅已发送消息）。
 *
 * 行为规格（用户确认）：
 * - ↑（edit 态 + history 非空）：保存草稿 → 回填 H[0]（最后一条）→ browsing
 * - ↑（edit 态 + history 空）：不响应（保持草稿，让光标正常移动）
 * - ↑（browsing 态 + 未到最老）：index++ → 回填 H[index]
 * - ↑（browsing 态 + 已在最老）：保持不动
 * - ↓（browsing 态 + 未到最近）：index-- → 回填 H[index]
 * - ↓（browsing 态 + 已在最近）：恢复草稿 → edit 态
 * - 重置逻辑：用户在 browsing 态修改了内容 → 退出 browsing，下次按上重新从最后一条开始
 * - 回填后光标定位：↑ 翻历史→首字符前（连续回溯），↓ 翻历史/恢复草稿→末尾。
 *
 * 历史来源（方案 A，session 消息流派生）：chatStore.messages[sessionId] 中
 * role==='user' && status==='complete' 的 content，按时间倒序，连续相同文本去重。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { useChatStore } from '@/stores/chat'

/** DOM 操作回调 */
interface HistoryDeps {
  getText: () => string
  /** 写入纯文本；caretPosition='start' 光标定位首字符前（用于↑连续回溯），默认 'end' */
  setText: (text: string, caretPosition?: 'start' | 'end') => void
  clear: () => void
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
  resetBrowsing: () => void
  /** 是否正在浏览历史（browsing 态 ↑/↓ 直接翻历史，跳过视觉行移动） */
  isBrowsing: Ref<boolean>
} {
  const chatStore = useChatStore()

  /**
   * 派生历史（倒序、去重连续相同文本）。
   * H[0] = 最近一条已发送消息，H[last] = 最老一条。
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
      // 连续相同文本去重
      if (result.length > 0 && result[result.length - 1] === text) continue
      result.push(text)
    }
    return result
  })

  /** 是否正在程序化设置文本（防止 setText 触发的 input 事件导致 resetBrowsing） */
  let isSettingText = false

  /** browsing 态指针：指向 history[index] */
  let index = 0
  /** 进 browsing 前保存的草稿 */
  let savedDraft = ''
  /** 是否正在浏览历史（响应式，暴露给 Composer 跳过视觉行移动） */
  const browsing = ref(false)

  // session 切换重置
  watch(sessionIdRef, () => {
    browsing.value = false
    index = 0
    savedDraft = ''
  }, { flush: 'sync' })

  /**
   * 重置浏览状态（用户修改了 composer 内容时调用）。
   * 下次按 ↑ 会重新从最后一条历史开始。
   * 程序化设置文本（如历史导航时调用 setText）会跳过此重置。
   */
  function resetBrowsing(): void {
    if (isSettingText) return  // 跳过程序化触发
    browsing.value = false
    index = 0
  }

  /**
   * ↑ 处理。返回 true 表示已消费。
   */
  function handleArrowUp(): boolean {
    const h = history.value

    if (!browsing.value) {
      // edit 态：保存草稿，翻历史（空历史则不响应，保持草稿）
      savedDraft = deps.getText()
      if (h.length === 0) {
        // 空历史：保持草稿，不响应（让 contenteditable 层正常处理 ↑ 键移动光标）
        return false
      }
      browsing.value = true
      index = 0
      isSettingText = true
      deps.setText(h[0], 'start')  // 光标置首，便于连续↑回溯
      isSettingText = false
      return true
    }

    // browsing 态：更老一条
    if (index + 1 < h.length) {
      index++
      isSettingText = true
      deps.setText(h[index], 'start')  // 光标置首，便于连续↑回溯
      isSettingText = false
    }
    // 已在最老一条：保持不动
    return true
  }

  /**
   * ↓ 处理。返回 true 表示已消费。
   */
  function handleArrowDown(): boolean {
    if (!browsing.value) return false

    const h = history.value
    if (index > 0) {
      index--
      isSettingText = true
      deps.setText(h[index], 'end')  // 光标置末，便于连续↓回溯
      isSettingText = false
    } else {
      // 已在最近一条：恢复草稿，回到 edit 态
      isSettingText = true
      deps.setText(savedDraft, 'end')
      isSettingText = false
      browsing.value = false
    }
    return true
  }

  return { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsing: browsing }
}
