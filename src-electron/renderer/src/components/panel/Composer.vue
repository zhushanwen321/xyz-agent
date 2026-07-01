<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    v1 主路径 4 态：
      S1 空 → S2 输入中 → S5 发送中（spinner）→ S6 流式中（stop + steer/followUp）
    DEFERRED：
      S3/S4（@/#// 附件浮层 G2-002）、S7-S9 双队列视图/失败回退/已排队多条。
    steer/followUp：isStreaming 时 ⏎ 追加 steer，Alt+⏎ 追加 followUp，都不打断当前回合。
  -->
  <div class="composer" :class="props.variant === 'landing' ? 'mx-auto w-full max-w-[720px]' : 'mx-3.5 mb-3.5'">
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
          class="ml-1.5 size-[30px] rounded-md bg-[var(--accent)] text-white transition-colors enabled:hover:bg-[var(--accent-hover)] disabled:bg-transparent disabled:text-[var(--subtle)]"
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
import { computed, ref, watch } from 'vue'
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
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useSettingsStore } from '@/stores/settings'
import { useCommandStore } from '@/stores/command'
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
const settingsStore = useSettingsStore()
const commandStore = useCommandStore()
const { isStreaming } = storeToRefs(chatStore)
const { send, steer, followUp, abort, compact } = useChat()
const { submitFirstMessage } = useNewTaskFlow()

/** 当前 session 的思考等级（从 SessionSummary.thinkingLevel 透传给 ThinkingLevelPopover） */
const currentThinkingLevel = computed(() => sessionStore.active?.thinkingLevel)
/** #13 retry/queue 指示位数据源（store 由 W0/#8 维护，不可变 Map 更新触发响应） */
const retryState = computed(() => (props.sessionId ? chatStore.getRetryState(props.sessionId) : undefined))
const queueState = computed(() => (props.sessionId ? chatStore.getQueueState(props.sessionId) : undefined))

const draft = ref('')
/**
 * 当前选中模型 id —— "provider/modelId" 复合串（与 SessionSummary.modelId / config.defaults 同格式）。
 * 优先取 active session 的 modelId（per-session 真值）；landing 态（无 active session）
 * 回退到全局默认模型（settingsStore.defaultModel，经 config.defaults 订阅）。
 *
 * 用 || 而非 ??：session.list 广播里的已退出/磁盘 session 的 modelId 硬编码为 ''（空串），
 * ?? 不兜底空串（'' ?? fallback === ''），导致模型显示消失。|| 兜底空串到 defaultModel。
 */
const currentModelId = computed(
  () => sessionStore.active?.modelId || settingsStore.defaultModel || '',
)
/** ComposerInput 实例 ref：清空/恢复草稿用 */
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)
/**
 * 消费搜索浮层的 slash 注入请求（store 驱动模式，替代断链的 injectSlash 回调）。
 * SearchModal → useSearchJump.confirmCommand → commandStore.requestSlashInjection 写入 pendingSlash，
 * 本 watch 按 sessionId 过滤消费，命中则调 insertSlashChip 注入 chip 并 clearPendingSlash。
 *
 * 非 immediate：防 Composer 后挂载时读到旧 pendingSlash 残留值误注入（挂载时 store 可能已有
 * 给前一个 Composer 的请求，immediate 会立即误触发）。仅响应挂载后的新写入。
 * sessionId 匹配：含双方 null（landing 态）。不匹配分支不 clear（防误清留给其他 Composer 的请求）。
 * 注入顺序：先 insertSlashChip 后 clearPendingSlash（防先清后注入读到 null）。
 */
watch(
  () => commandStore.pendingSlash,
  (req) => {
    if (!req) return
    if (req.sessionId !== props.sessionId) return // 仅消费目标 session 的请求
    inputRef.value?.insertSlashChip(req.command, req.icon)
    commandStore.clearPendingSlash()
  },
)
/** 命令浮层状态（§2d #//） */
const cmdOpen = ref(false)
const cmdType = ref<'file' | 'slash'>('file')
/** slash 触发态标记：区分「输入区 / 触发」与「+菜单触发」两条打开浮层路径。
 *  仅输入区 / 触发打开时为 true，使后续 slash-trigger:null 能正确关闭；
 *  +菜单路径（onAddSelect）不设 true，避免用户敲普通键误关 +菜单浮层。 */
const slashTriggerActive = ref(false)
/** slash 命令过滤 query（输入区 / 后内容），透传给 CommandPopover 过滤 */
const slashQuery = ref('')
/** # 文件触发态标记：同 slashTriggerActive 语义，区分输入区 # 触发与 +菜单触发两条路径 */
const fileTriggerActive = ref(false)
/** # 文件过滤 query（输入区 # 后内容），透传给 CommandPopover 过滤 */
const fileQuery = ref('')
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

/** 输入区 slash-trigger 事件路由：
 *  - payload 非 null（/ 在最左且无 chip）→ 打开 slash 浮层，记录 query 透传过滤，标记 slashTriggerActive
 *  - payload 为 null 且 slashTriggerActive → 关闭浮层（仅输入区触发路径；+菜单路径 slashTriggerActive=false 不受影响） */
function onSlashTrigger(payload: { query: string } | null): void {
  if (payload) {
    slashTriggerActive.value = true
    slashQuery.value = payload.query
    cmdType.value = 'slash'
    cmdOpen.value = true
  } else if (slashTriggerActive.value) {
    cmdOpen.value = false
    slashTriggerActive.value = false
  }
}

/** 输入区 file-trigger 事件路由（同 onSlashTrigger 语义，对应 # 文件浮层）：
 *  - payload 非 null（光标前有「空格/行首 + # + 非空白」）→ 打开 file 浮层，记录 query 透传过滤
 *  - payload 为 null 且 fileTriggerActive → 关闭浮层（# 后遇空格等终止场景） */
function onFileTrigger(payload: { query: string } | null): void {
  if (payload) {
    fileTriggerActive.value = true
    fileQuery.value = payload.query
    cmdType.value = 'file'
    cmdOpen.value = true
  } else if (fileTriggerActive.value) {
    cmdOpen.value = false
    fileTriggerActive.value = false
  }
}

/** + 菜单选择：打开命令浮层（slash）。slashTriggerActive 不设 true——
 *  +菜单路径的浮层不受后续 slash-trigger:null 影响（防用户敲普通键误关）。
 *  attach 暂为 TODO（附件功能单独开任务）；file 已移除入口（# 改走 inline 触发）。 */
function onAddSelect(type: 'attach' | 'slash'): void {
  if (type === 'attach') return // TODO: 附件上传（附件功能单独开任务）
  inputRef.value?.saveSelection()
  inputRef.value?.focus()
  cmdType.value = 'slash'
  cmdOpen.value = true
}

/** 命令浮层选中：插 slash chip / file chip。slash 分支先清掉 /query 过滤文本再插 chip；
 *  file 分支先清掉 #query 过滤文本（任意位置，只删 # 到光标这段）再插 mention chip。
 *  icon 按 source 透传给 chip（extension→terminal / skill→star / 默认 wrench），与选择框图标一致。 */
function onCmdSelect(payload: { type: 'file' | 'slash'; name: string; icon?: string; description?: string }): void {
  cmdOpen.value = false
  slashTriggerActive.value = false // 复位触发态标记
  fileTriggerActive.value = false // 复位 # 触发态标记
  inputRef.value?.focus()
  if (payload.type === 'slash') {
    inputRef.value?.clearSlashQueryText()
    inputRef.value?.insertSlashChip(payload.name, payload.icon)
  } else {
    inputRef.value?.clearHashQueryText()
    inputRef.value?.insertMentionChip('#', payload.name)
  }
}

/** 模型切换：调 runtime model.switch（sessionId + provider + modelId）；
 * 成功后乐观更新 sessionStore（立即生效，不依赖 state_changed 广播到达——
 * 未发消息的 session 可能无 streamSubscription，广播会丢）。
 * runtime 广播 session.state_changed 作为多 panel 同步的补充。
 * landing 态（sid=null）延迟 create，不切换模型。 */
async function onModelSelect(payload: { modelId: string; provider: string }): Promise<void> {
  if (!props.sessionId) return // landing 态延迟 create（sid=null）时不切换模型
  await modelApi.switchModel(props.sessionId, payload.provider, payload.modelId)
  // 乐观更新：立即同步 active.modelId（复合串 "provider/modelId"）
  sessionStore.updateSessionState(props.sessionId, {
    modelId: `${payload.provider}/${payload.modelId}`,
  })
}

/** 思考等级切换：调 runtime session.setThinkingLevel（成功后 session store 持久） */
async function onThinkingSelect(level: string): Promise<void> {
  if (!props.sessionId) return // landing 态延迟 create（sid=null）时不切思考等级
  await sessionApi.setThinkingLevel(props.sessionId, level)
}

const hasInput = computed(() => draft.value.trim().length > 0)
/** 可发送：有输入且非 streaming 非 sending 非 compacting。
 *  landing 态（sessionId=null）也允许——首发提交走 submitFirstMessage 延迟 create。 */
const canSend = computed(() => hasInput.value && !isStreaming.value && !isSending.value && !isCompacting.value)

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
    : '描述你想让 AI 做什么，或 # 文件、/ 命令…',
)

/**
 * 发送：S2 → S5（sending）→ S6（streaming）→ 完成回 S1。
 * landing 态（sessionId=null）首发提交走 submitFirstMessage（延迟 create session 后再发）；
 * 非 landing 走 useChat.send。/compact slash chip 是操作型前缀：提交时走专用 compact RPC（#6）。
 * 检测：slash chip 的命令名（如 '/compact'）会被 ComposerInput.getText 读入 draft，
 * 故 draft 恰为 '/compact'（chip 单独存在，无附加文本）时判定为 compact 操作。
 */
async function onSend(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value
  // landing 态首发提交：统一延迟 create（无 sid）→ submitFirstMessage 负责 create+载入+发送
  if (!props.sessionId) {
    clearInput()
    isSending.value = true
    try {
      await submitFirstMessage(text)
    } catch (e) {
      restoreInput(text)
      throw e
    } finally {
      isSending.value = false
    }
    return
  }
  if (text.trim() === '/compact') {
    clearInput()
    await compact()
    return
  }
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

