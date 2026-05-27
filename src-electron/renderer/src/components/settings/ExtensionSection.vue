<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExtensionInfo } from '@xyz-agent/shared'
import { ToggleSwitch, MetaGrid } from './shared'

const { t } = useI18n()

const props = defineProps<{
  extension: ExtensionInfo
}>()

defineEmits<{
  'toggle-enabled': [payload: { name: string; enabled: boolean }]
}>()

const expanded = ref(false)

const metaItems = computed(() => [
  { key: t('settings.extensionMetaName'), value: props.extension.name },
  { key: t('settings.extensionMetaVersion'), value: props.extension.version },
  { key: t('settings.extensionMetaPath'), value: props.extension.path },
])
</script>

<template>
  <div
    :class="[
      'border-b border-[var(--divider)] last:border-b-0 transition-colors duration-120',
      { 'opacity-40': !extension.enabled },
    ]"
  >
    <!-- Header -->
    <div
      class="flex items-center gap-3 py-[9px] px-4 min-h-[42px] cursor-pointer hover:bg-[var(--hover-bg)]"
      @click="expanded = !expanded"
    >
      <ToggleSwitch
        :model-value="extension.enabled"
        @update:model-value="$emit('toggle-enabled', { name: extension.name, enabled: !extension.enabled })"
        @click.stop
      />
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-semibold flex items-center gap-2">
          {{ extension.name }}
          <span class="text-[10px] font-semibold py-[1px] px-1.5 rounded-sm bg-[var(--accent-light)] text-[var(--accent)]">{{ extension.version }}</span>
        </div>
        <div class="text-[11px] text-muted mt-px line-clamp-1">{{ extension.description }}</div>
      </div>
      <svg
        class="shrink-0 text-muted transition-transform duration-150"
        :class="{ 'rotate-180': expanded }"
        width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"
      >
        <path d="M2 4l3 3 3-3" />
      </svg>
    </div>

    <!-- Detail -->
    <div v-if="expanded" class="px-4 py-3 border-t border-[var(--divider)] bg-[var(--section-bg)]">
      <MetaGrid :items="metaItems" />
    </div>
  </div>
</template>
