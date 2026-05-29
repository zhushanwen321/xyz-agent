<template>
  <div v-if="decorations.length > 0" class="flex flex-wrap items-center gap-1 mt-1">
    <span
      v-for="deco in decorations"
      :key="`${deco.pluginId}-${deco.label}`"
      role="button"
      :tabindex="deco.commandId ? 0 : undefined"
      class="inline-flex items-center gap-1 text-[10px] py-[1px] px-1.5 rounded-sm border transition-colors"
      :style="deco.color
        ? { backgroundColor: deco.color + '20', color: deco.color, borderColor: deco.color + '40' }
        : undefined
      "
      :class="[
        deco.color ? '' : 'border-border bg-[var(--section-bg)] text-muted',
        deco.commandId ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
      ]"
      :title="`来自插件: ${getPluginName(deco.pluginId)}`"
      @click="handleClick(deco)"
    >
      <span class="font-medium">{{ getPluginName(deco.pluginId) }}</span>
      <span class="opacity-50">·</span>
      <span>{{ deco.label }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usePluginStore } from '../../stores/plugin'
import type { PluginMessageDecoration } from '../../types/plugin'

const props = defineProps<{ messageId: string }>()
const pluginStore = usePluginStore()

const decorations = computed(() =>
  pluginStore.messageDecorations.get(props.messageId) ?? [],
)

function getPluginName(pluginId: string): string {
  return pluginStore.pluginById(pluginId)?.displayName ?? pluginId
}

function handleClick(deco: PluginMessageDecoration) {
  if (deco.commandId) {
    pluginStore.executeCommand(deco.pluginId, deco.commandId)
  }
}
</script>
