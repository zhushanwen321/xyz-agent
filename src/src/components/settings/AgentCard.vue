<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AgentInfo } from '@xyz-agent/shared'
import { ToggleSwitch, MetaGrid, MarkdownEditor } from './shared'
import ModelStrategyConfig from './ModelStrategyConfig.vue'
import OverrideParams from './OverrideParams.vue'

const props = withDefaults(
  defineProps<{
    agent: AgentInfo
    allModels: Array<{ id: string; name: string; providerName: string }>
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

const content = ref(props.agent.content ?? '')
const showEditor = ref(false)

const strategyLabel = computed(() => {
  if (props.agent.modelStrategy === 'auto') return '\u81ea\u52a8 \u2014 \u7531\u4e3b Agent \u6839\u636e\u4efb\u52a1\u5224\u65ad'
  if (props.agent.modelStrategy === 'tag') {
    const tags = props.agent.modelTags
    const parts: string[] = []
    if (tags?.power) parts.push(`\u5f3a\u529b: ${tags.power}`)
    if (tags?.fast) parts.push(`\u5feb\u901f: ${tags.fast}`)
    return `\u6807\u7b7e \u2014 ${parts.join(' / ')}`
  }
  if (props.agent.modelStrategy === 'bind') return `\u7ed1\u5b9a \u2014 ${props.agent.modelBind ?? ''}`
  return ''
})

const metaItems = computed(() => [
  { key: '\u540d\u79f0', value: props.agent.name },
  { key: '\u7c7b\u578b', value: props.agent.type === 'builtin' ? '\u5185\u7f6e (builtin)' : (props.agent.sourceType ?? props.agent.type ?? '-') },
  { key: '\u6a21\u578b\u7b56\u7565', value: strategyLabel.value },
  { key: '\u5de5\u5177', value: props.agent.tools?.join(', ') ?? '-' },
])

function handleSave() {
  showEditor.value = false
}
</script>

<template>
  <div :class="['agent-card', { expanded, disabled: !agent.enabled }]">
    <div class="agent-card__hd" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="agent.enabled"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div class="agent-card__info">
        <div class="agent-card__name">{{ agent.name }}</div>
        <div class="agent-card__desc">{{ agent.description }}</div>
        <div class="agent-card__source">{{ agent.source ?? agent.id }}</div>>
      </div>
      <div class="agent-card__actions" @click.stop>
        <!-- Edit -->
        <button class="icon-btn" title="编辑" @click="showEditor = !showEditor">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <!-- Delete -->
        <button class="icon-btn icon-btn--danger" title="删除" @click="$emit('delete', agent.name)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>
    <div class="agent-card__bd">
      <MetaGrid :items="metaItems" />
      <ModelStrategyConfig
        :strategy="(agent.modelStrategy as 'auto' | 'tag' | 'bind')"
        :all-models="allModels"
        :model-tags="agent.modelTags as { power: string; efficient: string; fast: string } | undefined"
        :model-bind="agent.modelBind"
      />
      <OverrideParams
        :active="agent.overrideParams ?? false"
        :params="agent.params ?? { depth: 20, width: 10, tokens: 100000, rounds: 50 }"
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
.agent-card:hover { border-color: oklch(80% 0.01 70); }
.agent-card.disabled { opacity: 0.6; }

.agent-card__hd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  cursor: pointer;
}
.agent-card__info { flex: 1; min-width: 0; }
.agent-card__name { font-size: 14px; font-weight: 600; }
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
.agent-card__actions { display: flex; gap: 2px; flex-shrink: 0; }
.agent-card__bd { padding: 0 18px 16px; display: none; }
.agent-card.expanded .agent-card__bd { display: block; }

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
