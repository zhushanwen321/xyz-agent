/**
 * useHandoffEffect —— fast-handoff 完成广播的全局订阅（参照 useForkNoticeEffect.bindForkNoticeEffect）。
 *
 * 职责：订阅 session.handoffComplete 全局广播（runtime handoff 完成后推送），
 * - 复位源 session 的 handingOff 态（chat.setHandingOff(srcSessionId, false)，消除「正在交接…」反馈）；
 * - 刷新 session 列表（runtime handoff 时新建 session 但不广播 config.sessions，前端需主动 loadSessions
 *   让侧栏 + selectSession 看到新 session）；
 * - 跳转到新 session（selectSession(newSessionId)，载入 panel + 拉历史）。
 *
 * 设计：handoffComplete 走 effect 层（非 useChat switch），与 forkNotice 对称——forkNotice 也在
 * bindForkNoticeEffect 订阅而非 useChat.applyMessageEvent。session 级跳转 + 列表刷新是跨 store + api 编排，
 * 属 features/effects 层职责。App setup 是全局 effect 作用域，onScopeDispose 随 App 卸载退订。
 *
 * 生命周期：App.vue onMounted 调 bindHandoffEffect() 注册全局订阅，返回 off 函数在 onBeforeUnmount 调。
 */
import { onScopeDispose } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import * as events from '@/api/events'
import { useChatStore } from '@/stores/chat'
import { useSidebar } from '@/composables/features/useSidebar'

/**
 * 注册全局 handoff-complete 效果。
 * 在 App.vue onMounted 调用一次（单实例），返回 off 函数供 onBeforeUnmount 退订。
 */
export function bindHandoffEffect(): () => void {
  const chat = useChatStore()
  const { loadSessions, selectSession } = useSidebar()

  const off = events.onGlobalType('session.handoffComplete', (msg) => {
    const payload = (msg as ServerMessage<'session.handoffComplete'>).payload
    const { srcSessionId, newSessionId } = payload
    // 复位源 session 的 handingOff 态（消除「正在交接…」反馈，与 setHandingOff(false) 对称）
    chat.setHandingOff(srcSessionId, false)
    // runtime handoff 新建 session 但不广播 config.sessions → 主动刷新列表让新 session 进侧栏 + 可被 selectSession 命中
    void loadSessions().then(() => {
      void selectSession(newSessionId)
    })
  })

  onScopeDispose(off)
  return off
}
