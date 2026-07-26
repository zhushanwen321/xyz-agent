<template>
  <!--
    展示组件 · bash 执行结果（composer-bash-execute W3）。
    渲染 role:'system' + bashExecution 的消息：composer 直接执行的 bash 命令结果气泡。

    生命周期：
    - bashStart 创建 streaming 态 system 消息（loading，显示 spinner + 取消按钮）
    - bashResult 锢定该消息更新为 complete 态（显示 output + exitCode 标签）

    视觉定位：卡片式（带边框 + 浅底），区别于普通 system 提示行（SystemNotice 弱化样式）。
    与 toolCall 互斥（bash 不走工具链，不挂 assistant turn）。
  -->
  <div
    class="bash-output-block flex flex-col gap-1.5 rounded-md border border-border bg-surface-hover/40 px-3 py-2"
    data-testid="bash-output-block"
  >
    <!-- 头部行：command 文本 + 状态标签（+ no context 标记 + 取消按钮） -->
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] leading-snug text-fg">{{ bash?.command || t('panel.message.bashUnknownCommand') }}</span>
        <span
          v-if="bash?.excludeFromContext"
          class="shrink-0 rounded-sm border border-border px-1 py-0.5 text-[10px] leading-none text-muted"
          data-testid="bash-no-context-tag"
        >{{ t('panel.message.bashNoContext') }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <span v-if="isStreaming" class="flex items-center gap-1 text-[11px] leading-none text-muted">
          <Loader2 class="size-3 animate-spin" />
        </span>
        <span
          v-else-if="isCancelled"
          class="font-mono text-[11px] leading-none text-muted"
          data-testid="bash-status-tag"
        >{{ t('panel.message.bashCancelled') }}</span>
        <span
          v-else
          class="font-mono text-[11px] leading-none"
          :class="exitCodeClass"
          data-testid="bash-status-tag"
        >exit {{ bash?.exitCode }}</span>
        <Button
          v-if="isStreaming"
          variant="ghost"
          size="sm"
          class="h-auto p-0 text-[11px] text-muted hover:text-fg"
          data-testid="bash-cancel-btn"
          @click="onCancel"
        >{{ t('panel.message.bashCancel') }}</Button>
      </div>
    </div>

    <!-- 输出区：complete 态才显示 -->
    <div
      v-if="!isStreaming && hasOutput"
      class="max-h-[var(--bash-output-max-height)] overflow-y-auto rounded-sm bg-surface-2/50 px-2 py-1 font-mono text-[11px] leading-relaxed text-muted"
      data-testid="bash-output"
    >
      <pre class="whitespace-pre-wrap break-all font-mono">{{ bash?.output }}</pre>
    </div>
    <p
      v-else-if="!isStreaming && !hasOutput"
      class="text-[11px] leading-snug text-muted"
      data-testid="bash-output-empty"
    >{{ t('panel.message.bashNoOutput') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useChat } from '@/composables/features/useChat'
import type { Message } from '@xyz-agent/shared'

const props = defineProps<{
  message: Message
  /** 当前 session id（取消按钮调 abortBash 用） */
  sessionId: string
}>()

const { t } = useI18n()
const { abortBash } = useChat()

const bash = computed(() => props.message.bashExecution)
const isStreaming = computed(() => props.message.status === 'streaming')
const isCancelled = computed(() => bash.value?.cancelled === true)
const hasOutput = computed(() => !!bash.value?.output)

/** exitCode 标签颜色：cancelled 走 muted；exit 0 绿；exit N(>0) 红 */
const exitCodeClass = computed(() => {
  if (isCancelled.value) return 'text-muted'
  const code = bash.value?.exitCode
  if (code === 0) return 'text-success'
  return 'text-danger'
})

function onCancel(): void {
  abortBash(props.sessionId)
}
</script>
