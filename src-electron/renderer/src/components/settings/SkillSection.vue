<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SkillInfo } from '@xyz-agent/shared'
import { Button } from '../../design-system'
import { ToggleSwitch, MetaGrid, MarkdownEditor } from './shared'

const props = defineProps<{
  skill: SkillInfo
}>()

defineEmits<{
  'toggle-enabled': []
  delete: [skillId: string]
}>()

const expanded = ref(false)
const showEditor = ref(false)
const content = ref(props.skill.content ?? '')

const metaItems = computed(() => [
  { key: '名称', value: props.skill.name },
  { key: '触发词', value: props.skill.triggers.join('\u3001') || '-' },
  { key: '来源', value: props.skill.sourcePath ? `${props.skill.source} \u00b7 ${props.skill.sourcePath}` : props.skill.source },
  { key: '文件大小', value: props.skill.fileSize ?? '-' },
  { key: '依赖工具', value: props.skill.tools?.join(', ') ?? '-' },
])

function handleSave() {
  showEditor.value = false
}
</script>

<template>
  <div
    :class="[
      'border border-border rounded-lg overflow-hidden mb-3 transition-all duration-150 hover:border-[oklch(86%_0.012_70)]',
      { 'opacity-60': !skill.enabled },
    ]"
  >
    <!-- Header -->
    <div
      class="flex items-center gap-3 py-[9px] px-4 bg-[var(--section-bg)] min-h-[42px] cursor-pointer"
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
          <span v-if="skill.tag" class="text-[10px] font-semibold py-[1px] px-1.5 rounded bg-[var(--accent-light)] text-[var(--accent)]">{{ skill.tag }}</span>
        </div>
        <div class="text-[11px] text-muted mt-px line-clamp-1">{{ skill.description }}</div>
      </div>
      <div class="flex items-center gap-1 shrink-0" @click.stop>
        <Button variant="ghost" size="sm" @click="showEditor = !showEditor">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="$emit('delete', skill.id)">删除</Button>
        <svg
          class="shrink-0 text-muted transition-transform duration-150"
          :class="{ 'rotate-180': expanded }"
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"
        >
          <path d="M2 4l3 3 3-3" />
        </svg>
      </div>
    </div>

    <!-- Detail -->
    <div v-if="expanded" class="px-4 py-3">
      <MetaGrid :items="metaItems" />
      <MarkdownEditor
        v-if="showEditor"
        v-model="content"
        filename="SKILL.md"
        @save="handleSave"
      />
    </div>
  </div>
</template>
