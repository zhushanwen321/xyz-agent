<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    v1 主路径 4 态：
      S1 空 → S2 输入中 → S5 发送中（spinner）→ S6 流式中（stop + steer/followUp）
    DEFERRED：
      S3/S4（@/#// 附件浮层 G2-002）、S7-S9 双队列视图/失败回退/已排队多条。
    steer/followUp：isStreaming 时 ⏎ 追加 steer，Alt+⏎ 追加 followUp，都不打断当前回合。
  -->
  <div class="composer" :class="props.variant === 'landing' ? 'mx-auto w-full max-w-[720px]' : 'mx-3.5'">
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
        />

      <!-- 工具条（panel/spec §composer line 51）：上下文/模型/thinking-level 展示型 + 发送位三态。 -->
      <div class="composer-bar flex flex-wrap items-center justify-end gap-0.5 px-2.5 pb-2">
        <!-- + 添加内容（左锚定，spec §1 ①，click 出 4 路浮层） -->
        <AddMenuPopover @select="onAddSelect" />
        <span class="flex-1" />
        <!-- 上下文容量（spec §2a：hover 出容量 popover；session 通道订阅 context.update） -->
        <ContextCapacityPopover :session-id="sessionId ?? undefined" />
        <!-- 模型（spec §2b：click 出模型切换 popover） -->
        <ModelSelectPopover :selected="currentModelId" @select="onModelSelect" />
        <!-- 思考等级（spec §2c：click 出 6 级 popover；level 从 session 透传） -->
        <ThinkingLevelPopover :level="currentThinkingLevel" @select="onThinkingSelect" />

        <!-- 发送位三态：S6 streaming→stop / S5 sending→spinner / S1·S2 idle→send -->
        <Button
          v-if="isStreaming"
          variant="ghost"
          size="icon"
          class="stop-btn ml-1.5 size-[30px] rounded-md bg-surface-hover text-muted hover:bg-[rgba(239,68,68,0.15)] hover:text-danger"
          title="停止"
          @click="onAbort"
        >
          <Square class="size-[13px]" />
        </Button>
        <div
          v-else-if="isCompacting"
          class="ml-1.5 grid size-[30px] place-items-center rounded-md bg-surface-hover text-muted"
          title="压缩中…"
        >
          <Loader2 class="size-4 animate-spin" />
        </div>
        <div
          v-else-if="isSending"
          class="ml-1.5 grid size-[30px] place-items-center rounded-md bg-[var(--accent)] text-white"
          title="发送中…"
        >
          <Loader2 class="size-4 animate-spin" />
        </div>
        <Button
          v-else
          variant="default"
          size="icon"
          class="ml-1.5 size-[30px] rounded-md bg-[var(--accent)] text-white transition-colors enabled:hover:bg-[var(--accent-hover)] disabled:bg-transparent disabled:text-[var(--subtle)] disabled:opacity-50"
          :disabled="!canSend"
          :title="canSend ? '发送 · ⏎' : '输入内容后发送'"
          @click="onSend"
        >
          <ArrowRight class="size-[15px]" />
        </Button>
      </div>
    </div>
    </CommandPopover>

  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, Loader2, Square } from '@lucide/vue'
import { storeToRefs } from 'pinia'
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
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { model as modelApi, session as sessionApi } from '@/api'

const props = withDefaults(
  defineProps<{
    sessionId: string | null
    variant?: 'panel' | 'landing'
  }>(),
  { variant: 'panel' },
)

const chatStore = useChatStore()
const sessionStore = useSessionStore()
const { isStreaming } = storeToRefs(chatStore)
const { send, steer, followUp, abort, compact } = useChat()

/** 当前 session 的思考等级（从 SessionSummary.thinkingLevel 透传给 ThinkingLevelPopover） */
const currentThinkingLevel = computed(() => sessionStore.active?.thinkingLevel)
/** #13 retry/queue 指示位数据源（store 由 W0/#8 维护，不可变 Map 更新触发响应） */
const retryState = computed(() => (props.sessionId ? chatStore.getRetryState(props.sessionId) : undefined))
const queueState = computed(() => (props.sessionId ? chatStore.getQueueState(props.sessionId) : undefined))

const draft = ref('')
/** 当前选中模型 id：真实选中从 model.list + session 默认模型派生（后续接 model.switched 订阅），未派生前为空 */
const currentModelId = ref('')
/** ComposerInput 实例 ref：清空/恢复草稿用 */
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)
/** 命令浮层状态（§2d @/#//） */
const cmdOpen = ref(false)
const cmdType = ref<'mention' | 'file' | 'slash'>('mention')
const commandPopoverRef = ref<InstanceType<typeof CommandPopover> | null>(null)
/** 发送中（S5）：useChat.send 的 Promise 在途 */
const isSending = ref(false)
/** 当前 panel 的 session 是否正在压缩上下文（#6，per-session） */
const isCompacting = computed(() => (props.sessionId ? chatStore.isCompacting(props.sessionId) : false))

/** ComposerInput input 事件 → 维护 draft（纯文本，用于发送判断） */
function onInputChange(text: string): void {
  draft.value = text
}

/** 发送成功后清空输入区（DOM + draft） */
function clearInput(): void {
  draft.value = ''
  inputRef.value?.clear()
}

/** 发送失败恢复草稿到输入区 */
function restoreInput(text: string): void {
  draft.value = text
  inputRef.value?.setText(text)
}

/** + 菜单选择：打开对应命令浮层（§2d @/#//） */
function onAddSelect(type: 'attach' | 'mention' | 'file' | 'slash'): void {
  if (type === 'attach') return // TODO: 附件上传（未来功能）
  // 打开命令浮层（输入区符号触发为后续增强）
  inputRef.value?.saveSelection()
  inputRef.value?.focus()
  cmdType.value = type === 'mention' ? 'mention' : type === 'file' ? 'file' : 'slash'
  cmdOpen.value = true
}

/** 命令浮层选中：插 slash chip / mention chip */
function onCmdSelect(payload: { type: 'mention' | 'file' | 'slash'; name: string }): void {
  cmdOpen.value = false
  inputRef.value?.focus()
  if (payload.type === 'slash') {
    inputRef.value?.insertSlashChip(payload.name)
  } else {
    inputRef.value?.insertMentionChip(payload.type === 'mention' ? '@' : '#', payload.name)
  }
}

/** 模型切换：调 runtime model.switch（sessionId + provider + modelId）；成功后回写本地 ref */
async function onModelSelect(payload: { modelId: string; provider: string }): Promise<void> {
  if (!props.sessionId) return // landing 态延迟 create（sid=null）时不切换模型
  currentModelId.value = payload.modelId
  await modelApi.switchModel(props.sessionId, payload.provider, payload.modelId)
}

/** 思考等级切换：调 runtime session.setThinkingLevel（成功后 session store 持久） */
async function onThinkingSelect(level: string): Promise<void> {
  if (!props.sessionId) return // landing 态延迟 create（sid=null）时不切思考等级
  await sessionApi.setThinkingLevel(props.sessionId, level)
}

const hasInput = computed(() => draft.value.trim().length > 0)
/** 可发送：有输入且非 streaming 非 sending 非 compacting */
const canSend = computed(() => hasInput.value && !!props.sessionId && !isStreaming.value && !isSending.value && !isCompacting.value)

/**
 * composer-box class（draft）：
 * - S6 流式中：accent 蓝 steer 呼吸 ring
 * - S2 普通输入中：中性聚焦 ring
 */
const boxClass = computed(() => [
  isStreaming.value
    ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)] animate-steer-breathe'
    : hasInput.value
      ? 'border-[var(--border-strong)] shadow-[0_0_0_2px_rgba(255,255,255,0.04)]'
      : '',
  isSending.value && 'opacity-[0.55]',
])

const placeholder = computed(() =>
  isStreaming.value
    ? '想补充什么？⏎ 加入当前任务 · Alt+⏎ 排到下一轮…'
    : '描述你想让 AI 做什么…',
)

/**
 * 发送：S2 → S5（sending）→ S6（streaming）→ 完成回 S1。
 * /compact slash chip 是操作型前缀：提交时走专用 compact RPC（#6），不走普通 send。
 * 检测：slash chip 的命令名（如 '/compact'）会被 ComposerInput.getText 读入 draft，
 * 故 draft 恰为 '/compact'（chip 单独存在，无附加文本）时判定为 compact 操作。
 */
async function onSend(): Promise<void> {
  if (!canSend.value) return
  if (draft.value.trim() === '/compact') {
    clearInput()
    await compact()
    return
  }
  const text = draft.value
  clearInput()
  isSending.value = true
  try {
    await send(text)
  } catch (e) {
    // 发送失败（hook 拦截 / ensureActive 失败 / prompt 抛错 / WS 断连）恢复草稿，避免用户输入永久丢失。
    restoreInput(text)
    throw e
  } finally {
    isSending.value = false
  }
}

/** 追加 steer：S6 有输入时 ⏎ 触发 */
async function onSteer(): Promise<void> {
  if (!hasInput.value || !isStreaming.value) return
  await submit(draft.value, steer)
}

/** 追加 follow-up：S6 有输入时 Alt+⏎ 触发；非流式则退化为普通发送 */
async function onFollowUp(): Promise<void> {
  if (!hasInput.value) return
  await submit(draft.value, followUp)
}

/** 公共提交：清空输入 → 调用 sender → 失败时恢复草稿 */
async function submit(text: string, sender: (t: string) => Promise<void>): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  clearInput()
  try {
    await sender(trimmed)
  } catch (e) {
    restoreInput(text)
    throw e
  }
}

/** 停止（S6）：调 abort（G-025 流转 DEFERRED，方法存在） */
async function onAbort(): Promise<void> {
  await abort()
}

/** 键盘：⏎ 发送/steer，Alt+⏎ follow-up/发送，⇧⏎ 换行。命令浮层 open 时优先路由到浮层 */
function onKeydown(e: KeyboardEvent): void {
  if (cmdOpen.value && commandPopoverRef.value?.handleKeydown(e)) return
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  if (e.altKey) {
    onFollowUp()
  } else if (isStreaming.value) {
    onSteer()
  } else {
    onSend()
  }
}
</script>

