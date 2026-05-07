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
  edit: [name: string]
  delete: [name: string]
}>()

const showEditor = ref(false)
const content = ref(props.skill.content)

const metaItems = computed(() => [
  { key: '名称', value: props.skill.name },
  { key: '触发词', value: props.skill.triggers.join('\u3001') },
  { key: '来源', value: `${props.skill.source} \u00b7 ${props.skill.sourcePath}` },
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
        <!-- Edit -->
        <button class="icon-btn" title="编辑" @click="showEditor = !showEditor">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <!-- Delete -->
        <button class="icon-btn icon-btn--danger" title="删除" @click="$emit('delete', skill.name)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
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
.skill-card:hover { border-color: oklch(80% 0.01 70); }
.skill-card.disabled { opacity: 0.6; }

.skill-card__hd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  cursor: pointer;
}
.skill-card__info { flex: 1; min-width: 0; }
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
.skill-card__actions { display: flex; gap: 2px; flex-shrink: 0; }
.skill-card__bd { padding: 0 18px 16px; display: none; }
.skill-card.expanded .skill-card__bd { display: block; }

/* Icon buttons */
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-xs);
  border: none; background: transparent; color: var(--muted);
  cursor: pointer; transition: all 0.15s var(--ease);
}
.icon-btn svg { width: 15px; height: 15px; }
.icon-btn:hover { background: var(--accent-light); color: var(--accent); }
.icon-btn--danger:hover { background: var(--danger-light); color: var(--danger); }
</style>
