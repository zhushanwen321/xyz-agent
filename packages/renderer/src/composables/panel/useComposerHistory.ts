/**
 * Composer 输入历史导航（shell 风格 ↑/↓ 翻阅已发送消息）。
 *
 * ⚠️ 权威行为规格见 `.xyz-harness/2026-07-10-composer-history-navigation/spec.md`
 * （FR1 视觉行导航 + FR2 光标定位 + FR3 换行往返 + FR4 跨 session 草稿持久化）。
 * 本文件头注释仅为快速索引，规则变更先改 spec 再同步此处。
 *
 * 状态机摘要（详见 spec FR1 三阶段模型）：
 * - ↑（edit 态）：三阶段——非首行移光标 → 首行非行首归位 → 首行行首进 browsing
 * - ↑（browsing 态 + 未到最老）：index++ → 回填 H[index]
 * - ↑（browsing 态 + 已在最老）：保持不动
 * - ↓（browsing 态 + 未到最近）：index-- → 回填 H[index]
 * - ↓（browsing 态 + 已在最近）：恢复草稿 → edit 态
 * - 回填后光标定位（spec FR2）：↑→首位（连续回溯），↓→末位
 * - 重置：用户在 browsing 态修改内容 → 退出 browsing，下次 ↑ 重新从最后一条开始
 *
 * 历史来源（spec Glossary H[index]）：chatStore.messages[sessionId] 中
 * role==='user' && status==='complete' 的 content，按时间倒序，连续相同文本去重。
 *
 * per-session 隔离（ADR-0036 W3）：browsing/index/savedDraft 三态收进 reactive 对象，
 * 经 useSessionScopedState 分区到 Map<sessionId, {browsing,index,savedDraft}>。
 * history computed 仍从 chatStore 派生（天然 per-session，不迁移）。
 * Map 分区天然隔离：切 sid 自动切分区，切回恢复草稿与浏览指针（AC-5），
 * 无需 watch(sessionId) 重置。
 */
import { computed, reactive, type Ref } from 'vue'
import { normalizeContent } from '@xyz-agent/shared'
import { useChatStore } from '@/stores/chat'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

/** DOM 操作回调 */
interface HistoryDeps {
  getText: () => string
  /** 写入纯文本；caretPosition='start' 光标定位首字符前（用于↑连续回溯），默认 'end' */
  setText: (text: string, caretPosition?: 'start' | 'end') => void
  clear: () => void
}

/** per-session browsing 导航状态（收进 reactive 经 Map 分区） */
interface ComposerNavState {
  /** 是否正在浏览历史（响应式，暴露给 Composer 跳过视觉行移动） */
  browsing: boolean
  /** browsing 态指针：指向 history[index] */
  index: number
  /** 进 browsing 前保存的草稿 */
  savedDraft: string
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
      // content 可能是 string | Segment[]（ADR-0037），归一化为纯文本用于历史导航
      const text = normalizeContent(m.content)
      // 连续相同文本去重
      if (result.length > 0 && result[result.length - 1] === text) continue
      result.push(text)
    }
    return result
  })

  /**
   * per-session 分区导航状态（ADR-0036 W3）。
   * init 返回 reactive 容器：下游 isBrowsing computed 在其上建立依赖，
   * handleArrow* 内 mutate 字段时失效重算（W2 useExtensionUI 验证的响应式要点）。
   */
  const navState = useSessionScopedState<ComposerNavState>(
    sessionIdRef,
    () => reactive<ComposerNavState>({ browsing: false, index: 0, savedDraft: '' }),
  )

  /** 是否正在浏览历史（响应当前分区的 browsing 字段） */
  const isBrowsing = computed(() => navState.current.value.browsing)

  /** 是否正在程序化设置文本（防止 setText 触发的 input 事件导致 resetBrowsing） */
  let isSettingText = false

  /**
   * 重置浏览状态（用户修改了 composer 内容时调用）。
   * 下次按 ↑ 会重新从最后一条历史开始。
   * 程序化设置文本（如历史导航时调用 setText）会跳过此重置。
   */
  function resetBrowsing(): void {
    if (isSettingText) return  // 跳过程序化触发
    navState.update((s) => {
      s.browsing = false
      s.index = 0
    })
  }

  /**
   * ↑ 处理。返回 true 表示已消费。
   */
  function handleArrowUp(): boolean {
    const h = history.value
    const s = navState.current.value

    if (!s.browsing) {
      // edit 态：保存草稿，翻历史（空历史则不响应，保持草稿）
      const draft = deps.getText()
      if (h.length === 0) {
        // 空历史：保持草稿，不响应（让 contenteditable 层正常处理 ↑ 键移动光标）。
        // null sid 时 history 也为空（走此分支），草稿不入分区（update 在 null sid no-op）。
        return false
      }
      navState.update((st) => {
        st.savedDraft = draft
        st.browsing = true
        st.index = 0
      })
      isSettingText = true
      deps.setText(h[0], 'start')  // 光标置首，便于连续↑回溯
      isSettingText = false
      return true
    }

    // browsing 态：更老一条
    if (s.index + 1 < h.length) {
      const newIndex = s.index + 1
      navState.update((st) => {
        st.index = newIndex
      })
      isSettingText = true
      deps.setText(h[newIndex], 'start')  // 光标置首，便于连续↑回溯
      isSettingText = false
    }
    // 已在最老一条：保持不动
    return true
  }

  /**
   * ↓ 处理。返回 true 表示已消费。
   */
  function handleArrowDown(): boolean {
    const s = navState.current.value
    if (!s.browsing) return false

    const h = history.value
    if (s.index > 0) {
      const newIndex = s.index - 1
      navState.update((st) => {
        st.index = newIndex
      })
      isSettingText = true
      deps.setText(h[newIndex] ?? s.savedDraft, 'end')  // 光标置末，便于连续↓回溯
      isSettingText = false
    } else {
      // 已在最近一条：恢复草稿，回到 edit 态
      isSettingText = true
      deps.setText(s.savedDraft, 'end')
      isSettingText = false
      navState.update((st) => {
        st.browsing = false
      })
    }
    return true
  }

  return { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsing }
}
