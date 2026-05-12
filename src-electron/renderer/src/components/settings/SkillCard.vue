<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SkillInfo } from '@xyz-agent/shared'
import { Button } from '../../design-system'
import { ToggleSwitch, MetaGrid, MarkdownEditor } from './shared'

const props = withDefaults(
  defineProps<{
    skill: SkillInfo
    expanded?: boolean
  }>(),
  { expanded: false },
)

defineEmits<{
  toggle: []
  'toggle-enabled': []
  edit: [name: string]
  delete: [name: string]
}>()

const showEditor = ref(false)
const content = ref(props.skill.content ?? '')

const metaItems = computed(() => [
  { key: '名称', value: props.skill.name },
  { key: '触发词', value: props.skill.triggers.join('\u3001') },
  { key: '来源', value: props.skill.sourcePath ? `${props.skill.source} \u00b7 ${props.skill.sourcePath}` : props.skill.source },
  { key: '文件大小', value: props.skill.fileSize ?? '-' },
  { key: '依赖工具', value: props.skill.tools?.join(', ') ?? '-' },
])

function handleSave() {
  showEditor.value = false
}
</script>

<template>
  <div :class="['bg-surface border border-border rounded mb-3 overflow-hidden transition-[border-color] duration-200 ease-ease hover:border-[oklch(80%_0.01_70)]', { 'opacity-60': !skill.enabled }]">
    <div class="flex items-center gap-3 py-3.5 px-[18px] cursor-pointer" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="skill.enabled"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold flex items-center gap-2">
          {{ skill.name }}
          <span v-if="skill.tag" class="text-[10px] font-semibold py-[1px] px-1.5 rounded bg-accent-light text-accent">{{ skill.tag }}</span>
        </div>
        <div class="text-xs text-muted mt-0.5 line-clamp-1">{{ skill.description }}</div>
        <div class="text-[11px] text-muted font-mono mt-0.5">{{ skill.sourcePath ?? skill.source }}</div>
      </div>
      <div class="flex gap-1 shrink-0" @click.stop>
        <Button variant="ghost" size="sm" @click="showEditor = !showEditor">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="$emit('delete', skill.name)">删除</Button>
        <span :class="['text-[10px] text-muted transition-transform duration-200 ml-1', { 'rotate-180': expanded }]">▾</span>
      </div>
    </div>
    <div v-if="expanded" class="px-[18px] pb-4">
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

