/**
 * useComposerHandoffMode —— Composer 的 handoff（交接）模式（fast-handoff，参照 useComposerForkMode）。
 *
 * 从 Composer.vue 拆出（script setup 行数合规）。职责：
 * - handoffMode 状态真源：是否处于「从末条 assistant 交接」的备注模式
 * - handoffSource：记录 handoff 来源（srcSessionId = handoff 出发的 session）
 * - enterHandoffMode / exitHandoffMode：进入（记来源 + 聚焦输入框 + 互斥退出 fork 模式）/ 退出（复位状态）
 * - 跨组件触发通道：watch handoffEnterSignal（Sidebar ⌘J 请求），命中本 session 时 enterHandoffMode
 * - handoffBoxClass / handoffPlaceholder：handoff 模式派生的 class 与 placeholder 文案
 * - handleHandoffEsc：Esc 退出（清空输入 + exitHandoffMode），返回是否已消费
 * - handleHandoffSend：handoff 模式发送（调 handoff(srcId, text) + 退出），返回是否已消费
 * - handoffModeRef：{ value: boolean } 包装对象，给 defineExpose 用（避免 Vue 解包顶层 ref）
 *
 * 与 fork 模式互斥：进 handoff 前退出 fork（deps.exitForkMode）；fork 模式自身进 handoff 时也对称退出。
 * 发送/清空输入等副作用通过 deps 注入（Composer 持有 draft/isSending/clearInput/restoreInput 真源），
 * 保持 handoff 状态真源单一且不侵入 Composer 已稳定的发送/草稿流程。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerHandoffMode.ts。改动：
 * - 跨域能力（vue-i18n t / Upload icon / toastError / isHandingOff / handoffEnterSignal channel）
 *   去掉 renderer import，改为 HandoffDeps 字段注入（core 零 renderer 依赖）
 * - import 路径 `@/composables/panel/staging-types` StagingAction → `../types`
 * - ComposerInput.vue 实例类型 → 局部 ComposerInputInstance 结构类型（{focus}，与 input/types.ts
 *   的完整实例契约互补——壳层 ComposerInput.vue 的 defineExpose 同时满足两者，结构类型；
 *   u3.1 起收敛为从域级 types.ts 权威接口 Pick 派生，不再局部声明）
 * - handleHandoffEsc 参数 KeyboardEvent → KeyboardEventLike（core 零 DOM 约束，真实 KeyboardEvent 兼容）
 * - isInProgress 派生：原 chatStore.isHandingOff(...) → deps.isHandingOff(...)（dep 注入）
 * 逻辑 byte-level 保持。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Component } from 'vue'
import type { ComposerInputInstance, KeyboardEventLike, StagingAction, StagingConfig } from '../types'

/** useComposerHandoffMode 返回类型（从函数内联类型提取为命名 interface，便于复用 + 阅读） */
export interface ComposerHandoffModeReturn {
  handoffMode: Ref<boolean>
  /** { value: boolean } 包装对象，给 defineExpose 用（不被 Vue 解包） */
  handoffModeRef: { readonly value: boolean }
  enterHandoffMode: (srcSessionId: string) => void
  exitHandoffMode: () => void
  /** handoff 模式 composer-box class（accent 边 + glow + accent-soft 底）；非 handoff 模式返回空串 */
  handoffBoxClass: ComputedRef<string>
  /** handoff 模式 placeholder 文案；非 handoff 模式返回 null */
  handoffPlaceholder: ComputedRef<string | null>
  /** Esc 处理：handoff 模式下清空输入 + 退出，返回 true 表示已消费；否则返回 false */
  handleHandoffEsc: (e: KeyboardEventLike) => boolean
  /** handoff 模式发送：调 handoff(srcId, text) + exitHandoffMode，返回 true 表示已消费；否则返回 false */
  handleHandoffSend: (text: string) => Promise<boolean>
  /**
   * 包装成 StagingAction（handoff 实现），供 useComposerStaging 注册消费。
   * 不改变现有 handoffMode/enterHandoffMode 等 expose 契约（仅追加 adapter，对齐 ADR-0057）。
   */
  asStagingAction: () => StagingAction
}

/** handoff 发送副作用依赖（由 Composer 注入，避免重复持有 draft/isSending 真源） */
export interface HandoffDeps {
  /**
   * ComposerInput 实例 ref：enterHandoffMode 聚焦输入框用。
   * 本模块视角的最小契约——从域级权威接口（../types）Pick 仅 focus，耦合面显式
   * 受控于权威定义（权威 focus 必选，真实实例 defineExpose 必有；调用点 focus 的
   * 二级可选链按零行为变化原则原样保留，运行时骗类型的低配桩仍不炸）。
   */
  inputRef: Ref<Pick<ComposerInputInstance, 'focus'> | null>
  /** 发送中标志位 setter（handoff 发送期间置 true，结束复位） */
  setSending: (value: boolean) => void
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  clearInput: () => void
  /** 发送失败时恢复草稿到输入区 */
  restoreInput: (text: string) => void
  /** 互斥：进入 handoff 模式时退出 fork 模式（forkSource 残留指向错误 session） */
  exitForkMode: () => void
  /** handoff 编排（features 层跨 api + stores）：handleHandoffSend 调用触发 handoff（runtime agent-driven） */
  handoff: (srcSessionId: string, reply?: string, staging?: StagingConfig) => Promise<void>
  /** 取消进行中的 handoff（与 handoff 对称注入，来自 useHandoffActions）：StagingAction.abort 委托 */
  abortHandoff: (sessionId: string) => Promise<void>
  /** Staging Mode（ADR-0056）：进入暂存态（快照模型/thinking） */
  enterStagingMode: () => void
  /** Staging Mode：退出暂存态（清空快照，恢复常规态） */
  exitStagingMode: () => void
  /** Staging Mode：获取暂存配置（供 handoff 发送时透传给新 session） */
  getStagingConfig: () => StagingConfig
  // ── 跨域能力（W3 迁移：去掉 renderer import，改为 deps 注入）──
  /** i18n 翻译（原 vue-i18n useI18n → t） */
  t: (key: string, params?: Record<string, unknown>) => string
  /** handoff mode-chip 图标（原 @lucide/vue Upload） */
  handoffChipIcon: Component
  /** 错误 toast（原 useToast error） */
  toastError: (msg: string) => void
  /** 源 session 是否正在 handoff（原 useChatStore().isHandingOff；StagingAction.isInProgress 派生用） */
  isHandingOff: (sessionId: string) => boolean
  /** 源 session 是否活跃（streaming/派发中）。handoff 入口/发送双重守卫：runtime handoff
   *  需要源 session 空闲跑一个 handoff turn，pi 的 prompt 在 turn 进行中会拒绝
   *  （"Agent is already processing"，pi 源码锚点 agent-session.ts:1181，已核对实装
   *  0.84.1 dist/core/agent-session.js:833 同语义），streaming 中 handoff 必然失败——入口直接拦截 +
   *  发送时兑底（兑入口后 session 才变 active 的竞态窗口），toast 友好提示而非英文 RPC 错 */
  isSessionActive: (sessionId: string) => boolean
  /** 跨组件触发通道 signal（原 useHandoffModeChannel signal；Sidebar ⌘J 请求） */
  handoffEnterSignal: Ref<{ srcSessionId: string } | null>
}

/**
 * @param sessionId 当前 session id（null = landing 态，signal 守卫用）
 * @param deps 发送副作用依赖（含 exitForkMode 做互斥）+ 跨域能力
 */
export function useComposerHandoffMode(
  sessionId: ComputedRef<string | null>,
  deps: HandoffDeps,
): ComposerHandoffModeReturn {
  // handoff 编排经 deps 注入（Composer 从 useSidebar 取，避免本 composable 重复实例化 useSidebar）。
  const handoffAction = deps.handoff
  // 取消进行中的 handoff 同样经 deps 注入（与 handoff 对称，来自 useHandoffActions）。
  const abortHandoffAction = deps.abortHandoff

  /** handoff 模式开关：true 时 composer 顶部显 mode-chip + 视觉，发送走 handoff */
  const handoffMode = ref(false)
  /** handoff 来源：srcSessionId（handoff 出发的 session；无 fromMessageId，始终从末条 assistant 打包） */
  const handoffSource = ref<{ srcSessionId: string } | null>(null)

  function enterHandoffMode(srcSessionId: string): void {
    // 源 session streaming 中拦截：handoff turn 需要源 session 空闲，此时进入模式必然
    // 发送失败（pi 拒绝 prompt），不如入口就拦 + toast（含直接调 enterHandoffMode 的所有路径）。
    if (deps.isSessionActive(srcSessionId)) {
      deps.toastError(deps.t('panel.composer.handoffBusy'))
      return
    }
    // 互斥：进 handoff 前退出 fork 模式（避免 forkSource 残留 + 两个模式同时活跃）
    deps.exitForkMode()
    // Staging Mode（ADR-0056）：快照当前模型/thinking，进入暂存态
    deps.enterStagingMode()
    handoffSource.value = { srcSessionId }
    handoffMode.value = true
    // 聚焦输入框，让用户立即键入 focus 备注
    deps.inputRef.value?.focus?.()
  }

  function exitHandoffMode(): void {
    handoffMode.value = false
    handoffSource.value = null
    // Staging Mode：退出暂存态，chip 恢复读源 session 模型
    deps.exitStagingMode()
  }

  // 跨组件触发通道：Sidebar 全局快捷键（⌘J → enterHandoffModeFromLastAssistant）经 signal
  // 请求 Composer 进 handoff 模式。Composer 仍是 handoffMode 状态真源。
  // streaming 拦截在 enterHandoffMode 内部（单点覆盖 signal / expose 直调 / staging.enter 全部入口）。
  watch(deps.handoffEnterSignal, (req) => {
    if (!req) return
    // signal 只对当前 panel composer 生效：srcSessionId 必须是本 composer 的 session，
    // 避免双 panel 下快捷键误触发非焦点 panel 的 composer。
    if (req.srcSessionId !== sessionId.value) return
    enterHandoffMode(req.srcSessionId)
  })

  /** handoff 模式视觉 class（accent 边 + glow + accent-soft 底）；非 handoff 模式返回空串 */
  const handoffBoxClass = computed(() =>
    handoffMode.value
      ? 'handoff-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.45))] bg-[var(--accent-soft)]'
      : '',
  )

  /** handoff 模式 placeholder 文案；非 handoff 模式返回 null */
  const handoffPlaceholder = computed(() => (handoffMode.value ? deps.t('panel.composer.handoffHint') : null))

  /**
   * Esc 处理：handoff 模式下清空输入 + 退出。
   * @returns true 表示已消费（composer 聚焦时优先于全局 Esc handler）
   */
  function handleHandoffEsc(e: KeyboardEventLike): boolean {
    if (!handoffMode.value || e.key !== 'Escape') return false
    e.preventDefault?.()
    deps.clearInput()
    exitHandoffMode()
    return true
  }

  /**
   * handoff 模式发送：调 handoff(srcSessionId, text)（runtime 让源 session 跑 handoff turn 提取末条 assistant 文档到新 session）。
   * reply=text sanitize 后拼到 handoff prompt 末尾告知 agent 下一 session 关注点（用户备注）。
   * 成功后退出 handoff 模式（等 session.handoffComplete 广播跳转）；
   * 失败时 restoreInput 保草稿 + toast 反馈。
   * @param text 当前 draft（作 handoff reply 备注）
   * @returns true 表示已消费（onSend 开头短路，不走普通 send 流程）；非 handoff 模式返回 false
   */
  async function handleHandoffSend(text: string): Promise<boolean> {
    if (!handoffMode.value || !handoffSource.value) return false
    const { srcSessionId } = handoffSource.value
    // 兑底守卫（入口拦截后的竞态窗口：进入模式后 session 才变 streaming）。返回 true 已消费
    // （不走普通 send），不清草稿不退模式——回复结束后可直接重发。
    if (deps.isSessionActive(srcSessionId)) {
      deps.toastError(deps.t('panel.composer.handoffBusy'))
      return true
    }
    // reply 备注可选：空文本也允许（runtime handoff turn 无 reply 时只发 template）。空则 undefined 不传 reply。
    const reply = text.trim() || undefined
    deps.clearInput()
    deps.setSending(true)
    try {
      // Staging Mode（ADR-0056）：透传暂存的模型/thinking 配置给新 session
      const staging = deps.getStagingConfig()
      await handoffAction(srcSessionId, reply, staging)
    } catch (e) {
      // handoff 触发失败 → restoreInput 保草稿（与 fork handleForkSend 对称）
      deps.restoreInput(text)
      const msg = e instanceof Error ? e.message : String(e)
      deps.toastError(deps.t('panel.message.handoffFailed', { error: msg }))
    } finally {
      deps.setSending(false)
      // 设计选择（与 fork handleForkSend 对称）：失败时也 exitHandoffMode。
      // 用户丢失 staging context（model override chip 消失），但保持行为一致——
      // fork 失败同样 exitForkMode，避免残留在错误 staging 态。用户可重新进入 handoff 模式。
      exitHandoffMode()
    }
    return true
  }

  /**
   * { value: boolean } 包装对象（非 ref，不被 defineExpose 解包），其 value 经 getter
   * 代理到响应式 handoffMode ref，既保留响应式又对齐 vm.handoffMode.value 访问契约。
   */
  const handoffModeRef = {
    get value(): boolean {
      return handoffMode.value
    },
  }

  /**
   * 包装成 StagingAction（handoff 实现，ADR-0057）。
   *
   * adapter 层：把 handoffMode/enterHandoffMode/exitHandoffMode/handleHandoffSend/
   * handleHandoffEsc/handoffBoxClass/handoffPlaceholder 收敛为单一策略对象，
   * 供 useComposerStaging 聚合路由。与 fork 差异：handoff 有 B 阶段（isInProgress + abort）。
   */
  function asStagingAction(): StagingAction {
    return {
      type: 'handoff',
      isActive: computed(() => handoffMode.value),
      enter: (source) => {
        // source 实际是 HandoffSource（仅 srcSessionId），由 useComposerStaging.enter('handoff', source) 调用方保证。
        enterHandoffMode((source as { srcSessionId: string }).srcSessionId)
      },
      exit: () => exitHandoffMode(),
      /**
       * send 直接调 handleHandoffSend(text)，忽略传入的 staging 参数。
       * 原因：handleHandoffSend 内部已调 deps.getStagingConfig() 取模型/thinking 快照配置，
       * 其数据源与 useComposerModelThinking.getStagingConfig 相同，外部传参与内部自取等价
       * （与 fork 的 asStagingAction.send 对称）。
       */
      send: async (text) => { await handleHandoffSend(text) },
      allowsEmptySend: true,
      handleEsc: handleHandoffEsc,
      // handoff turn 在源 session 跑，isInProgress 读 deps.isHandingOff(srcSessionId)。
      // 仅在 handoffSource 有值时读（避免 landing/未进入态误判）。
      isInProgress: computed(() =>
        handoffSource.value ? deps.isHandingOff(handoffSource.value.srcSessionId) : false,
      ),
      abort: abortHandoffAction,
      visual: {
        boxClass: handoffBoxClass,
        placeholder: handoffPlaceholder,
        chipLabelKey: 'panel.composer.handoffChip',
        chipIcon: deps.handoffChipIcon,
      },
    }
  }

  return {
    handoffMode,
    handoffModeRef,
    enterHandoffMode,
    exitHandoffMode,
    handoffBoxClass,
    handoffPlaceholder,
    handleHandoffEsc,
    handleHandoffSend,
    asStagingAction,
  }
}
