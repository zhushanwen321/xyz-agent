<script setup lang="ts">
 

import { ref, computed } from 'vue'
import type { MockAgent } from '../../mock/data'
import ToggleSwitch from './shared/ToggleSwitch.vue'
import MetaGrid from './shared/MetaGrid.vue'
import ModelStrategyConfig from './ModelStrategyConfig.vue'
import OverrideParams from './OverrideParams.vue'
import MarkdownEditor from './shared/MarkdownEditor.vue'

const props = withDefaults(
  defineProps<{
    agent: MockAgent
    allModels: Array<{ id: string; name: string; providerName: string }>
    expanded?: boolean
  }>(),
  { expanded: false },
)

defineEmits<{
  toggle: []
  'toggle-enabled': []
}>()

const content = ref(props.agent.content)
const showEditor = ref(false)

const strategyLabel = computed(() => {
  if (props.agent.modelStrategy === 'auto') return '自动 \u2014 由主 Agent 根据任务判断'
  if (props.agent.modelStrategy === 'tag') {
    const tags = props.agent.modelTags
    const parts: string[] = []
    if (tags?.power) parts.push(`强力: ${tags.power}`)
    if (tags?.fast) parts.push(`快速: ${tags.fast}`)
    return `标签 \u2014 ${parts.join(' / ')}`
  }
  if (props.agent.modelStrategy === 'bind') return `绑定 \u2014 ${props.agent.modelBind ?? ''}`
  return ''
})

const metaItems = computed(() => [
  { key: '名称', value: props.agent.name },
  { key: '类型', value: props.agent.type === 'builtin' ? '内置 (builtin)' : props.agent.sourceType },
  { key: '模型策略', value: strategyLabel.value },
  { key: '工具', value: props.agent.tools.join(', ') },
])

function handleSave() {
  showEditor.value = false
}
</script>

<template>
  <div :class="['agent-card', { expanded, disabled: !agent.active }]">
    <div class="agent-card__hd" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="agent.active"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div :class="['agent-card__icon', `agent-card__icon--${agent.iconBg}`]">
        {{ agent.icon }}
      </div>
      <div class="agent-card__info">
        <div class="agent-card__name">{{ agent.name }}</div>
        <div class="agent-card__desc">{{ agent.description }}</div>
        <div class="agent-card__source">{{ agent.source }}</div>
      </div>
      <div class="agent-card__actions" @click.stop>
        <button class="btn btn--ghost btn--sm" @click="showEditor = !showEditor">
          {{ showEditor ? '收起' : '编辑' }}
        </button>
      </div>
    </div>
    <div class="agent-card__bd">
      <MetaGrid :items="metaItems" />
      <ModelStrategyConfig
        :strategy="agent.modelStrategy"
        :all-models="allModels"
        :model-tags="agent.modelTags"
        :model-bind="agent.modelBind"
      />
      <OverrideParams
        :active="agent.overrideParams"
        :params="agent.params"
      />
      <MarkdownEditor
        v-if="showEditor"
        v-model="content"
        filename="agent.md"
        @save="handleSave"
      />
    </div>
  </div>
</template>

<style scoped>
.agent-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 12px;
  overflow: hidden;
  transition: border-color 0.2s var(--ease);
}

.agent-card:hover {
  border-color: oklch(80% 0.01 70);
}

.agent-card.disabled {
  opacity: 0.6;
}

.agent-card__hd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  cursor: pointer;
}

.agent-card__icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
}

.agent-card__icon--accent {
  background: var(--accent-light);
  color: var(--accent);
}

.agent-card__icon--success {
  background: var(--success-light);
  color: var(--success);
}

.agent-card__icon--warning {
  background: var(--warning-light);
  color: var(--warning);
}

.agent-card__icon--danger {
  background: var(--danger-light);
  color: var(--danger);
}

.agent-card__info {
  flex: 1;
  min-width: 0;
}

.agent-card__name {
  font-size: 14px;
  font-weight: 600;
}

.agent-card__desc {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.agent-card__source {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--font-mono);
  margin-top: 2px;
}

.agent-card__actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.agent-card__bd {
  padding: 0 18px 16px;
  display: none;
}

.agent-card.expanded .agent-card__bd {
  display: block;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.2s var(--ease);
  white-space: nowrap;
}

.btn--sm {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: var(--radius-xs);
}

.btn--ghost {
  border: none;
  color: var(--muted);
  padding: 5px 8px;
}

.btn--ghost:hover {
  color: var(--accent);
  background: var(--accent-light);
}
</style>
