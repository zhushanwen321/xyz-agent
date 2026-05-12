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

const metaItems = computed(() => {
  const items: Array<{ key: string; value: string }> = [
    { key: '\u540d\u79f0', value: props.agent.name },
  ]
  if (props.agent.type === 'builtin') {
    items.push({ key: '\u7c7b\u578b', value: '\u5185\u7f6e (builtin)' })
  } else {
    items.push({ key: '\u6765\u6e90', value: props.agent.sourceType ? `${props.agent.sourceType} \u00b7 ${props.agent.source ?? ''}` : (props.agent.source ?? '-') })
  }
  items.push(
    { key: '\u6a21\u578b\u7b56\u7565', value: strategyLabel.value },
    { key: '\u5de5\u5177', value: props.agent.tools?.join(', ') ?? '-' },
  )
  return items
})

function handleSave() {
  showEditor.value = false
}
</script>

<template>
  <div :class="['bg-surface border border-border rounded mb-3 overflow-hidden transition-colors duration-200 hover:border-[oklch(80%_0.01_70)]', { 'opacity-60': !agent.enabled }]">
    <div class="flex items-center gap-3 py-3.5 px-[18px] cursor-pointer" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="agent.enabled"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div
        class="w-8 h-8 rounded-sm bg-accent-light flex items-center justify-center text-sm font-bold text-accent shrink-0"
        :style="agent.iconBg ? { background: agent.iconBg } : {}"
      >{{ agent.icon || agent.name.charAt(0) }}</div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold">{{ agent.name }}</div>
        <div class="text-xs text-muted mt-0.5 line-clamp-1">{{ agent.description }}</div>
        <div class="text-[11px] text-muted font-mono mt-0.5">{{ agent.source ?? agent.id }}</div>
      </div>
      <div class="flex gap-1 shrink-0" @click.stop>
        <Button variant="ghost" size="sm" @click="showEditor = !showEditor">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="$emit('delete', agent.name)">删除</Button>
      </div>
      <span :class="['text-[10px] text-muted transition-transform duration-200 ml-1', { 'rotate-180': expanded }]">▾</span>
    </div>
    <div v-show="expanded" class="px-[18px] pb-4">
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
      <div v-if="showEditor" style="margin-top: 12px">
        <MarkdownEditor
          v-model="content"
          filename="agent.md"
          @save="handleSave"
        />
      </div>
    </div>
  </div>
</template>

