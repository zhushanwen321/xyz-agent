import { onMounted, watch, type ComputedRef } from 'vue'
import { normalizeContent, type Message } from '@xyz-agent/shared'

interface MessageStreamScrollDeps {
  currentMessages: ComputedRef<Message[]>
  /**
   * 末条 turn（含 isStreaming 标志）。无 turn 时为 null（MessageStream.vue 的
   * lastRenderTurn 是 ComputedRef<MessageTurn | null>）—— null 与 undefined 都视为「无值」，
   * composable 内部 optional chaining（?.isStreaming）统一处理。
   */
  lastRenderTurn: ComputedRef<{ isStreaming: boolean } | null>
  isCompacting: ComputedRef<boolean>
  /**
   * session 级「对话进行中」信号（含 ask-user waiting / subagent working 等非 streaming 态）。
   * 驱动完成滚动 watch：true→false（对话真正结束）时触发一次 scrollToBottom。
   * 与 trace 自动折叠（useTurnElapsed.onComplete）同源，保证滚动与折叠同步。
   */
  isSessionActive: ComputedRef<boolean>
  /**
   * 滚动到底部的入口。
   *
   * [cw wave w3 / IF4] 签名从 `(behavior, force?)` 改为 `(force?) => void`：
   * MessageStream.vue 传入 followIfStuck / followToBottom 的联合（force=true → 强制滚到底，
   * 不走 rAF；force=false 默认 → 受 stickToBottom guard，非贴底时不滚）。
   * virta 是单一 scrollTop owner，behavior（'auto'/'smooth'）语义合并进 virta scrollToIndex 内部。
   */
  scrollToBottom: (force?: boolean) => void
}

/**
 * useMessageStreamScroll —— MessageStream 的滚动触发编排（消息/notice 变化 → follow 到底）。
 *
 * 从 MessageStream.vue 拆出（vue_rules_checker.py 的 script setup ≤300 行规范）。
 * 聚合四类触发滚动：消息条数变化、流式文本追加、notice（压缩中）显隐、对话完成。
 * 挂载时初始滚到底 + 切换 session 的滚动不在本 composable（后者涉及 vlistRef + session :key 重建）。
 *
 * 受 stickToBottom guard 保护（scrollToBottom 默认 force=false）：用户上滑脱离锚定时不强行拉回。
 */
export function useMessageStreamScroll(deps: MessageStreamScrollDeps): void {
  // 挂载即滚到底（force=true，展示最新内容，不受 stickToBottom guard）
  onMounted(() => {
    deps.scrollToBottom(true)
  })

  // 消息条数变化 → 滚（新消息 append / 历史加载更多）
  watch(
    () => deps.currentMessages.value.length,
    () => {
      deps.scrollToBottom()
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
        deps.scrollToBottom()
      }
    },
  )

  // notice（压缩中）显隐时滚动到底：notice 是 absolute 定位的非消息元素，
  // 不触发 messages.length / content.length / ResizeObserver 三个既有滚动源。
  // 显隐由 store 状态（isCompacting）驱动，此处监听状态变化主动滚。
  // 受 stickToBottom guard 保护（scrollToBottom 默认 force=false）：用户上滑脱离锚定时不强行拉回，
  // 与现有流式滚动（上方 watch）语义一致。
  watch(
    () => deps.isCompacting.value,
    (show) => {
      if (show) deps.scrollToBottom()
    },
  )

  // 对话完成（isSessionActive true→false）触发一次 follow 到底。
  //
  // 背景：完成时 trace 自动折叠（useTurnElapsed.onComplete 驱动 expanded=false）导致末尾 turn
  // 高度骤减，virta $fixScrollJump 异步触发 followIfStuck 有时间窗，期间界面停中间。
  // 此处与 trace 折叠同源（都看 isSessionActive）显式补一次 follow，消除空窗期。
  //
  // 不用 force=true：尊重用户上滑意图（stickToBottom=false 时 guard 拦截，视口不动）。配合
  // useVirtuaFollow 的 pauseStickGuard（trace 折叠 transition 期间暂停 onScroll 误判），贴底态下能
  // 正确执行到底。ask-user/subagent 期间 isSessionActive 保持 true，不会误触发。
  watch(
    () => deps.isSessionActive.value,
    (nw, old) => {
      if (old && !nw) deps.scrollToBottom()
    },
  )
}
