<script setup lang="ts">
import { computed } from 'vue'
import { usePluginStore } from '../../stores/plugin'
import type { PluginStatusItem } from '../../types/plugin'

const props = defineProps<{
  sessionId: string
}>()

const pluginStore = usePluginStore()

const extensionChips = computed(() =>
  pluginStore.getSessionStatusBarItems(props.sessionId),
)

function getChipClasses(id: string): { bg: string; text: string; dot: string } {
  if (id.startsWith('goal')) return { bg: 'bg-accent-light', text: 'text-accent', dot: 'bg-accent' }
  if (id.startsWith('todo')) return { bg: 'bg-success-light', text: 'text-success', dot: 'bg-success' }
  if (id.startsWith('workflow')) return { bg: 'bg-warning-light', text: 'text-warning', dot: 'bg-warning' }
  return { bg: 'bg-accent-light', text: 'text-muted', dot: 'bg-muted' }
}

function handleChipClick(item: PluginStatusItem) {
  if (item.commandId) {
    pluginStore.executeCommand(item.pluginId, item.commandId)
  }
}
</script>

<template>
  <div
    v-if="extensionChips.length > 0"
    class="flex items-center gap-1.5 px-2 pt-1 pb-2 text-[10px] font-mono text-muted min-h-[22px] flex-wrap"
  >
    <span
      v-for="chip in extensionChips"
      :key="chip.id"
      :class="[
        'inline-flex items-center gap-[3px] px-1.5 py-px rounded-sm text-[10px] font-semibold transition-all duration-150 ease-ease',
        getChipClasses(chip.id).bg,
        getChipClasses(chip.id).text,
        chip.commandId ? 'cursor-pointer' : 'cursor-default',
      ]"
      :title="chip.tooltip ?? ''"
      role="button"
      tabindex="0"
      @click="handleChipClick(chip)"
      @keydown.enter="handleChipClick(chip)"
    >
      <span
        class="w-1 h-1 rounded-full shrink-0"
        :class="getChipClasses(chip.id).dot"
      ></span>
      {{ chip.text }}
    </span>
  </div>
</template>
