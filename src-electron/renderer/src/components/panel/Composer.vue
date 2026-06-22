<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    v1 主路径 4 态：
      S1 空 → S2 输入中 → S5 发送中（spinner）→ S6 流式中（stop + steer/followUp）
    DEFERRED：
      S3/S4（@/#// 附件浮层 G2-002）、S7-S9 双队列视图/失败回退/已排队多条。
    steer/followUp：isStreaming 时 ⏎ 追加 steer，Alt+⏎ 追加 followUp，都不打断当前回合。
  -->
  <div class="composer mx-3.5">
    <div class="composer-box rounded-lg border bg-bg-input" :class="boxClass">
      <!-- 输入区：Textarea 原语（no-native-html 规则） -->
      <Textarea
        v-model="draft"
        :placeholder="placeholder"
        :disabled="isSending"
        class="composer-area min-h-[40px] max-h-[120px] resize-none border-0 bg-transparent px-3.5 pb-1 pt-[11px] text-[13px] leading-[1.55] text-fg outline-none ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
        @keydown="onKeydown"
      />

      <!-- 工具条（panel/spec §composer line 51）：上下文/模型/thinking-level 展示型 + 发送位三态。 -->
      <div class="composer-bar flex flex-wrap items-center justify-end gap-0.5 px-2.5 pb-2">
        <!-- + 添加内容（左锚定，spec §1 ①） -->
        <Button
          variant="ghost"
          size="icon"
          class="size-[28px] shrink-0 rounded-sm text-subtle transition-colors hover:bg-surface-hover hover:text-muted"
          title="添加内容"
        >
          <Plus class="size-4" />
        </Button>
        <span class="flex-1" />
        <!-- 上下文容量（spec §2a：hover 出容量 popover） -->
        <Button
          variant="ghost"
          class="h-7 gap-[5px] rounded-sm px-2 text-[11.5px] text-subtle hover:text-muted"
          title="上下文容量"
        >
          <span class="tabular-nums">0</span>
          <span class="block size-[3px] rounded-full bg-[var(--subtle)] opacity-50"></span>
          <span>0%</span>
        </Button>
        <!-- 模型（spec §2b：click 出模型切换 popover） -->
        <Button
          variant="ghost"
          class="h-7 rounded-sm px-2 text-[11.5px] text-subtle/80 hover:text-muted"
          title="模型选择"
        >
          sonnet-4.5
        </Button>
        <!-- 思考等级（spec §2c：click 出 6 级 popover） -->
        <Button
          variant="ghost"
          class="h-7 rounded-sm px-2 text-[11.5px] text-subtle/80 hover:text-muted"
          title="思考等级"
        >
          思考 最高
        </Button>

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

    <!-- hint（draft composer-hint） -->
    <div class="px-1 pt-1.5 font-mono text-[10px] leading-tight text-subtle">
      <span v-if="isStreaming">
        <kbd class="rounded-sm border border-[var(--border)] bg-[var(--surface-hover)] px-1 py-px">⏎</kbd> 追加 steer ·
        <kbd class="rounded-sm border border-[var(--border)] bg-[var(--surface-hover)] px-1 py-px">Alt + ⏎</kbd> 新轮 followup ·
        <kbd class="rounded-sm border border-[var(--border)] bg-[var(--surface-hover)] px-1 py-px">⇧ + ⏎</kbd> 换行
      </span>
      <span v-else>
        <kbd class="rounded-sm border border-[var(--border)] bg-[var(--surface-hover)] px-1 py-px">⏎</kbd> 发送 · <kbd class="rounded-sm border border-[var(--border)] bg-[var(--surface-hover)] px-1 py-px">⇧ + ⏎</kbd> 换行
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, Loader2, Plus, Square } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useChat } from '@/composables/features/useChat'
import { useChatStore } from '@/stores/chat'

const props = defineProps<{
  sessionId: string
}>()

const chatStore = useChatStore()
const { isStreaming } = storeToRefs(chatStore)
const { send, steer, followUp, abort } = useChat()

const draft = ref('')
/** 发送中（S5）：useChat.send 的 Promise 在途 */
const isSending = ref(false)

const hasInput = computed(() => draft.value.trim().length > 0)
/** 可发送：有输入且非 streaming 非 sending */
const canSend = computed(() => hasInput.value && !isStreaming.value && !isSending.value)

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

/** 发送：S2 → S5（sending）→ S6（streaming）→ 完成回 S1 */
async function onSend(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value
  draft.value = ''
  isSending.value = true
  try {
    await send(text)
  } catch (e) {
    // 发送失败（hook 拦截 / ensureActive 失败 / prompt 抛错 / WS 断连）恢复草稿，避免用户输入永久丢失。
    draft.value = text
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
  draft.value = ''
  try {
    await sender(trimmed)
  } catch (e) {
    draft.value = text
    throw e
  }
}

/** 停止（S6）：调 abort（G-025 流转 DEFERRED，方法存在） */
async function onAbort(): Promise<void> {
  await abort()
}

/** 键盘：⏎ 发送/steer，Alt+⏎ follow-up/发送，⇧⏎ 换行 */
function onKeydown(e: KeyboardEvent): void {
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

// sessionId 占位：未来 panel-scoped composer 多实例隔离（v1 单 composer 跟 active session）
void props
</script>

