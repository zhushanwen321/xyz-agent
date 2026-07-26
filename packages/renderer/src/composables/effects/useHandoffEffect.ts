/**
 * useHandoffEffect —— fast-handoff 完成广播的全局订阅（参照 useForkNoticeEffect.bindForkNoticeEffect）。
 *
 * 职责：订阅 session.handoffComplete 全局广播（runtime handoff 完成后推送），
 * - 复位源 session 的 handingOff 态；
 * - 刷新 session 列表；
 * - 建立新 session 的流式订阅（ensureStreamSubscription，对齐 fork-ask 修复，否则 pi 流式回复被静默丢弃）；
 * - 注入 handoff 文档作首条 user message（chatApi.send，对齐 fork-ask 的 appendUser + addPendingSend + send）；
 * - 跳转到新 session（载入 panel + 拉历史）。
 *
 * 时序竞争根治（方案 2：发送职责归位 renderer）：
 *   runtime 不再 sendMessage 注入文档，只在 create + 广播（payload 带 wrapped doc）。前端收到广播后
 *   先 ensureStreamSubscription 建好订阅，再 chatApi.send(doc) 触发 pi 开始流式生成——订阅早于生成，
 *   零竞争窗口（pi 的 message.* 事件不再因无订阅者被静默丢弃）。完全对齐 fork-ask 模式
 *   （useForkActions.ts:109-113 send 前先建订阅）。
 *
 * 设计：handoffComplete 走 effect 层（非 useChat switch），与 forkNotice 对称——forkNotice 也在
 * bindForkNoticeEffect 订阅而非 useChat.applyMessageEvent。session 级跳转 + 列表刷新 + 文档注入是
 * 跨 store + api 编排，属 features/effects 层职责。App setup 是全局 effect 作用域，onScopeDispose 随
 * App 卸载退订。
 *
 * 生命周期：App.vue onMounted 调 bindHandoffEffect() 注册全局订阅，onScopeDispose 随 App 卸载退订
 * （对齐 bindForkNoticeEffect 范式：返回 void，不返回 off）。
 */
import { onScopeDispose } from 'vue'
import type { ServerMessage, Segment } from '@xyz-agent/shared'
import * as events from '@/api/events'
import { chat as chatApi, session as sessionApi } from '@/api'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/useSidebar'
import { ensureStreamSubscription, useChat } from '@/composables/features/useChat'

/**
 * 注册全局 handoff-complete 效果。
 * 在 App.vue onMounted 调用一次（单实例），onScopeDispose 随 App 卸载退订。
 * 返回 void（对齐 bindForkNoticeEffect 范式，不依赖返回值做退订）。
 */
export function bindHandoffEffect(): void {
  const chat = useChatStore()
  const { loadSessions, selectSession } = useSidebar()
  const session = useSessionStore()
  // [W6] 顶层实例化 useChat：避免在 catch 内每次新建实例（composable 工厂模式反模式）。
  // disposeSession 用于 send 失败时清理新 session 的流式订阅 + per-session 状态。
  const { disposeSession } = useChat()

  const off = events.onGlobalType('session.handoffComplete', (msg) => {
    const payload = (msg as ServerMessage<'session.handoffComplete'>).payload
    const { srcSessionId, newSessionId, doc, reply, sourceLabel } = payload
    // 复位源 session 的 handingOff 态（消除「正在交接…」反馈，与 setHandingOff(false) 对称）
    chat.setHandingOff(srcSessionId, false)
    // runtime handoff 新建 session 但不广播 config.sessions → 主动刷新列表让新 session 进侧栏 + 可被 selectSession 命中。
    // [W4] loadSessions 失败不应阻塞文档注入核心流程——runtime 已 create newSession，若因列表刷新失败
    // 跳过 send，新 session 永远空挂（60s 后 handingOff 自动清，孤儿 session 留 runtime）。此处把 loadSessions
    // 降级为非阻塞前置：失败仅 warn，.then 仍执行核心编排（selectSession 内部会再触发列表刷新作降级恢复）。
    void loadSessions()
      .catch((e) => {
        console.warn('[handoff-effect] loadSessions failed, proceeding with doc injection anyway:', e)
      })
      .then(async () => {
        // [fast-handoff] 建立新 session 的流式订阅（必须在 send 之前，对齐 fork-ask 修复 + useChat.send 契约）。
        // runtime 在广播前未 sendMessage，pi 尚未开始生成——此处 send 后 pi 才开始，订阅早于生成，
        // 零竞争窗口（根治时序竞争：pi 的 message.* 事件不再因无订阅者被 events.dispatchSession 静默丢弃）。
        ensureStreamSubscription(newSessionId, chat, session)
        // [C1] 预标记 hydrated：selectSession 的 hydrate 会用 getHistory 快照覆盖 messages[newId]，
        // 清空 appendUser 的本地 user 消息 + 流式中的 assistant 内容（pi in-progress message 没进
        // JSONL，getHistory 拿不到）。handoff 的 newSession 自己管理消息（appendUser 注入 + send
        // 后流式接收），不从 pi 拉历史——预标记让 selectSession 跳过 getHistory。
        // hydrate(newId, []) 同时 commitMessages(空数组) 设 messages[newId]=[]，appendUser 后续追加。
        // 安全：此刻 newSession 刚 create，runtime 未推任何消息，messages[newId] 本就为空，commitMessages
        // 不会误清已有内容。catch 的 disposeSession 会清 hydrated（chat.ts:816 disposeSessionImpl 的
        // setRefs 范围含 hydrated Set）。
        chat.hydrate(newSessionId, [])
        // 注入文档作首条 user message（doc 是纯文本 handoff 文档）。
        // W3: 用 Segment[] 构造含 handoff badge 的结构化 user message。
        // sourceLabel 存在时加 handoff badge segment，否则退化为纯 text。
        // chatApi.send 接 string，拼接 doc + reply 作完整 prompt。
        const segments: Segment[] = sourceLabel
          ? [
            { type: 'handoff', sourceLabel },
            { type: 'text', text: reply ? `${doc}\n\n---\n${reply}` : doc },
          ]
          : [{ type: 'text', text: reply ? `${doc}\n\n---\n${reply}` : doc }]
        const docToSend = reply ? `${doc}\n\n---\n${reply}` : doc
        chat.appendUser(newSessionId, segments)
        chat.addPendingSend(newSessionId)
        try {
          await chatApi.send(newSessionId, docToSend)
        } catch {
          // [M1] send 失败回滚：runtime 已 create newSession（pi 进程已 spawn + markHandedOff 已执行），
          // 必须清理 runtime 侧的孤立 newSession，对齐 fork-ask（useForkActions.ts:120-124）。
          // disposeSession 清本地订阅 + per-session 状态（含 hydrated Set + messages + pendingSend timer），
          // clearPendingSend 复位 pending 标记；sessionApi.remove 清 runtime pi 进程 + sessions Map，
          // session.removeFromList 清侧栏列表（loadSessions 已把 newSession 灌入 groups）。
          // 已知限制：markHandedOff（runtime 内存 + 磁盘 handoff_marker）不回滚——需新增 runtime RPC，
          // 当前接受源 session 标记泄漏（用户可在源 session 手动重试或忽略「已交接」标记）。
          // 不 toast、不 rethrow（错误经 WS 的 message.error / send.rejected 通道反馈，与正常 send 一致；
          // 且本回调无调用方接住 rethrow，throw 只会变 unhandled rejection）。
          disposeSession(newSessionId)
          chat.clearPendingSend(newSessionId)
          await sessionApi.remove(newSessionId).catch(() => {})
          session.removeFromList(newSessionId)
          return
        }
        void selectSession(newSessionId)
      })
      .catch((e) => {
        // [M2] 防护 unhandled rejection：.then(async () => {...}) 的 async 回调内同步代码（textToSegments /
        // appendUser / ensureStreamSubscription / selectSession 等）抛错时，.then 返回 rejected promise，
        // 无 .catch 会变 unhandled rejection。chatApi.send 已被上面 try/catch 包裹不会逃逸，本 catch 仅兜底
        // 其余同步操作抛错。
        // [W3] 回滚完整性：到此处时 ensureStreamSubscription 已注册模块级 stream 订阅 +
        // appendUser/addPendingSend 已写 messages / 启动 30s pendingSendTimer，若某后续同步步骤抛错，这些
        // 资源必须回滚——否则 stream 订阅留在 Map 直到 session 删除，pendingSendTimer 30s 后触发
        // finalizeSession。调 disposeSession(newSessionId) 清理（与 M1 的 send 失败回滚对称）。注意：仅当
        // 抛错发生在 appendUser/addPendingSend 之后才有资源可清，但 disposeSession 对未注册资源是幂等 no-op，
        // 无条件调用最安全。
        console.warn('[handoff-effect] error:', e)
        disposeSession(newSessionId)
      })
  })

  onScopeDispose(off)
}
