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
      :query="cmdType === 'file' ? fileQuery : slashQuery"
      @select="onCmdSelect"
    >
      <div class="composer-box relative rounded-lg border bg-bg-input" :class="boxClass" data-testid="composer-box">
        <!-- 顶部元信息行 slot（landing 态：directory/branch chip；panel 态留空） -->
        <slot name="meta-row" />
        <!-- 已附上下文 chip 行（§2f，hover 出详情列表）。mock 演示始终显示，runtime 后按实际附件显隐 -->
        <ContextChipsBar />
        <!-- 输入区：contenteditable 富文本（draft §1/§2e，支持 slash chip 与 @/# mention 内联） -->
        <ComposerInput
          ref="inputRef"
          :placeholder="placeholder"
          :disabled="isSending"
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
        <ContextCapacityPopover :session-id="sessionId ?? undefined" />
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
          :title="canSend ? `${t('panel.composer.send')} · ⏎` : t('panel.composer.sendHint')"
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
import { ArrowUp, Loader2, Square } from '@lucide/vue'
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
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useChatStore } from '@/stores/chat'
import { useToast } from '@/composables/useToast'
import { useComposerModelThinking } from '@/composables/panel/useComposerModelThinking'
import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'
import { useComposerInjection } from '@/composables/panel/useComposerInjection'
import { useComposerHistory } from '@/composables/panel/useComposerHistory'

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
/**
 * 合并活跃态：流式中（isGenerating）或派发空窗期（dispatchingSessionId 命中当前 session）。
 * 替代单一 isGenerating 驱动停止按钮/steer guard/键盘路由，消除「ack 到达但 message_start 未到」
 * 的空窗期——点发送后立刻显示停止按钮、steer 可用，message_start 到达无缝切交流式态。
 */
const isActive = computed(() => {
  if (!props.sessionId) return false
  return chatStore.isActive(props.sessionId)
})

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

// 命令浮层触发态机（slash/file 浮层触发 + CommandPopover 联动 + pendingSlash 注入）
// —— 见 useCommandPopoverTrigger。inputRef 先声明，composable 内部回调按需调其方法。
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

// 输入历史导航（↑/↓ 翻阅已发送消息，shell 风格）——见 useComposerHistory。
// sessionId null（landing 态无真实 session）时 history 为空。
const { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsing } = useComposerHistory(
  sessionIdRef,
  {
    getText: () => inputRef.value?.getText() ?? '',
    setText: (text, caretPosition) => inputRef.value?.setText(text, caretPosition),
    clear: () => inputRef.value?.clear(),
  },
)

// FR4: per-session 草稿存储（内存，不持久化到磁盘）
const drafts = new Map<string, string>()
// FR4: session 切换时保存旧 session 草稿，恢复新 session 草稿
watch(
  () => props.sessionId,
  (newId, oldId) => {
    if (oldId) {
      // browsing 态下 getText() 返回历史条目，应保存用户实际输入的 savedDraft
      drafts.set(oldId, isBrowsing.value ? (draft.value || '') : (inputRef.value?.getText() ?? ''))
    }
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

/** 发送中（S5）：useChat.send 的 Promise 在途 */
const isSending = ref(false)
/** 当前 panel 的 session 是否正在压缩上下文（#6，per-session） */
const isCompacting = computed(() => (props.sessionId ? chatStore.isCompacting(props.sessionId) : false))

/** ComposerInput input 事件 → 维护 draft（纯文本，用于发送判断） */
function onInputChange(text: string): void {
  draft.value = text
  // 用户修改了内容，重置浏览历史状态（下次按上重新从最后一条开始）
  resetBrowsing()
}

/** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
function clearInput(): void {
  draft.value = ''
  if (props.sessionId) drafts.delete(props.sessionId)
  inputRef.value?.clear()
}

/** 发送失败恢复草稿到输入区 */
function restoreInput(text: string): void {
  draft.value = text
  inputRef.value?.setText(text)
}

const hasInput = computed(() => draft.value.trim().length > 0)
/** 可发送：有输入且非活跃（流式/派发）非 sending 非 compacting。
 *  landing 态（sessionId 可能为公共 session id 或 null）也允许——首发提交走 submitFirstMessage 延迟 create。 */
const canSend = computed(() => hasInput.value && !isActive.value && !isSending.value && !isCompacting.value)

/**
 * composer-box class（draft）：
 * - S6 流式中/派发空窗期：accent 蓝 steer 呼吸 ring
 * - S2 普通输入中：中性聚焦 ring
 */
const boxClass = computed(() => [
  isActive.value
    ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)] animate-steer-breathe'
    : hasInput.value
      ? 'border-[var(--border-strong)] shadow-[0_0_0_2px_rgba(255,255,255,0.04)]'
      : '',
  isSending.value && 'opacity-[0.55]',
])

const placeholder = computed(() =>
  isActive.value
    ? t('panel.composer.steerHint')
    : t('panel.composer.inputHint'),
)

/**
 * 发送：S2 → S5（sending）→ S6（streaming）→ 完成回 S1。
 * landing 态首发提交走 submitFirstMessage（延迟 create session 后再发）；
 * 非 landing 走 useChat.send。/compact slash chip 是操作型前缀：提交时走专用 compact RPC（#6）。
 * 检测：slash chip 的命令名 '/compact' 会被 ComposerInput.getText 读入 draft，
 * '/compact'（纯 chip）或 '/compact <指令>'（chip + 附加文本）均判定为 compact 操作，
 * 后者提取附加文本作为 customInstructions 透传给 pi 压缩 prompt。
 *
 * landing 判定用 variant 而非 sessionId：landing 态 composer 的 sessionId 可能是
 * 公共 session id（用于 CommandPopover 显示 pi extension 命令），但它不是真实工作
 * session——首发提交仍需走 submitFirstMessage 延迟 create。variant='landing' 是
 * 渲染层确定的 landing 语义，与 sessionId 解耦。
 */
async function onSend(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value
  // landing 态首发提交：统一延迟 create → submitFirstMessage 负责 create+载入+发送。
  // 用 variant 判定（非 sessionId），因为 landing 态 sessionId 可能是公共 session id。
  if (props.variant === 'landing') {
    clearInput()
    isSending.value = true
    try {
      await flow.submitFirstMessage(text, localThinkingLevel.value)
    } catch (e) {
      restoreInput(text)
      // 错误已消化（toast + 草稿恢复），不 throw（throw 只会变 unhandled rejection，用户不可见）。
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('panel.panel.taskFailed', { error: msg }))
    } finally {
      isSending.value = false
    }
    return
  }
  // /compact slash chip 是操作型前缀：提交时走专用 compact RPC（#6），不发 prompt 给 pi。
  // 检测：slash chip 的命令名 '/compact' 会被 ComposerInput.getText 读入 draft。
  // 支持两种形态：
  //   - 纯 '/compact'（chip 单独存在，无附加文本）→ 无 customInstructions
  //   - '/compact <指令>'（chip + 后续文本）→ 提取为 customInstructions 透传给 pi 压缩 prompt
  // 与 pi TUI interactive-mode.ts:2656 的解析对齐（text === '/compact' || startsWith('/compact ')）。
  // 必须在此拦截：pi RPC prompt 路径不解析 builtin slash，/compact 当 prompt 发过去会被当普通消息发给 LLM。
  const trimmed = text.trim()
  if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
    const customInstructions = trimmed.startsWith('/compact ')
      ? trimmed.slice('/compact '.length).trim() || undefined
      : undefined
    clearInput()
    await compact(props.sessionId!, customInstructions)
    return
  }
  // 先快照 segments（clearInput 会清空 DOM，必须在清空前提取，否则 getSegments 返回 []）。
  const segments = inputRef.value?.getSegments() ?? []
  clearInput()
  isSending.value = true
  try {
    await send(props.sessionId!, segments)
  } catch (e) {
    // 发送失败（hook 拦截 / ensureActive 失败 / prompt 抛错 / WS 断连）恢复草稿，避免用户输入永久丢失。
    restoreInput(text)
    // 错误已消化（toast + 草稿恢复），不 throw。
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('panel.panel.sendFailed', { error: msg }))
  } finally {
    isSending.value = false
  }
}

/** 追加 steer：活跃态（流式/派发）有输入时 ⏎ 触发 */
async function onSteer(): Promise<void> {
  if (!hasInput.value || !isActive.value) return
  // submit 内部会 clearInput（清空 DOM），必须在调 submit 之前快照 segments，否则 getSegments 返回 []。
  const segments = inputRef.value?.getSegments() ?? []
  await submit(draft.value, () => steer(props.sessionId!, segments))
}

/** 追加 follow-up：S6 有输入时 Alt+⏎ 触发；非流式则退化为普通发送 */
async function onFollowUp(): Promise<void> {
  if (!hasInput.value) return
  // submit 内部会 clearInput（清空 DOM），必须在调 submit 之前快照 segments，否则 getSegments 返回 []。
  const segments = inputRef.value?.getSegments() ?? []
  await submit(draft.value, () => followUp(props.sessionId!, segments))
}

/** 公共提交：清空输入 → 调用 sender → 失败时恢复草稿 */
async function submit(text: string, sender: () => Promise<void>): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  clearInput()
  try {
    await sender()
  } catch (e) {
    restoreInput(text)
    throw e
  }
}

/** 停止（S6）：调 abort（G-025 流转 DEFERRED，方法存在） */
async function onAbort(): Promise<void> {
  await abort(props.sessionId!)
}

/** 键盘：⏎ 发送/steer，Alt+⏎ follow-up/发送，⇧⏎ 换行。命令浮层 open 时优先路由到浮层。
 *  ↑/↓ 翻阅输入历史——权威规则见
 *  `.xyz-harness/2026-07-10-composer-history-navigation/spec.md` FR1（三阶段模型）。
 *  摘要：edit/browsing 态统一三阶段——先视觉行移动（caretRangeFromPoint），到边缘才翻历史。 */
function onKeydown(e: KeyboardEvent): void {
  if (cmdOpen.value && commandPopoverRef.value?.handleKeydown(e)) return
  // IME 组合中不拦截任何键（与 useContenteditableInput 的 IME 守卫一致）
  if (e.isComposing) return
  // shift/ctrl/alt/meta + 方向键是选区扩展/按词移动/段首段尾跳转，放行原生行为（不拦截）
  // edit/browsing 态统一三阶段模型：先视觉行移动，到边缘才翻历史（spec FR1）
  if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    if (inputRef.value?.moveCaretVertical('up') === 'moved') return
    handleArrowUp()
    return
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    if (inputRef.value?.moveCaretVertical('down') === 'moved') return
    handleArrowDown()
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
</script>

