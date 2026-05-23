<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SkillInfo } from '@xyz-agent/shared'
import { Button } from '../../design-system'
import { ToggleSwitch, MetaGrid } from './shared'

const { t } = useI18n()

const props = defineProps<{
  skill: SkillInfo
}>()

defineEmits<{
  'toggle-enabled': []
  edit: []
  delete: [skillId: string]
}>()

const expanded = ref(false)
const showConfirm = ref(false)

const sourceLabel = computed(() => {
  const s = props.skill.source
  if (!s) return ''
  return s
})

const metaItems = computed(() => [
  { key: t('settings.metaName'), value: props.skill.name },
  { key: t('settings.metaTriggers'), value: props.skill.triggers.join('\u3001') || '-' },
  { key: t('settings.metaSource'), value: props.skill.sourcePath ? `${props.skill.source} \u00b7 ${props.skill.sourcePath}` : props.skill.source },
  { key: t('settings.metaFileSize'), value: props.skill.fileSize ?? '-' },
  { key: t('settings.metaTools'), value: props.skill.tools?.join(', ') ?? '-' },
])
</script>

<template>
  <div
    :class="[
      'border-b border-[var(--divider)] last:border-b-0 transition-colors duration-120',
      { 'opacity-40': !skill.enabled },
    ]"
  >
    <!-- Header -->
    <div
      class="flex items-center gap-3 py-[9px] px-4 min-h-[42px] cursor-pointer hover:bg-[var(--hover-bg)]"
      @click="expanded = !expanded"
    >
      <ToggleSwitch
        :model-value="skill.enabled"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-semibold flex items-center gap-2">
          {{ skill.name }}
          <span v-if="sourceLabel" class="text-[10px] font-semibold py-[1px] px-1.5 rounded bg-[var(--accent-light)] text-[var(--accent)]">{{ sourceLabel }}</span>
          <span v-if="skill.tag" class="text-[10px] font-semibold py-[1px] px-1.5 rounded bg-[var(--accent-light)] text-[var(--accent)]">{{ skill.tag }}</span>
        </div>
        <div class="text-[11px] text-muted mt-px line-clamp-1">{{ skill.description }}</div>
      </div>
      <div class="flex items-center gap-1 shrink-0" @click.stop>
        <Button variant="ghost" size="sm" @click="$emit('edit')">{{ t('common.edit') }}</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="showConfirm = true">{{ t('common.delete') }}</Button>
        <svg
          class="shrink-0 text-muted transition-transform duration-150"
          :class="{ 'rotate-180': expanded }"
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"
        >
          <path d="M2 4l3 3 3-3" />
        </svg>
      </div>
    </div>

    <!-- Confirm bar -->
    <div v-if="showConfirm" class="flex items-center gap-2 py-2 px-4 bg-[var(--danger-light)] text-xs text-[var(--danger)]">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="5.5" /><path d="M7 4.5v3M7 9v.5" />
      </svg>
      {{ t('settings.confirmDelete') }} {{ skill.name }}？{{ t('settings.confirmDeleteHint') }}
      <Button variant="ghost" size="sm" class="!bg-[var(--danger)] !text-white hover:!opacity-80 !py-[3px] !px-2 !text-[11px] !rounded-sm !border-none" @click="$emit('delete', skill.id); showConfirm = false">{{ t('settings.confirmDelete') }}</Button>
      <Button variant="ghost" size="sm" class="!text-[var(--danger)] !py-[3px] !px-2 !text-[11px]" @click="showConfirm = false">{{ t('common.cancel') }}</Button>
    </div>

    <!-- Detail -->
    <div v-if="expanded && !showConfirm" class="px-4 py-3 border-t border-[var(--divider)] bg-[var(--section-bg)]">
      <MetaGrid :items="metaItems" />
    </div>
  </div>
</template>
