<script setup lang="ts">
import { computed } from 'vue'
import ContextIndicator from './ContextIndicator.vue'
import { formatTokensAlways as formatTokens } from '../lib/format'

const props = defineProps<{
  isStreaming: boolean
  modelName: string
  inputTokens: number
  outputTokens: number
  toolCount: number
  activeTaskCount: number
}>()

const version = __APP_VERSION__

/** 上下文窗口 200K，根据 inputTokens 估算占用比例 */
const contextPercentage = computed(() =>
  Math.min((props.inputTokens / 200_000) * 100, 100)
)

const totalTokens = computed(() => props.inputTokens + props.outputTokens)
</script>

<template>
  <div class="flex h-7 items-center justify-between border-t border-border-default bg-base px-4 font-mono text-[11px] text-tertiary">
    <!-- 左: 状态指示 -->
    <div class="flex items-center gap-3">
      <span class="flex items-center gap-1.5">
        <span
          class="inline-block h-1.5 w-1.5 rounded-full"
          :class="isStreaming ? 'bg-semantic-green animate-pulse-dot' : 'bg-semantic-green'"
        />
        <span>{{ isStreaming ? 'generating...' : 'ready' }}</span>
      </span>
      <span class="text-border-default">|</span>
      <span>{{ modelName }}</span>
    </div>

    <!-- 中: 上下文用量 -->
    <div class="flex items-center gap-3">
      <span>ctx:</span>
      <ContextIndicator :percentage="contextPercentage" />
      <span class="text-border-default">|</span>
      <span>{{ formatTokens(totalTokens) }} tokens</span>
    </div>

    <!-- 右: 工具数 + 版本 -->
    <div class="flex items-center gap-3">
      <span>{{ toolCount }} tools</span>
      <template v-if="activeTaskCount > 0">
        <span class="text-border-default">|</span>
        <span class="text-blue-400">{{ activeTaskCount }} task{{ activeTaskCount > 1 ? 's' : '' }}</span>
      </template>
      <span class="text-border-default">|</span>
      <span>v{{ version }}</span>
    </div>
  </div>
</template>
