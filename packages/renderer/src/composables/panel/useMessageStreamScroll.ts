import { onMounted, watch, type ComputedRef } from 'vue'
import { normalizeContent, type Message } from '@xyz-agent/shared'

interface MessageStreamScrollDeps {
  currentMessages: ComputedRef<Message[]>
  /**
   * 末条 turn（含 isStreaming 标志）。无 turn 时为 null（MessageStream.vue 的
   * lastRenderTurn 是 ComputedRef<MessageTurn | null>）—— null 与 undefined 都视为「无值」，
   * composable 内 optional chaining（?.isStreaming）统一处理。
   */
  lastRenderTurn: ComputedRef<{ isStreaming: boolean } | null>
  isCompacting: ComputedRef<boolean>
  isHandingOff: ComputedRef<boolean>
  scrollToBottom: (behavior: 'auto' | 'smooth', force?: boolean) => void
}

/**
 * useMessageStreamScroll —— MessageStream 的滚动触发编排（消息/notice 变化 → scrollToBottom）。
 *
 * 从 MessageStream.vue 拆出（vue_rules_checker.py 的 script setup ≤300 行规范）。
 * 聚合三类触发滚动：消息条数变化、流式文本追加、notice（压缩中/正在交接）显隐。
 * 挂载时初始滚到底 + 切换 session 的滚动不在本 composable（后者涉及 virtualList.resetSession + settling）。
 *
 * 受 stickToBottom guard 保护（scrollToBottom 默认 force=false）：用户上滑脱离锚定时不强行拉回。
 */
export function useMessageStreamScroll(deps: MessageStreamScrollDeps): void {
  // 挂载即滚到底（force=true，展示最新内容，不受 stickToBottom guard）
  onMounted(() => {
    deps.scrollToBottom('auto', true)
  })

  // 消息条数变化 → 滚（新消息 append / 历史加载更多）
  watch(
    () => deps.currentMessages.value.length,
    () => {
      deps.scrollToBottom('auto')
    },
  )

  // streaming 中 text 追加也触发滚动（按最后一条消息归一化后的文本长度）。
  // content 是 string | Segment[]：.length 对 string 是字符数、对 Segment[] 是元素数，语义不一致；
  // 用 normalizeContent 统一取纯文本长度，类型安全且对 token 级追加仍敏感。
  watch(
    () => {
      const list = deps.currentMessages.value
      const last = list[list.length - 1]
      if (!last) return 0
      return normalizeContent(last.content).length
    },
    () => {
      if (deps.lastRenderTurn.value?.isStreaming) {
        deps.scrollToBottom('auto')
      }
    },
  )

  // notice（压缩中/正在交接）显隐时滚动到底：notice 是 absolute 定位的非消息元素，
  // 不触发 messages.length / content.length / ResizeObserver 三个既有滚动源（不撑高 contentEl）。
  // 显隐由 store 状态（isCompacting/isHandingOff）驱动，此处监听状态变化主动滚。
  // 受 stickToBottom guard 保护（scrollToBottom 默认 force=false）：用户上滑脱离锚定时不强行拉回，
  // 与现有流式滚动（上方 watch）语义一致。
  watch(
    () => deps.isCompacting.value || deps.isHandingOff.value,
    (show) => {
      if (show) deps.scrollToBottom('auto')
    },
  )
}
