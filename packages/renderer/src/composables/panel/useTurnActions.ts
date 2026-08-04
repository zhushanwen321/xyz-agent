/**
 * useTurnActions —— Turn.vue 的 fork/handoff 操作 handler 集合（从 Turn.vue 拆出，减行用）。
 *
 * 职责：Turn hover action 行的 4 个消息操作 handler 编排（后台 fork / fork 提问 / 后台 handoff /
 * handoff 备注）。Turn.vue script setup 仅解构使用，保持模板结构不变。
 *
 * 拆分原因：Turn.vue script setup 行数触顶（max-lines 500），fast-handoff wave 新增的 handoff
 * handler 把文件推过阈值。fork handler 是历史（fast-fork wave），handoff handler 是本次新增，
 * 二者职责对称（后台 → 直接调编排 / 提问 → 进 composer 模式），适合一并下沉到同一 composable。
 *
 * 与 useForkActions / useHandoffActions 的区别：那两个是 sidebar 层的「跨 api + stores 编排」
 * （forkSession / handoff 真源在此）；本 composable 只做 Turn 行级 handler 的薄 wrapper
 * （调 useSidebarNew 的编排 + 错误 toast），不含跨 api 编排逻辑。
 */
import type { ComputedRef, Ref } from 'vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Message } from '@xyz-agent/shared'
import { useSidebarNew } from '@/composables/features/useSidebarNew'
import { triggerEnterForkMode } from '@/composables/panel/useForkModeChannel'
import { triggerEnterHandoffMode } from '@/composables/panel/useHandoffModeChannel'
import { useToast } from '@/composables/useToast'

/** Turn 操作 handler 依赖（传 ComputedRef 而非裸值：handler 调用时读当前响应式值） */
interface TurnActionsDeps {
  /** Turn 所在 session（fork/handoff 源，双 panel standby 场景不能依赖全局 activeId） */
  sessionId: ComputedRef<string>
  /**
   * 末条 assistant（存在性守卫用）。handoff 不接收 msg 参数——runtime 从源 session
   * agent_end 提取文档打包，无需 messageId 锚点；前端仍需保证「有 assistant 可交接」才触发。
   */
  lastAssistant: ComputedRef<Message | null>
}

/**
 * Turn 操作 handler composable。
 *
 * sessionId / lastAssistant 通过 deps 注入（ComputedRef，handler 调用时读当前响应式值）。
 */
export function useTurnActions(deps: TurnActionsDeps): {
  /** fork 后台：从指定 assistant 空白 fork，留在原线（includeFrom=true） */
  onFork: (msg: Message) => Promise<void>
  /** fork 提问：从指定 assistant 进 composer fork 模式（发 signal） */
  onForkAsk: (msg: Message) => void
  /** fork 后台（防重复 wrapper）：内部管理 isForking 状态 */
  handleFork: (msg: Message) => Promise<void>
  /** fork 操作进行中（按钮 disabled 守卫） */
  isForking: Ref<boolean>
  /** handoff 后台：runtime 从末条 assistant 提取文档到新 session（agent-driven） */
  onHandoff: () => Promise<void>
  /** handoff 备注：进 composer handoff 模式（发 signal，可附 focus 说明） */
  onHandoffAsk: (msg: Message) => void
} {
  const { sessionId, lastAssistant } = deps
  const { t } = useI18n()
  const { error: toastError } = useToast()
  const { forkSession, handoff: handoffAction } = useSidebarNew()

  /**
   * fork 后台（低频）：从指定 assistant 处空白 fork，留在原线（useSidebarNew.forkSession 已不 split）。
   * includeFrom=true：保留到该 assistant（含）。反馈行由 session.forkNotice 广播驱动渲染。
   * 失败时 toast 反馈（与 fork-ask 路径对称），避免静默 unhandled rejection。
   */
  async function onFork(msg: Message): Promise<void> {
    if (!msg) return
    try {
      await forkSession(sessionId.value, msg.id, { includeFrom: true, openInStandby: false })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      toastError(t('panel.message.forkFailed', { error }))
    }
  }

  /**
   * fork 提问（高频）：从指定 assistant 处进入 composer fork 模式（spec §2 层②）。
   * 经 useForkModeChannel 发 signal，Composer 监听后调自身 enterForkMode（聚焦输入框等用户键入），
   * 用户输入完成后由 Composer 的 fork 模式发送路径调 forkSessionAsk（fork + 把 content 作首条 user）。
   * 不在此处直接 fork——fork 点的选择权交回 composer（与末条 assistant 快捷键 ⌘⇧G 同路径）。
   */
  function onForkAsk(msg: Message): void {
    if (!msg) return
    triggerEnterForkMode(sessionId.value, msg.id)
  }

  /**
   * handoff 后台（fast-handoff）：runtime 从末条 assistant 提取文档到新 session（agent-driven）。
   * 完成经 session.handoffComplete 广播 → useHandoffEffect 跳转新 session。
   * 失败时 toast 反馈（与 onFork 对称）。
   *
   * 不接收 msg 参数：runtime 从源 session agent_end 提取文档，无 messageId 锚点（与 onFork 用 msg.id 不对称）。
   * 保留「有 assistant 可交接」存在性守卫，但改读注入的 lastAssistant（模板按钮已 v-if="lastAssistant"，
   * 此守卫作防御性兜底——防止非模板路径/测试无 assistant 时触发）。重复点击由按钮 disabled=isHandingOff 防护。
   */
  async function onHandoff(): Promise<void> {
    if (!lastAssistant.value) return
    try {
      await handoffAction(sessionId.value)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      toastError(t('panel.message.handoffFailed', { error }))
    }
  }

  /**
   * handoff 备注（fast-handoff）：进入 composer handoff 模式（对称 onForkAsk）。
   * 经 useHandoffModeChannel 发 signal，Composer 监听后调自身 enterHandoffMode（聚焦输入框等用户键入 focus）。
   *
   * @param msg 保留签名对称性，handoff 无 fromMessageId（runtime 从 agent_end 提取文档）
   */
  function onHandoffAsk(msg: Message): void {
    if (!msg) return
    triggerEnterHandoffMode(sessionId.value)
  }

  /** [m3] fork 操作防重复（参照 isHandingOff，防 forkSession RPC 重入） */
  const isForking = ref(false)
  async function handleFork(msg: Message): Promise<void> {
    if (isForking.value) return
    isForking.value = true
    try {
      await onFork(msg)
    } finally {
      isForking.value = false
    }
  }

  return { onFork, onForkAsk, handleFork, isForking, onHandoff, onHandoffAsk }
}
