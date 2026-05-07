<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MockSkill } from '../../mock/data'
import { ToggleSwitch, MetaGrid, MarkdownEditor } from './shared'

const props = withDefaults(
  defineProps<{
    skill: MockSkill
    expanded?: boolean
  }>(),
  { expanded: false },
)

defineEmits<{
  toggle: []
  'toggle-enabled': []
}>()

const showEditor = ref(false)
const content = ref(props.skill.content)

const metaItems = computed(() => [
  { key: '名称', value: props.skill.name },
  { key: '触发词', value: props.skill.triggers.join('、') },
  { key: '来源', value: `${props.skill.source} · ${props.skill.sourcePath}` },
  { key: '文件大小', value: props.skill.fileSize },
  { key: '依赖工具', value: props.skill.tools.join(', ') },
])

function handleSave() {
  showEditor.value = false
}
</script>

<template>
  <div :class="['skill-card', { expanded, disabled: !skill.enabled }]">
    <div class="skill-card__hd" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="skill.enabled"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div class="skill-card__info">
        <div class="skill-card__name">
          {{ skill.name }}
          <span class="skill-card__name-tag">{{ skill.tag }}</span>
        </div>
        <div class="skill-card__desc">{{ skill.description }}</div>
        <div class="skill-card__source">{{ skill.sourcePath }}</div>
      </div>
      <div class="skill-card__actions" @click.stop>
        <button class="btn btn--ghost btn--sm" @click="showEditor = !showEditor">
          {{ showEditor ? '收起' : '编辑' }}
        </button>
      </div>
    </div>
    <div class="skill-card__bd">
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

<style scoped>
.skill-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 12px;
  overflow: hidden;
  transition: border-color 0.2s var(--ease);
}

.skill-card:hover {
  border-color: oklch(80% 0.01 70);
}

.skill-card.disabled {
  opacity: 0.6;
}

.skill-card__hd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  cursor: pointer;
}

.skill-card__info {
  flex: 1;
  min-width: 0;
}

.skill-card__name {
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-card__name-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-light);
  color: var(--accent);
}

.skill-card__desc {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-card__source {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--font-mono);
  margin-top: 2px;
}

.skill-card__actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.skill-card__bd {
  padding: 0 18px 16px;
  display: none;
}

.skill-card.expanded .skill-card__bd {
  display: block;
}
</style>
