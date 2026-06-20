<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    v1 主路径 4 态（spec §8.5）：
      S1 空（无输入）→ S2 输入中（有内容，中性 ring）→ S5 发送中（spinner，禁用）
      → S6 停止（AI 工作中，发 send 的反向 = 调 abort）→ 回 S1。
    DEFERRED（按 spec §8.5 Round3 统一 hide，不留 disabled 占位）：
      S3（@/#// 命令浮层 G2-002）、S4（附件 G2-002）、S7-S9（steer/双队列/失败 G-019）。
    工具条元素（panel/spec §composer line 51 列 5 元素）属 v1 视觉范围，但交互深度按 DEFERRED：
      - +添加入口 hide（触发的 S3/S4 浮层 G2-002 DEFERRED → 按 G3-002 hide 规则，不留无反应按钮）
      - 上下文/模型/thinking-level：v1 展示型 span（容量§2a/模型§2b/思考§2c popover DEFERRED，
        mock 无数据源/模型表/思考切换后端），纯文字信息，非 button。
    steer 提交 DEFERRED（G-019）：draft 的 S6 accent 呼吸 ring 是 steer 信号，
    v1 不实现 steer 故 S6 用中性 ring（避免误导不存在的功能）。
    abort 流转 DEFERRED（G-025）：按钮调 api.chat.abort，实际中断逻辑留联调。
  -->
  <div class="composer mx-3.5 pt-2.5">
    <div class="composer-box rounded-lg border bg-black/20" :class="boxClass">
      <!-- 输入区：Textarea 原语（no-native-html 规则） -->
      <Textarea
        v-model="draft"
        :placeholder="placeholder"
        :disabled="isSending"
        class="composer-area min-h-[40px] max-h-[120px] border-0 bg-transparent px-3.5 pb-1 pt-[11px] text-[13px] leading-[1.55] text-fg outline-none ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
        @keydown="onKeydown"
      />

      <!-- 工具条（panel/spec §composer line 51）：上下文/模型/thinking-level 展示型 + 发送位三态。 -->
      <div class="composer-bar flex flex-wrap items-center justify-end gap-0.5 px-2.5 pb-2">
        <!-- 上下文容量（展示型，mock 无 token 计数源，显 0·0% 占位；容量 popover §2a DEFERRED） -->
        <span class="inline-flex items-center gap-[5px] px-2 py-1.5 text-[11.5px] text-subtle">
          <span class="tabular-nums">0</span>
          <span class="block size-[3px] rounded-full bg-[var(--subtle)] opacity-50"></span>
          <span>0%</span>
        </span>
        <!-- 模型（展示型，切换 popover §2b DEFERRED） -->
        <span class="px-2 py-1.5 text-[11.5px] text-subtle">sonnet-4.5</span>
        <!-- thinking-level（展示型，切换 §2c DEFERRED；draft 默认最高） -->
        <span class="px-2 py-1.5 text-[11.5px] text-subtle">思考 最高</span>

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
        AI 正在工作中 · 按「停止」中断
      </span>
      <span v-else>
        <kbd class="rounded-sm border border-[var(--border)] bg-[var(--surface-hover)] px-1 py-px">⏎</kbd> 发送 · <kbd class="rounded-sm border border-[var(--border)] bg-[var(--surface-hover)] px-1 py-px">⇧⏎</kbd> 换行
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, Loader2, Square } from '@lucide/vue'
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
const { send, abort } = useChat()

const draft = ref('')
/** 发送中（S5）：useChat.send 的 Promise 在途 */
const isSending = ref(false)

const hasInput = computed(() => draft.value.trim().length > 0)
/** 可发送：有输入且非 streaming 非 sending */
const canSend = computed(() => hasInput.value && !isStreaming.value && !isSending.value)

/**
 * composer-box class（draft）：S2/S6 中性聚焦 ring（border-strong）。
 * draft 原设计 S6 用 accent 蓝 steer 呼吸 ring，但 steer 提交 DEFERRED（G-019），
 * 呼吸 ring 会暗示一个不存在的功能（误导）。v1 S6 与 S2 同用中性 ring。
 */
const boxClass = computed(() => ({
  // S2/S6 聚焦中性 ring（draft .composer-box.focus）。S6 不用 accent 呼吸 ring（steer G-019 DEFERRED）。
  'border-[var(--border-strong)] shadow-[0_0_0_2px_rgba(255,255,255,0.04)]': hasInput.value || isStreaming.value,
  'opacity-[0.55]': isSending.value,
}))

const placeholder = computed(() =>
  isStreaming.value
    ? 'AI 正在工作中，按「停止」中断…'
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
  } finally {
    isSending.value = false
  }
}

/** 停止（S6）：调 abort（G-025 流转 DEFERRED，方法存在） */
async function onAbort(): Promise<void> {
  await abort()
}

/** 键盘：⏎ 发送（streaming 时禁用 steer G-019 DEFERRED），⇧⏎ 换行 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    if (!isStreaming.value) onSend()
  }
}

// sessionId 占位：未来 panel-scoped composer 多实例隔离（v1 单 composer 跟 active session）
void props
</script>
