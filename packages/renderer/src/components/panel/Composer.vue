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
        <!-- Fork 模式标识 chip（FR-13）：顶部 accent chip 提示「将发到新分支 · 与主线隔离」+ × 退出 -->
        <div
          v-if="fork.forkMode.value"
          class="composer-mode-chip mx-2.5 mt-2 flex items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--accent)]"
          data-testid="composer-mode-chip"
        >
          <GitFork class="size-3" />
          <span class="flex-1">{{ t('panel.composer.forkChip') }}</span>
          <Button
            variant="ghost"
            size="icon"
            class="size-4 rounded-sm p-0 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white"
            :title="t('panel.composer.forkExit')"
            @click="fork.exitForkMode"
          >
            <X class="size-3" />
          </Button>
        </div>
        <!-- Handoff 模式标识 chip（fast-handoff）：顶部 accent chip 提示「将交接到新 session」+ × 退出 -->
        <div
          v-if="handoff.handoffMode.value"
          class="composer-mode-chip mx-2.5 mt-2 flex items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--accent)]"
          data-testid="composer-handoff-chip"
        >
          <Upload class="size-3" />
          <span class="flex-1">{{ t('panel.composer.handoffChip') }}</span>
          <Button
            variant="ghost"
            size="icon"
            class="size-4 rounded-sm p-0 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white"
            :title="t('panel.composer.handoffExit')"
            @click="handoff.exitHandoffMode"
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

        <!-- 发送位三态：S6 streaming/dispatching→stop / S5 sending→spinner / S1·S2 idle→send -->
        <Button
          v-if="isActive"
          variant="ghost"
          size="icon"
          class="stop-btn ml-1.5 size-[30px] rounded-md bg-surface-hover text-muted hover:bg-danger-soft hover:text-danger"
          :title="t('panel.composer.stop')"
          @click="onAbort"
        >
          <Square class="size-[13px]" />
        </Button>
        <div
          v-else-if="isCompacting"
          class="ml-1.5 grid size-[30px] place-items-center rounded-md bg-surface-hover text-muted"
          :title="t('panel.composer.compacting')"
        >
          <Loader2 class="size-4 animate-spin" />
        </div>
        <div
          v-else-if="isSending"
          class="ml-1.5 grid size-[30px] place-items-center rounded-md bg-[var(--accent)] text-white"
          :title="t('panel.composer.sending')"
        >
          <Loader2 class="size-4 animate-spin" />
        </div>
        <Button
          v-else
          variant="default"
          size="icon"
          class="ml-1.5 size-[30px] rounded-md bg-[var(--accent)] text-white transition-colors enabled:hover:bg-[var(--accent-hover)] disabled:bg-transparent disabled:text-[var(--subtle)]"
          :disabled="!canSend"
          :title="canSend ? `${fork.forkMode.value ? t('panel.composer.forkSend') : handoff.handoffMode.value ? t('panel.composer.handoffSend') : t('panel.composer.send')} · ⏎` : t('panel.composer.sendHint')"
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
import { ArrowUp, Loader2, Square, X, GitFork, Upload } from '@lucide/vue'
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
import { useChat } from '@/composables/features/useChat'
import { useSidebar } from '@/composables/features/useSidebar'
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
import { useComposerHandoffMode } from '@/composables/panel/useComposerHandoffMode'
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

// handoff 编排真源：setup 同步取一次（对齐 fork 模式 useComposerForkMode.ts:61）。不能在 deps.handoff
// 闭包内「发送时才调」useSidebar()——handleHandoffSend 是 async，闭包在 await 后微任务里调 useSidebar()
// 无 active effect scope → onScopeDispose 不注册 → session.list 订阅 refCount 泄漏（违反 CLAUDE.md 规则 #2）。
const { handoff: handoffAction } = useSidebar()

// 模型 + 思考等级状态（含 landing 态延迟 apply）—— 见 useComposerModelThinking
const {
  currentModelId,
  currentThinkingLevel,
  currentThinkingLevelMap,
  localThinkingLevel,
  onModelSelect,
  onThinkingSelect,
} = useComposerModelThinking(computed(() => props.sessionId))

/** #13 retry/queue 指示位数据源（store 由 W0/#8 维护，不可变 Map 更新触发响应） */
const retryState = computed(() => (props.sessionId ? chatStore.getRetryState(props.sessionId) : undefined))
const queueState = computed(() => (props.sessionId ? chatStore.getQueueState(props.sessionId) : undefined))
const draft = ref('')
/** ComposerInput 实例 ref：清空/恢复草稿用 */
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)

// 命令浮层触发态机 —— 见 useCommandPopoverTrigger
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
    // 切 session 退出 fork/handoff 模式，避免来源残留指向错误 session
    if (fork.forkMode.value) fork.exitForkMode()
    if (handoff.handoffMode.value) handoff.exitHandoffMode()
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
})

// Handoff 模式（fast-handoff）—— 见 useComposerHandoffMode。与 fork 互斥。复用上方 setup 顶部同步取到的 handoffAction。
const handoff = useComposerHandoffMode(sessionIdRef, {
  inputRef,
  setSending: (value) => { isSending.value = value },
  clearInput,
  restoreInput,
  exitForkMode: fork.exitForkMode,
  handoff: (srcSessionId, focus) => handoffAction(srcSessionId, focus),
})
// 双向互斥（fork↔handoff）两处落点：① 这里 watch 进 fork 退 handoff（fork composable 不感知 handoff）；
// ② useComposerHandoffMode.enterHandoffMode 内进 handoff 退 fork（见 deps.exitForkMode）。
watch(() => fork.forkMode.value, (isFork) => {
  if (isFork && handoff.handoffMode.value) handoff.exitHandoffMode()
})

const hasInput = computed(() => draft.value.trim().length > 0)

// bash 命令模式（composer-bash-execute）：isBashMode + trySendBash 分流提取到 useComposerBash
const composerBash = useComposerBash({
  draft, clearInput, restoreInput, isSending,
  sessionId: () => props.sessionId,
})
const isBashMode = composerBash.isBashMode

// 提交动作（steer / followUp / abort）—— 见 useComposerSubmit。onSend 留组件内（fork/landing/compact 分支多）
const { onSteer, onFollowUp, onAbort } = useComposerSubmit({
  hasInput, isActive, draft, inputRef, sessionIdRef,
  clearInput, restoreInput, steer, followUp, abort,
})

/** 忙时（流式/派发/发送中/压缩中）—— canSend 与 canHandoffSend 共用，避免重复守卫 */
const isBusy = computed(() => isActive.value || isSending.value || isCompacting.value)
const canSend = computed(() => hasInput.value && !isBusy.value)

// composer-box 视觉派生（boxClass / placeholder 四级链：fork > handoff > bash > 默认）—— 见 useComposerModeVisual
const { boxClass, placeholder } = useComposerModeVisual({
  forkBoxClass: fork.forkBoxClass,
  handoffBoxClass: handoff.handoffBoxClass,
  forkPlaceholder: fork.forkPlaceholder,
  handoffPlaceholder: handoff.handoffPlaceholder,
  isActive,
  hasInput,
  isSending,
  isBashMode,
})

/** 发送分流（优先级）：fork > handoff > landing > bash(!/!!) > /compact > send */
async function onSend(): Promise<void> {
  // handoff 模式允许空输入；忙时一律拦截（isBusy 复用 canSend 同守卫）。模式发送：同步守卫开关再 await。
  const canHandoffSend = handoff.handoffMode.value && !isBusy.value
  if (!canSend.value && !canHandoffSend) return
  const text = draft.value
  if (fork.forkMode.value && await fork.handleForkSend(text)) return
  if (handoff.handoffMode.value && await handoff.handleHandoffSend(text)) return
  if (props.variant === 'landing') {
    // 先快照 segments（clearInput 会清空 DOM）；landing 态 sessionId 可能是公共 id，用 variant 判定
    const segments = inputRef.value?.getSegments() ?? []
    clearInput()
    isSending.value = true
    try {
      await flow.submitFirstMessage(segments, localThinkingLevel.value)
    } catch (e) {
      // W8：恢复 text + image/skill/file chip（原 restoreInput(text) 只恢复纯文本，
      // chip 被拍平成字面量路径，用户粘的图丢失可视化）。详见 restoreSegments。
      restoreSegments(segments)
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('panel.panel.taskFailed', { error: msg }))
    } finally {
      isSending.value = false
    }
    return
  }
  const trimmed = text.trim()
  // bash 分流（!/!! 前缀，见 useComposerBash）：必须在 fork/handoff/landing 后、/compact 前
  if (await composerBash.trySendBash(text)) return
  if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
    const customInstructions = trimmed.startsWith('/compact ')
      ? trimmed.slice('/compact '.length).trim() || undefined
      : undefined
    clearInput()
    await compact(props.sessionId!, customInstructions)
    return
  }
  // segments 先快照（clearInput 会清空 DOM）
  const segments = inputRef.value?.getSegments() ?? []
  clearInput()
  isSending.value = true
  try {
    await send(props.sessionId!, segments)
  } catch (e) {
    // 发送失败（hook 拦截 / ensureActive 失败 / prompt 抛错 / WS 断连）恢复草稿，避免输入丢失。
    // W8：恢复 text + image/skill/file chip（原 restoreInput(text) 只恢复纯文本，
    // chip 被拍平成字面量路径，用户粘的图丢失可视化）。详见 restoreSegments。
    restoreSegments(segments)
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('panel.panel.sendFailed', { error: msg }))
  } finally {
    isSending.value = false
  }
}

/** 键盘：⏎ 发送/steer，Alt+⏎ follow-up，⇧⏎ 换行，↑/↓ 翻历史。命令浮层 open 时优先路由到浮层。 */
function onKeydown(e: KeyboardEvent): void {
  if (cmdOpen.value && commandPopoverRef.value?.handleKeydown(e)) return
  if (e.isComposing) return // IME 组合中不拦截（与 useContenteditableInput 守卫一致）
  if (fork.handleForkEsc(e)) return // Fork 模式 Esc 退出（仅 composer 聚焦时到达，不与全局 Esc 冲突）
  if (handoff.handleHandoffEsc(e)) return // Handoff 模式 Esc 退出（对称 fork，互斥下不会同时活跃）
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
    onFollowUp()
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

