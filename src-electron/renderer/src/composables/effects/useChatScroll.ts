/**
 * useChatScroll —— message-stream auto-scroll 副作用（R2 effects 层）。
 *
 * v1 基础版（spec §8.5）：新消息到达 → scrollToBottom。
 * DEFERRED（G2-007）：用户上滚暂停、新消息「跳到底部」提示——stickToBottom ref 暴露占位，
 * 但检测逻辑不实现（始终 true，保证新消息总能滚到底）。
 *
 * 依赖方向：仅 vue ref（effects 不跨 api/stores，纯 DOM 副作用）。
 */
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'

export function useChatScroll() {
  /** 滚动容器引用（由 MessageStream 绑定 ref） */
  const scrollEl: Ref<HTMLElement | null> = ref(null)
  /**
   * 是否贴底（v1 恒 true，高级上滚暂停逻辑 DEFERRED）。
   * 保留 ref 形态让消费方未来接入 G2-007 时无需改签名。
   */
  const stickToBottom = ref(true)

  /** 滚动到底部（nextTick 确保 DOM 更新后再滚） */
  async function scrollToBottom(behavior: ScrollBehavior = 'smooth'): Promise<void> {
    await nextTick()
    const el = scrollEl.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }

  return { scrollEl, stickToBottom, scrollToBottom }
}
