<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    v1 主路径 4 态（spec §8.5）：
      S1 空（无输入）→ S2 输入中（有内容，中性 ring）→ S5 发送中（spinner，禁用）
      → S6 停止（AI 工作中，发 send 的反向 = 调 abort）→ 回 S1。
    DEFERRED：S3（@/#// 命令浮层 G2-002）、S4（附件 G2-002）、S7-S9（steer/双队列/失败 G-019）。
    abort 流转 DEFERRED（G-025）：按钮调 api.chat.abort，实际中断逻辑留联调。
    S6 下 Enter 发 steer DEFERRED（v1 Enter 在 streaming 时禁用，避免无后端支持的半成品）。
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

      <!-- 工具条：左 + 添加（hide 浮层 G2-002 DEFERRED，v1 仅占位禁用）；右 发送/停止 -->
      <div class="composer-bar flex flex-wrap items-center gap-0.5 px-2.5 pb-2">
        <Button
          variant="ghost"
          size="icon"
          class="size-7 rounded-sm text-subtle hover:bg-surface-hover hover:text-muted"
          disabled
          title="添加内容（附件 / @ 引用 / 命令）— 待实现"
        >
          <Plus class="size-4" />
        </Button>

        <span class="ml-auto" />

        <!-- 发送位：S1 禁用透明文字 / S2 激活 accent / S5 spinner / S6 停止 -->
        <Button
          v-if="!isStreaming"
          variant="default"
          size="icon"
          class="send-btn ml-1.5 size-[30px] rounded-md"
          :disabled="!canSend"
          :title="canSend ? '发送 · ⏎' : '输入内容后发送'"
          @click="onSend"
        >
          <Loader2 v-if="isSending" class="size-4 animate-spin" />
          <ArrowRight v-else class="size-[15px]" />
        </Button>
        <Button
          v-else
          variant="ghost"
          size="icon"
          class="stop-btn ml-1.5 size-[30px] rounded-md bg-surface-hover text-muted hover:bg-[rgba(239,68,68,0.15)] hover:text-danger"
          title="停止"
          @click="onAbort"
        >
          <Square class="size-[13px]" />
        </Button>
      </div>
    </div>

    <!-- hint（draft composer-hint） -->
    <div class="px-1 pt-1.5 font-mono text-[10px] leading-tight text-subtle">
      <span v-if="isStreaming">
        AI 正在工作中 · 按「停止」中断
      </span>
      <span v-else>
        <kbd class="kbd">⏎</kbd> 发送 · <kbd class="kbd">⇧⏎</kbd> 换行
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
const { send, abort } = useChat()

const draft = ref('')
/** 发送中（S5）：useChat.send 的 Promise 在途 */
const isSending = ref(false)

const hasInput = computed(() => draft.value.trim().length > 0)
/** 可发送：有输入且非 streaming 非 sending */
const canSend = computed(() => hasInput.value && !isStreaming.value && !isSending.value)

/** composer-box class（draft）：S2 中性聚焦 ring，S6 steer accent ring（呼吸） */
const boxClass = computed(() => ({
  'box-focus': hasInput.value && !isStreaming.value,
  'box-steer': isStreaming.value,
  'box-disabled': isSending.value,
}))

const placeholder = computed(() =>
  isStreaming.value
    ? '想补充什么？（steer / followup 待实现）…'
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

<style scoped>
/* composer-box 聚焦态（draft .composer-box.focus / .focus.steer / .disabled） */
.box-focus {
  border-color: var(--border-strong);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.04);
}
.box-steer {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(79, 142, 247, 0.25);
  animation: steer-breathe 2.6s ease-in-out infinite;
}
@keyframes steer-breathe {
  0%, 100% { box-shadow: 0 0 0 3px rgba(79, 142, 247, 0.22); }
  50% { box-shadow: 0 0 0 4px rgba(79, 142, 247, 0.40); }
}
.box-disabled { opacity: 0.55; }

/* send-btn：激活 accent 实色，禁用透明文字（draft .c-send / :disabled） */
.send-btn {
  background: var(--accent);
  color: #fff;
  transition: background var(--duration) var(--ease);
}
.send-btn:hover:not(:disabled) { background: var(--accent-hover); }
.send-btn:disabled {
  background: transparent;
  color: var(--subtle);
  opacity: 0.5;
}

/* kbd（draft .composer-hint .kbd） */
.kbd {
  background: var(--surface-hover);
  border: 1px solid var(--border);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
