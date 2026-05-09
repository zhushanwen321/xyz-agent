<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AgentInfo } from '@xyz-agent/shared'
import { Button } from '../../design-system'
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
const modelTags = computed(() => props.agent.modelTags)

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
  <div :class="['s-agent-card', { expanded, disabled: !agent.enabled }]">
    <div class="s-agent-card__hd" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="agent.enabled"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div class="s-agent-card__info">
        <div class="s-agent-card__name">{{ agent.name }}</div>
        <div class="s-agent-card__desc">{{ agent.description }}</div>
        <div class="s-agent-card__source">{{ agent.source ?? agent.id }}</div>
      </div>
      <div class="s-agent-card__actions" @click.stop>
        <Button variant="ghost" size="sm" @click="showEditor = !showEditor">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="$emit('delete', agent.name)">删除</Button>
      </div>
      <span class="s-agent-card__chevron">▾</span>
    </div>
    <div class="s-agent-card__bd">
      <MetaGrid :items="metaItems" />
      <ModelStrategyConfig
        :strategy="(agent.modelStrategy as 'auto' | 'tag' | 'bind')"
        :all-models="allModels"
        :model-tags="modelTags"
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

