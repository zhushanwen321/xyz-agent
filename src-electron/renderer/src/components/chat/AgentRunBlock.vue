<template>
  <div class="agent-run-block">
    <!-- Body: sections in order, no wrapper chrome -->
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
          class="streaming-cursor animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"
        />
      </div>

      <!-- Standalone tool card -->
      <StandaloneToolCard
        v-else-if="section.type === 'standalone' && section.toolCall"
        :tool-call="section.toolCall"
      />

      <!-- Custom tool card -->
      <StandaloneToolCard
        v-else-if="section.type === 'customTool' && section.toolCall"
        :tool-call="section.toolCall"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '@xyz-agent/shared'
import { groupIntoSections, type SectionType } from '../../lib/message-layout'
import { useSettingsStore } from '../../stores/settings'
import { useMarkdownRender } from '../../composables/useMarkdownRender'
import { useMarkdownBodyClick } from '../../composables/useMarkdownBodyClick'
import MergeBlock from './MergeBlock.vue'
import StandaloneToolCard from './StandaloneToolCard.vue'

const props = defineProps<{
  message: Message
  isStreaming: boolean
}>()

const settingsStore = useSettingsStore()

// ── Standalone tools set ──

const standaloneToolsSet = computed(() => new Set(settingsStore.standaloneTools))

interface EnrichedSection {
  type: SectionType
  blocks: import('@xyz-agent/shared').ContentBlock[]
  toolCall?: import('@xyz-agent/shared').ToolCall
}

const rawSections = computed(() => groupIntoSections(props.message, standaloneToolsSet.value))

const sections = computed<EnrichedSection[]>(() =>
  rawSections.value.map(s => ({
    ...s,
    toolCall: s.blocks[0] && (s.type === 'standalone' || s.type === 'customTool')
      ? props.message.toolCalls?.find(tc => tc.id === s.blocks[0].refId)
      : undefined,
  })),
)

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
</script>
