<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    v1 主路径 4 态：
      S1 空 → S2 输入中 → S5 发送中（spinner）→ S6 流式中（stop + steer/followUp）
    DEFERRED：
      S3/S4（@/#// 附件浮层 G2-002）、S7-S9 双队列视图/失败回退/已排队多条。
    steer/followUp：活跃态（isGenerating/派发空窗期）时 ⏎ 追加 steer，Alt+⏎ 追加 followUp，都不打断当前回合。
  -->
  <div class="composer" :class="props.variant === 'landing' ? 'mx-auto w-full max-w-[720px]' : ''">
    <!-- retry/queue 指示位（spec C10，#13，composer 上方独立行）：
         auto_retry_end / message_start 到达时 store 自动清 → state=undefined → 组件 v-if 消失 -->
    <RetryIndicator :state="retryState" />
    <QueueBubble :state="queueState" />
    <!-- compact 待发队列 badge（W2：compaction 期间入队消息预览 + 逐条取消）。
         v-if count>0 自隐藏（flush 成功/队列取消后消失），QueueBubble 旁独立行 -->
    <CompactQueueBadge :session-id="sessionId" />
    <!-- 命令浮层（§2d @/#//）：anchor = composer-box（slot），reka-ui Popover portal body。
         composer-box 内 focus 算 inside 不触发 dismiss，键盘路由见 onKeydown -->
    <CommandPopover
      ref="commandPopoverRef"
      v-model:open="cmdOpen"
      :type="cmdType"
      :session-id="sessionId ?? undefined"
      :variant="variant"
      :project-skills="landingProjectSkills"
      :global-skills="landingGlobalSkills"
      :query="cmdType === 'file' ? fileQuery : slashQuery"
      @select="onCmdSelect"
    >
      <div
        ref="composerBoxRef"
        class="composer-box relative rounded-lg border bg-bg-input"
        :class="boxClass"
        data-testid="composer-box"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <!-- Staging 模式标识 chip（fork/handoff 统一）：顶部 accent chip 提示当前 staging 类型 + × 退出。
             经 useComposerStaging.activeStaging 统一渲染（ADR-0044），退出调 staging.exit() -->
        <div
          v-if="staging.activeStaging.value"
          class="composer-mode-chip mx-2.5 mt-2 flex items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--accent)]"
          :data-testid="staging.activeStaging.value.type === 'fork' ? 'composer-mode-chip' : 'composer-handoff-chip'"
        >
          <component :is="staging.activeStaging.value.visual.chipIcon" class="size-3" />
          <span class="flex-1">{{ t(staging.activeStaging.value.visual.chipLabelKey) }}</span>
          <Button
            variant="ghost"
            size="icon"
            class="size-4 rounded-sm p-0 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white"
            :title="staging.activeStaging.value.type === 'fork' ? t('panel.composer.forkExit') : t('panel.composer.handoffExit')"
            @click="staging.exit"
          >
            <X class="size-3" />
          </Button>
        </div>
        <!-- 顶部元信息行 slot（landing 态：directory/branch chip；panel 态留空） -->
        <slot name="meta-row" />
        <!-- 已附上下文 chip 行（§2f）。W4：从 segments 派生 image chips，× 删除定位 DOM 节点移除 -->
        <ContextChipsBar :items="attachedItems" @remove="onRemoveContextChip" />
        <!-- 输入区：contenteditable 富文本（draft §1/§2e，支持 slash chip 与 @/# mention 内联） -->
        <ComposerInput
          ref="inputRef"
          :placeholder="placeholder"
          :disabled="isSending"
          :session-id="sessionId"
          @input="onInputChange"
          @keydown="onKeydown"
          @slash-trigger="onSlashTrigger"
          @file-trigger="onFileTrigger"
        />

      <!-- 工具条（panel/spec §composer line 51）：上下文/模型/thinking-level 展示型 + 发送位三态。
           gap-0：三触发器贴合紧凑成一条工具带（draft「不画分隔线」，仅靠 padding 区隔），发送位 ml-1.5 独立锚点。 -->
      <div class="composer-bar flex flex-wrap items-center justify-end gap-0 px-2.5 pb-2 mt-1">
        <!-- + 添加内容（左锚定，spec §1 ①，click 出浮层：附件 / 命令；# 文件改走 inline 触发） -->
        <AddMenuPopover @select="onAddSelect" />
        <span class="flex-1" />
        <!-- 上下文容量（spec §2a：hover 出容量 popover；session 通道订阅 context.update） -->
        <ContextCapacityPopover :session-id="sessionId ?? undefined" :model-id="currentModelId" />
        <!-- 模型（spec §2b：click 出模型切换 popover） -->
        <ModelSelectPopover :selected="currentModelId" @select="onModelSelect" />
        <!-- 思考等级（spec §2c：click 出 6 级 popover；level 从 session 透传） -->
        <ThinkingLevelPopover :level="currentThinkingLevel" :level-map="currentThinkingLevelMap" @select="onThinkingSelect" />

        <!-- 发送位三态：S6 streaming/dispatching→stop / S5 sending→spinner / compact→queue-send（可点，入队待重放）/ S1·S2 idle→send -->
        <Button
          v-if="isActive"
          variant="ghost"
          size="icon"
          class="stop-btn ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-surface-hover text-neutral-mid hover:bg-danger-soft hover:text-danger"
          :title="t('panel.composer.stop')"
          @click="onStopClick"
        >
          <Square class="size-[13px]" />
        </Button>
        <Button
          v-else-if="isCompacting"
          variant="default"
          size="icon"
          class="ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-[var(--accent)] text-white transition-colors enabled:hover:bg-[var(--accent-hover)] disabled:bg-transparent disabled:text-[var(--neutral-dim)]"
          :disabled="!canSend"
          :title="canSend ? t('panel.composer.queueSend') : t('panel.composer.sendHint')"
          @click="onSend"
        >
          <ArrowUp class="size-[15px]" />
        </Button>
        <div
          v-else-if="isSending"
          class="ml-1.5 grid size-[var(--composer-btn-size)] place-items-center rounded-md bg-[var(--accent)] text-white"
          :title="t('panel.composer.sending')"
        >
          <Loader2 class="size-4 animate-spin" />
        </div>
        <Button
          v-else
          variant="default"
          size="icon"
          class="ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-[var(--accent)] text-white transition-colors enabled:hover:bg-[var(--accent-hover)] disabled:bg-transparent disabled:text-[var(--neutral-dim)]"
          :disabled="!canSend"
          :title="canSend ? `${staging.activeStaging.value ? (staging.activeStaging.value.type === 'fork' ? t('panel.composer.forkSend') : t('panel.composer.handoffSend')) : t('panel.composer.send')} · ⏎` : t('panel.composer.sendHint')"
          @click="onSend"
        >
          <ArrowUp class="size-[15px]" />
        </Button>
      </div>
    </div>
    </CommandPopover>

  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Loader2, Square, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import ComposerInput from './ComposerInput.vue'
import AddMenuPopover from './AddMenuPopover.vue'
import CommandPopover from './CommandPopover.vue'
import ContextCapacityPopover from './ContextCapacityPopover.vue'
import ModelSelectPopover from './ModelSelectPopover.vue'
import ThinkingLevelPopover from './ThinkingLevelPopover.vue'
import ContextChipsBar from './ContextChipsBar.vue'
import RetryIndicator from './RetryIndicator.vue'
import QueueBubble from './QueueBubble.vue'
import CompactQueueBadge from './CompactQueueBadge.vue'
import { useChat } from '@/composables/features/useChat'
import { useHandoffActions } from '@/composables/features/useHandoffActions'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useProjectSkills, useGlobalSkills } from '@/composables/features/useProjectSkills'
import { useChatStore } from '@/stores/chat'
import { useToast } from '@/composables/useToast'
import { useComposerModelThinking } from '@/composables/panel/useComposerModelThinking'
import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'
import { useComposerInjection } from '@/composables/panel/useComposerInjection'
import { useComposerHistory } from '@/composables/panel/useComposerHistory'
import { useComposerForkMode } from '@/composables/panel/useComposerForkMode'
import { useComposerContextChips } from '@/composables/panel/useComposerContextChips'
import { useComposerDragDrop } from '@/composables/panel/useComposerDragDrop'
import { useComposerRestore } from '@/composables/panel/useComposerRestore'
import { useComposerSubmit } from '@/composables/panel/useComposerSubmit'
import { useComposerSend } from '@/composables/panel/useComposerSend'
import { useComposerHandoffMode } from '@/composables/panel/useComposerHandoffMode'
import { useComposerStaging } from '@/composables/panel/useComposerStaging'
import { useComposerModeVisual } from '@/composables/panel/useComposerModeVisual'
import { useComposerBash } from '@/composables/panel/useComposerBash'

const props = withDefaults(
  defineProps<{
    sessionId: string | null
    variant?: 'panel' | 'landing'
  }>(),
  { variant: 'panel' },
)

const { t } = useI18n()
const chatStore = useChatStore()
const { send, steer, followUp, abort, compact } = useChat()
const flow = useNewTaskFlow()
const { error: toastError } = useToast()
const { projectSkills: landingProjectSkills } = useProjectSkills(flow.currentCwd) // W3 ADR-0038：landing 当前 cwd 项目 skill
const { globalSkills: landingGlobalSkills } = useGlobalSkills() // W4 FR-5：landing 全局 skill
const isActive = computed(() => {
  if (!props.sessionId) return false
  return chatStore.isActive(props.sessionId)
})

// handoff 编排真源：直接 import useHandoffActions（不实例化 useSidebar，避免全量依赖链：session.list
// broadcast listener、10+ store、fork actions 等）。focusedSessionId 用于 lastAssistantOfFocused（⌘H
// 全局快捷键），此处 Composer 只用 handoff/abortHandoff（显式传 sessionId），focusedSessionId 用
// computed 派生即可（与 useSidebar 内部 focusedSessionId 等价）。
const { handoff: handoffAction, abortHandoff: abortHandoffAction } = useHandoffActions(computed(() => props.sessionId))

// 模型 + 思考等级状态（含 landing 态延迟 apply）—— 见 useComposerModelThinking
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
} = useComposerModelThinking(computed(() => props.sessionId))

/** #13 retry/queue 指示位数据源（store 由 W0/#8 维护，不可变 Map 更新触发响应） */
const retryState = computed(() => (props.sessionId ? chatStore.getRetryState(props.sessionId) : undefined))
const queueState = computed(() => (props.sessionId ? chatStore.getQueueState(props.sessionId) : undefined))
const draft = ref('')
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)

const sessionIdRef = computed(() => props.sessionId)
const {
  cmdOpen,
  cmdType,
  slashQuery,
  fileQuery,
  commandPopoverRef,
  onSlashTrigger,
  onFileTrigger,
  onAddSelect,
  onCmdSelect,
} = useCommandPopoverTrigger(inputRef, sessionIdRef)
// drawer 选区/文件引用注入消费（跨组件树一次性消息通道）
useComposerInjection(inputRef, sessionIdRef, computed(() => props.variant))

// 输入历史导航（↑/↓ shell 风格）—— 见 useComposerHistory
const { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsing } = useComposerHistory(
  sessionIdRef,
  {
    getText: () => inputRef.value?.getText() ?? '',
    setText: (text, caretPosition) => inputRef.value?.setText(text, caretPosition),
    clear: () => inputRef.value?.clear(),
  },
)

// FR4: per-session 草稿存储（内存不持久化）；session 切换时保存旧/恢复新草稿
const drafts = new Map<string, string>()
watch(
  () => props.sessionId,
  (newId, oldId) => {
    if (oldId) {
      // browsing 态 getText() 返回历史条目，存用户实际输入
      drafts.set(oldId, isBrowsing.value ? (draft.value || '') : (inputRef.value?.getText() ?? ''))
    }
    // 切 session 退出活跃 staging 模式（fork/handoff），避免来源残留指向错误 session
    staging.exit()
    resetBrowsing()
    if (newId) {
      const saved = drafts.get(newId)
      if (saved) {
        draft.value = saved
        inputRef.value?.setText(saved, 'end')
      } else {
        draft.value = ''
        inputRef.value?.clear()
      }
    }
  },
)

const isSending = ref(false)
/** 当前 panel 的 session 是否正在压缩上下文（#6，per-session） */
const isCompacting = computed(() => (props.sessionId ? chatStore.isCompacting(props.sessionId) : false))

/** ComposerInput input 事件 → 维护 draft（纯文本，用于发送判断）+ 刷新 image chips */
function onInputChange(text: string): void {
  draft.value = text
  refreshAttachedItems()
  // 用户修改了内容，重置浏览历史状态（下次按上重新从最后一条开始）
  resetBrowsing()
}

// 顶部「已附上下文」chip 行（ContextChipsBar 数据源 + × 删除回调）——见 useComposerContextChips
const { attachedItems, refreshAttachedItems, onRemoveContextChip } = useComposerContextChips(inputRef)

// composer-box 拖拽落位（拖入图片 → image segment，复用 slice4 handleImagePaste）——见 useComposerDragDrop
const composerBoxRef = ref<HTMLElement | null>(null)
const { onDragOver, onDragLeave, onDrop } = useComposerDragDrop(inputRef, composerBoxRef, refreshAttachedItems, sessionIdRef)

// 发送后清空 / 失败恢复（clearInput / restoreInput / restoreSegments）——见 useComposerRestore
const { clearInput, restoreInput, restoreSegments } = useComposerRestore({
  draft,
  inputRef,
  drafts,
  sessionId: sessionIdRef,
})

// Fork 提问模式（FR-13/14/15）—— 见 useComposerForkMode
const fork = useComposerForkMode(sessionIdRef, {
  inputRef,
  setSending: (value) => { isSending.value = value },
  clearInput,
  restoreInput,
  enterStagingMode,
  exitStagingMode,
  getStagingConfig,
})

// Handoff 模式（fast-handoff）—— 见 useComposerHandoffMode。复用上方 setup 顶部同步取到的 handoffAction。
const handoff = useComposerHandoffMode(sessionIdRef, {
  inputRef,
  setSending: (value) => { isSending.value = value },
  clearInput,
  restoreInput,
  // 互斥：进 handoff 前退出 fork（保留原 deps.exitForkMode；进入 fork 时互斥由 useComposerStaging.enter 编排）
  exitForkMode: fork.exitForkMode,
  handoff: (srcSessionId, reply, staging) => handoffAction(srcSessionId, reply, staging),
  abortHandoff: (sessionId) => abortHandoffAction(sessionId),
  enterStagingMode,
  exitStagingMode,
  getStagingConfig,
})

// Composer Staging 聚合路由（ADR-0044）：fork/handoff 各自包装成 StagingAction，经 useComposerStaging
// 统一编排 activeStaging + 互斥 enter + send/handleEsc/abortIfInProgress 路由。消除原散落的双向 watch +
// onSend 分流 if-else。
const staging = useComposerStaging({
  fork: fork.asStagingAction(),
  handoff: handoff.asStagingAction(),
})

const hasInput = computed(() => draft.value.trim().length > 0)

// bash 命令模式（composer-bash-execute）：isBashMode + trySendBash 分流提取到 useComposerBash
const composerBash = useComposerBash({
  draft, clearInput, isSending,
  sessionId: () => props.sessionId,
})
const isBashMode = composerBash.isBashMode

// 提交动作（steer / followUp / abort）—— 见 useComposerSubmit。onSend 留组件内（fork/landing/compact 分支多）
const { onSteer, onFollowUp, onAbort } = useComposerSubmit({
  hasInput, isActive, draft, inputRef, sessionIdRef,
  clearInput, restoreInput, steer, followUp, abort,
})

/**
 * stop 按钮点击：先尝试取消进行中的 staging 操作（handoff inflight），否则普通 LLM turn abort。
 * 在 Composer 包一层而非改 useComposerSubmit——避免影响其他消费方（onAbort 语义保持「取消 LLM turn」）。
 */
async function onStopClick(): Promise<void> {
  // staging 操作进行中（handoff inflight）→ 取消 staging（abortHandoff 乐观清 handingOff + RPC 中断）
  if (props.sessionId && await staging.abortIfInProgress(props.sessionId)) return
  // 否则普通 LLM turn abort
  await onAbort()
}

/** 忙时（流式/派发/发送中）—— canSend 与 canHandoffSend 共用，避免重复守卫。
 *  不含 isCompacting：压缩期间允许排队动作（canSend = hasInput，onSend 守卫放行到 compact 分支）。 */
const isBusy = computed(() => isActive.value || isSending.value)
const canSend = computed(() => hasInput.value && !isBusy.value)

// composer-box 视觉派生（boxClass / placeholder：staging 活跃 > bash > 默认）—— 见 useComposerModeVisual。
// staging 视觉从 activeStaging.visual 派生（非活跃回退空串/null），让 useComposerModeVisual 不再感知 fork/handoff 具体类型。
const { boxClass, placeholder } = useComposerModeVisual({
  stagingBoxClass: computed(() => staging.activeStaging.value?.visual.boxClass.value ?? ''),
  stagingPlaceholder: computed(() => staging.activeStaging.value?.visual.placeholder.value ?? null),
  isActive,
  hasInput,
  isSending,
  isBashMode,
})
/** 发送分流（onSend）—— staging > compact（压缩期入队） > landing（含 bash 检测）> bash(!/!!) > /compact > send。见 useComposerSend */
const { onSend } = useComposerSend({
  staging: { hasActiveStaging: staging.hasActiveStaging, send: staging.send, activeStaging: staging.activeStaging },
  getStagingConfig,
  canSend, isBusy, isCompacting,
  draft, inputRef,
  sessionIdRef, variantRef: computed(() => props.variant),
  composerBash,
  clearInput, restoreSegments,
  isSending,
  flow, localThinkingLevel,
  send, compact,
  toastError, t,
})

/** 键盘：⏎ 发送/steer，Alt+⏎ follow-up，⇧⏎ 换行，↑/↓ 翻历史。命令浮层 open 时优先路由到浮层。 */
function onKeydown(e: KeyboardEvent): void {
  if (cmdOpen.value && commandPopoverRef.value?.handleKeydown(e)) return
  if (e.isComposing) return // IME 组合中不拦截（与 useContenteditableInput 守卫一致）
  // Staging Esc 路由：经 useComposerStaging.handleEsc → activeStaging.handleEsc（fork/handoff 互斥下不会同时活跃）
  if (staging.handleEsc(e)) return
  // shift/ctrl/alt/meta + 方向键是选区扩展/按词移动/段首段尾跳转，放行原生行为（不拦截）
  const bareArrow = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  if (bareArrow && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    const dir = e.key === 'ArrowUp' ? 'up' : 'down'
    if (inputRef.value?.moveCaretVertical(dir) === 'moved') return
    if (dir === 'up') handleArrowUp()
    else handleArrowDown()
    return
  }
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  if (e.altKey) {
    // Alt+⏎：压缩期间重路由到 onSend（入队待重放）——onFollowUp 无 isActive 守卫，
    // 直通会走 pi followUp RPC 留陈旧队列。非压缩态保持 followUp。
    if (isCompacting.value) onSend()
    else onFollowUp()
  } else if (isActive.value) {
    onSteer()
  } else {
    onSend()
  }
}

// Fork/Handoff 模式 API 暴露：modeRef 是 {value} 包装对象（非 ref 不被 defineExpose 解包）
defineExpose({
  forkMode: fork.forkModeRef,
  enterForkMode: fork.enterForkMode,
  exitForkMode: fork.exitForkMode,
  handoffMode: handoff.handoffModeRef,
  enterHandoffMode: handoff.enterHandoffMode,
  exitHandoffMode: handoff.exitHandoffMode,
})
</script>

