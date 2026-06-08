<template>
  <div class="agent-run-block rounded-sm border border-border">
    <!-- 3px status bar -->
    <div
      :class="[
        'run-status-bar h-[3px] rounded-t-sm overflow-hidden',
        isStreaming ? 'run-status-bar--streaming' : 'bg-border',
      ]"
    />

    <!-- Body: sections in order -->
    <div class="run-body px-3 py-2">
      <template v-for="(section, si) in sections" :key="si">
        <!-- Merge section -->
        <MergeBlock
          v-if="section.type === 'merge'"
          :blocks="section.blocks"
          :message="message"
          :is-streaming="isStreaming"
        />

        <!-- Text section -->
        <div
          v-else-if="section.type === 'text' && message.content"
          class="msg__body select-text py-1 leading-[1.6] text-fg text-xs"
          :data-message-id="message.id"
          :data-markdown-source="message.content"
          @click="handleBodyClick"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-html="renderedContent" />
          <span
            v-if="isStreaming"
            class="inline-block w-0.5 h-[1.1em] bg-accent rounded-sm align-text-bottom animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"
          />
        </div>

        <!-- Standalone tool card -->
        <StandaloneToolCard
          v-else-if="section.type === 'standalone' && resolveToolCall(section.blocks[0]?.refId)"
          :tool-call="resolveToolCall(section.blocks[0].refId)!"
        />

        <!-- Custom tool card -->
        <StandaloneToolCard
          v-else-if="section.type === 'customTool' && resolveToolCall(section.blocks[0]?.refId)"
          :tool-call="resolveToolCall(section.blocks[0].refId)!"
        />
      </template>
    </div>

    <!-- Footer: steps · time · file count -->
    <div class="run-footer flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted">
      <span>{{ stepCount }} 步</span>
      <span>·</span>
      <span>{{ formattedElapsed }}</span>
      <template v-if="standaloneToolCount > 0">
        <span>·</span>
        <span>{{ standaloneToolCount }} 次工具操作</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import type { Message, ToolCall } from '@xyz-agent/shared'
import { groupIntoSections } from '../../lib/message-layout'
import { useSettingsStore } from '../../stores/settings'
import { useMarkdownRender } from '../../composables/useMarkdownRender'
import { useMarkdownBodyClick } from '../../composables/useMarkdownBodyClick'
import { useLiveTimer } from '../../composables/useLiveTimer'
import { formatTime } from '@/lib/compact-utils'
import MergeBlock from './MergeBlock.vue'
import StandaloneToolCard from './StandaloneToolCard.vue'

const props = defineProps<{
  message: Message
  isStreaming: boolean
}>()

const settingsStore = useSettingsStore()

// ── Standalone tools set ──

const standaloneToolsSet = computed(() => new Set(settingsStore.standaloneTools))

// ── Section grouping ──

const sections = computed(() => groupIntoSections(props.message, standaloneToolsSet.value))

// ── Tool call resolution ──

function resolveToolCall(refId: string): ToolCall | undefined {
  return props.message.toolCalls?.find(tc => tc.id === refId)
}

// ── Markdown rendering ──

const { renderedContent } = useMarkdownRender(
  () => props.message.content,
  {
    messageId: () => props.message.id,
    status: () => props.message.status,
  },
)

// ── Event delegation ──

const { handleBodyClick } = useMarkdownBodyClick()

// ── Footer stats ──

const stepCount = computed(
  () => sections.value.filter(s => s.type !== 'text').length,
)

const standaloneToolCount = computed(() => {
  const tcs = props.message.toolCalls
  if (!tcs) return 0
  const standalone = standaloneToolsSet.value
  return tcs.filter(tc => standalone.has(tc.toolName)).length
})

// ── Elapsed time ──

const { now: liveNow, start: startTimer, stop: stopTimer } = useLiveTimer(200)

watch(() => props.isStreaming, (streaming) => {
  if (streaming) startTimer()
  else stopTimer()
}, { immediate: true })

const elapsedMs = computed(() => {
  const tcs = props.message.toolCalls
  const thinking = props.message.thinking

  // Collect start and end timestamps separately
  const startTimes: number[] = []
  const endTimes: number[] = []

  if (thinking?.length) {
    for (const b of thinking) {
      if (b.startTime) startTimes.push(b.startTime)
      if (b.endTime) endTimes.push(b.endTime)
    }
  }

  if (tcs?.length) {
    for (const tc of tcs) {
      if (tc.startTime) startTimes.push(tc.startTime)
      if (tc.endTime) endTimes.push(tc.endTime)
    }
  }

  const allTimes = [...startTimes, ...endTimes]
  if (allTimes.length === 0) return 0

  if (props.isStreaming) {
    return liveNow.value - Math.min(...allTimes)
  }

  // Complete: max(endTimes) - min(startTimes)
  if (endTimes.length === 0) return 0
  return Math.max(...endTimes) - Math.min(...startTimes)
})

const formattedElapsed = computed(() => formatTime(elapsedMs.value))
</script>

<style scoped>
.run-status-bar--streaming {
  background: var(--accent);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.3) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: run-sweep 1.5s ease-in-out infinite;
}

@keyframes run-sweep {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
</style>
