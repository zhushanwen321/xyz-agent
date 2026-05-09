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
  <div :class="['s-skill-card', { expanded, disabled: !skill.enabled }]">
    <div class="s-skill-card__hd" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="skill.enabled"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div class="s-skill-card__info">
        <div class="s-skill-card__name">
          {{ skill.name }}
          <span v-if="skill.tag" class="s-skill-card__name-tag">{{ skill.tag }}</span>
        </div>
        <div class="s-skill-card__desc">{{ skill.description }}</div>
        <div class="s-skill-card__source">{{ skill.sourcePath ?? skill.source }}</div>
      </div>
      <div class="s-skill-card__actions" @click.stop>
        <Button variant="ghost" size="sm" @click="showEditor = !showEditor">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!border-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="$emit('delete', skill.name)">删除</Button>
      </div>
      <span class="s-skill-card__chevron">▾</span>
    </div>
    <div class="s-skill-card__bd">
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

