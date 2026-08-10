/**
 * composer-shell.ts —— renderer 壳层 deps 组装 + 视觉派生（W4 composer-shell-integration）。
 *
 * 定位：p3-strangler-domains::composer W4 产物。替代 14 个 useComposer* shim（W2/W3 双轨期
 * 过渡产物），把 core dispatch/context/model-thinking/input 模块的跨域 deps 组装集中在此，
 * Composer.vue 只做解构 + 模板绑定（<script setup> ≤300 行约束）。
 *
 * 命名刻意避开 useComposer* 前缀（TC4 lint 残留检查不误伤；W3 教训：core exports 只暴露
 * barrel 子路径，此处 import 全走 @xyz-agent/core/domain/composer/{dispatch,context,input}）。
 *
 * deps 来源分层（AC10 零 renderer import 的反向约束——本文件是 renderer，可以 import 一切）：
 * - core 模块：useComposerModelThinking / useComposerInjection / useComposerHistory /
 *   useComposerContextChips / useComposerDragDrop / useComposerRestore / useComposerForkMode /
 *   useComposerHandoffMode / useComposerStaging / useComposerBash / useComposerSubmit / useComposerSend
 * - renderer store/composable：useChatStore / useSessionStore / useSettingsStore / useNewTaskFlow /
 *   useModel / useHandoffActions / useCompactQueue / useSidebarNew / useToast / useForkModeChannel /
 *   useHandoffModeChannel / useImageAttachment / useI18n
 *
 * 视觉派生（D1「视觉派生留壳」）：useComposerBoxClass + useComposerModeVisual 的逻辑并入本文件
 * （boxClass 三级链：staging > bash > 流式 steer 呼吸 > 聚焦 ring；placeholder 三级链：
 * staging > bash > steerHint/inputHint），删除原 2 文件（无独立复用点，仅 Composer.vue 消费）。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitFork, Upload } from '@lucide/vue'
import type { Segment } from '@xyz-agent/shared'
import { normalizeContent } from '@xyz-agent/shared'
import {
  useComposerModelThinking,
  useComposerInjection,
  useComposerContextChips,
  useComposerForkMode,
  useComposerHandoffMode,
  useComposerStaging,
  useComposerBash,
  useComposerSubmit,
  useComposerSend,
} from '@xyz-agent/core/domain/composer'
// input 域 3 个 composable 已迁 @xyz-agent/dom-core（ADR-0058）：history/dragdrop/restore
import {
  useComposerHistory,
  useComposerDragDrop,
  useComposerRestore,
} from '@xyz-agent/dom-core/composer/input'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { getSettingsStore } from '@xyz-agent/core'
import { useChat } from '@/composables/features/chat/useChat'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useModel } from '@/composables/features/model/useModel'
import { useHandoffActions } from '@/composables/features/fork-handoff/useHandoffActions'
import { useSidebarNew } from '@/composables/features/sidebar/useSidebarNew'
import { useCompactQueue } from './useCompactQueue'
import { useToast } from '@/composables/useToast'
import { useForkModeChannel } from './useForkModeChannel'
import { useHandoffModeChannel } from './useHandoffModeChannel'
import { handleImagePaste } from './useImageAttachment'
import { composerInjectionStore } from './composer-injection-store'

/**
 * ComposerInput 壳层实例契约（composer-shell 视角的完整 expose 面）。
 *
 * core 各模块（history/context-chips/send/submit/restore/fork/handoff）各自定义最小结构契约
 * （getSegments/removeImageChip 等分散在模块内），此处合并为壳层组装用的完整面——
 * ui ComposerInput.vue 的 defineExpose 同时满足所有模块契约（结构类型），
 * Composer.vue 传入的模板 ref 实例可赋值给本接口。
 */
export interface ShellInputInstance {
  clear: () => void
  focus: () => void
  getText: () => string
  getSegments: () => Segment[]
  setText: (text: string, caretPosition?: 'end' | 'start') => void
  insertTextAtCursor: (text: string) => void
  insertSlashChip: (command: string, icon?: string) => void
  insertFileChip: (path: string, lineRange?: [number, number]) => void
  insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
  removeImageChip: (chipId: string) => void
  moveCaretVertical: (dir: 'up' | 'down') => 'moved' | 'at-edge'
}

/** useComposerShell 入参：Composer.vue 组件局部状态（ref/Map 真源留在壳层） */
export interface ComposerShellParams {
  /** 当前 session id（null = landing 态） */
  sessionIdRef: ComputedRef<string | null>
  /** variant（'panel' | 'landing'，landing 分流依据） */
  variantRef: ComputedRef<'panel' | 'landing'>
  /** ComposerInput 实例 ref（expose 面消费） */
  inputRef: Ref<ShellInputInstance | null>
  /** composer-box 容器 ref（拖拽落位 + boxClass 视觉） */
  composerBoxRef: Ref<HTMLElement | null>
  /** draft ref（纯文本，发送判断 + 失败恢复） */
  draft: Ref<string>
  /** 发送中标志位（普通 send / landing 首发 / staging 发送共用） */
  isSending: Ref<boolean>
  /** per-session 草稿存储 Map（session 切换保存旧/恢复新） */
  drafts: Map<string, string>
  /** session 是否活跃（流式/派发）—— canSend/visual 守卫 */
  isActive: ComputedRef<boolean>
  /** session 是否正在压缩上下文（compact 分支守卫） */
  isCompacting: ComputedRef<boolean>
}

/**
 * 历史条目派生（替代 chatStore.getMessages 直读，core history 模块经 deps 注入）。
 * 倒序 + role==='user' + status==='complete' + 去重连续相同文本（原 shim 逻辑平移）。
 */
function deriveHistoryFromChatStore(chatStore: ReturnType<typeof useChatStore>, sid: string): string[] {
  const msgs = chatStore.getMessages(sid)
  const result: string[] = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'user' || m.status !== 'complete') continue
    const text = normalizeContent(m.content)
    if (result.length > 0 && result[result.length - 1] === text) continue
    result.push(text)
  }
  return result
}

/**
 * @param params Composer.vue 组件局部状态（ref/Map 真源）
 * @returns core 模块组装结果 + 派生状态（Composer.vue 解构消费）
 */
export function useComposerShell(params: ComposerShellParams) {
  const { sessionIdRef, variantRef, inputRef, composerBoxRef, draft, isSending, drafts, isActive, isCompacting } = params
  const { t } = useI18n()
  const chatStore = useChatStore()
  const sessionStore = useSessionStore()
  const settingsStore = getSettingsStore()
  const flow = useNewTaskFlow()
  const { error: toastError } = useToast()
  const { send, steer, followUp, abort, compact, sendBash } = useChat()
  const { handoff: handoffAction, abortHandoff: abortHandoffAction } = useHandoffActions(sessionIdRef)
  const { switchModel, setThinkingLevel } = useModel()
  const compactQueue = useCompactQueue()
  const sidebar = useSidebarNew()
  const { signal: forkEnterSignal } = useForkModeChannel()
  const { signal: handoffEnterSignal } = useHandoffModeChannel()

  // ── 模型 + 思考等级（core model-thinking；含 landing 延迟 apply + staging 快照）──
  const {
    currentModelId,
    currentThinkingLevel,
    currentThinkingLevelMap,
    localThinkingLevel,
    onModelSelect,
    onThinkingSelect,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
  } = useComposerModelThinking(sessionIdRef, {
    getSessionState: (sid: string) => {
      const s = sessionStore.list.find((x) => x.id === sid)
      if (!s) return null
      return { modelId: s.modelId, thinkingLevel: s.thinkingLevel }
    },
    defaultModel: computed(() => settingsStore.defaultModel.value),
    currentModel: flow.currentModel,
    setPendingModel: (model: string) => flow.setPendingModel(model),
    switchModel,
    setThinkingLevel,
    getThinkingLevelMap: (modelId: string) => {
      // 旧版守卫：无 '/' 的 modelId（如空串/非完整模型 id）直接返回 undefined（all-levels），
      // 不碰 providers（测试 mock 的 settingsStore 可能无 providers）。
      if (!modelId.includes('/')) return undefined
      const [providerId, modelName] = modelId.split('/')
      const provider = settingsStore.providers?.value?.find((p: { id: string }) => p.id === providerId)
      return provider?.models.find((m: { id: string }) => m.id === modelName)?.thinkingLevelMap
    },
  })

  // ── 上下文注入消费（side-effect：watch pendingInjection 路由；target=new 触发 startFlow）──
  useComposerInjection(inputRef, sessionIdRef, variantRef, {
    injectionStore: composerInjectionStore,
    startFlow: (cwd?: string) => flow.startFlow(cwd),
    getSessionCwd: (sid: string) => sessionStore.list.find((s) => s.id === sid)?.cwd ?? undefined,
    getActiveSessionId: () => sessionStore.active?.id ?? null,
  })

  // ── 输入历史导航（↑/↓ shell 风格，core input/history）──
  const { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsing } = useComposerHistory(sessionIdRef, {
    getText: () => inputRef.value?.getText() ?? '',
    setText: (text, caretPosition) => inputRef.value?.setText(text, caretPosition),
    clear: () => inputRef.value?.clear(),
    getHistoryEntries: (sid: string) => deriveHistoryFromChatStore(chatStore, sid),
  })

  // ── 已附上下文 chip 行（core context/context-chips）──
  const { attachedItems, refreshAttachedItems, onRemoveContextChip } = useComposerContextChips(inputRef)

  // ── composer-box 拖拽落位（core input/dragdrop；pasteImage 注入 handleImagePaste）──
  const { onDragOver, onDragLeave, onDrop } = useComposerDragDrop(inputRef, composerBoxRef, refreshAttachedItems, sessionIdRef, {
    pasteImage: handleImagePaste,
  })

  // ── 发送后清空 / 失败恢复（core input/restore）──
  const { clearInput, restoreInput, restoreSegments } = useComposerRestore({
    draft,
    inputRef,
    drafts,
    sessionId: sessionIdRef,
  })

  // ── Fork 提问模式（core dispatch/fork-mode）──
  const fork = useComposerForkMode(sessionIdRef, {
    inputRef,
    setSending: (value: boolean) => { isSending.value = value },
    clearInput,
    restoreInput,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
    t: t as (key: string, params?: Record<string, unknown>) => string,
    forkChipIcon: GitFork,
    forkSessionAsk: sidebar.forkSessionAsk,
    toastError,
    forkEnterSignal,
  })

  // ── Handoff 模式（core dispatch/handoff-mode；互斥：进 handoff 前退出 fork）──
  const handoff = useComposerHandoffMode(sessionIdRef, {
    inputRef,
    setSending: (value: boolean) => { isSending.value = value },
    clearInput,
    restoreInput,
    exitForkMode: fork.exitForkMode,
    handoff: (srcSessionId, reply, staging) => handoffAction(srcSessionId, reply, staging),
    abortHandoff: (sessionId) => abortHandoffAction(sessionId),
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
    t: t as (key: string, params?: Record<string, unknown>) => string,
    handoffChipIcon: Upload,
    toastError,
    isHandingOff: (sid: string) => chatStore.isHandingOff(sid),
    handoffEnterSignal,
  })

  // ── Staging 聚合路由（core dispatch/staging，ADR-0057）──
  const staging = useComposerStaging({
    fork: fork.asStagingAction(),
    handoff: handoff.asStagingAction(),
  })

  const hasInput = computed(() => draft.value.trim().length > 0)

  // ── bash 命令模式（core dispatch/bash；sendBash 注入）──
  const composerBash = useComposerBash({
    draft,
    clearInput,
    isSending,
    sessionId: () => sessionIdRef.value,
    sendBash,
  })
  const isBashMode = composerBash.isBashMode

  // ── 提交动作（core dispatch/submit）──
  const { onSteer, onFollowUp, onAbort } = useComposerSubmit({
    hasInput,
    isActive,
    draft,
    inputRef,
    sessionIdRef,
    clearInput,
    restoreInput,
    steer,
    followUp,
    abort,
  })

  /** 忙时（流式/派发/发送中）—— canSend 共用守卫（不含 isCompacting：压缩期允许排队） */
  const isBusy = computed(() => isActive.value || isSending.value)
  const canSend = computed(() => hasInput.value && !isBusy.value)
  /** 可提交：有输入，或当前 staging 允许空发送（fork/handoff 空 composer 直接提交 ≈ 后台操作）。
   *  canSend 只看 hasInput；staging allowsEmptySend=true 时即使 draft 为空也放行发送按钮。 */
  const canSubmit = computed(() =>
    canSend.value || (!!staging.activeStaging.value?.allowsEmptySend && !isBusy.value),
  )

  // ── 视觉派生（原 useComposerBoxClass + useComposerModeVisual 合并，D1 留壳）──
  const stagingBoxClass = computed(() => staging.activeStaging.value?.visual.boxClass.value ?? '')
  const stagingPlaceholder = computed(() => staging.activeStaging.value?.visual.placeholder.value ?? null)
  /** composer-box class 三级链：staging > bash（accent 边 + ring）> 流式 steer 呼吸 > 聚焦 ring；发送中叠半透明 */
  const boxClass = computed<Array<string | false>>(() => [
    stagingBoxClass.value
      || (isBashMode.value
        ? 'composer-bash-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.30))]'
        : isActive.value
          ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)]'
          : hasInput.value
            ? 'border-[var(--border-strong)] shadow-[0_0_0_2px_rgba(255,255,255,0.04)]'
            : ''),
    isSending.value && 'opacity-[0.55]',
  ])
  /** placeholder 三级链：staging > bash > 流式 steerHint / 普通 inputHint */
  const placeholder = computed(
    () =>
      stagingPlaceholder.value
      ?? (isBashMode.value
        ? t('panel.composer.bashPlaceholder')
        : isActive.value
          ? t('panel.composer.steerHint')
          : t('panel.composer.inputHint')),
  )

  // ── 发送分流（core dispatch/send；staging > compact > landing > bash > /compact > send）──
  const { onSend } = useComposerSend({
    staging: { hasActiveStaging: staging.hasActiveStaging, send: staging.send, activeStaging: staging.activeStaging },
    getStagingConfig,
    canSend,
    isBusy,
    isCompacting,
    draft,
    inputRef,
    sessionIdRef,
    variantRef,
    composerBash: { extractBashCommand: composerBash.extractBashCommand, trySendBash: composerBash.trySendBash },
    clearInput,
    restoreSegments,
    isSending,
    flow,
    localThinkingLevel,
    send,
    compact,
    enqueueCompact: (sessionId: string, text: string) => compactQueue.enqueue(sessionId, text),
    toastError,
    t: t as (key: string, params?: Record<string, unknown>) => string,
  })

  return {
    // model-thinking
    currentModelId,
    currentThinkingLevel,
    currentThinkingLevelMap,
    localThinkingLevel,
    onModelSelect,
    onThinkingSelect,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
    // history
    handleArrowUp,
    handleArrowDown,
    resetBrowsing,
    isBrowsing,
    // context chips
    attachedItems,
    refreshAttachedItems,
    onRemoveContextChip,
    // dragdrop
    onDragOver,
    onDragLeave,
    onDrop,
    // restore
    clearInput,
    restoreInput,
    restoreSegments,
    // fork / handoff / staging
    fork,
    handoff,
    staging,
    // bash
    composerBash,
    isBashMode,
    // submit
    onSteer,
    onFollowUp,
    onAbort,
    // send
    onSend,
    // 派生状态
    hasInput,
    isBusy,
    canSend,
    canSubmit,
    // 视觉
    boxClass,
    placeholder,
  }
}

export type ComposerShellReturn = ReturnType<typeof useComposerShell>
// Segment 类型 re-export（Composer.vue 发送/恢复链路消费）
export type { Segment }
