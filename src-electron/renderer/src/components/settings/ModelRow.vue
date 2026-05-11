<script setup lang="ts">
import { ToggleSwitch, TagPill } from './shared'

interface Props {
  name: string
  ctx: string
  tags: string[]
  enabled: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  'toggle-enabled': []
}>()

const allTags = ['power', 'efficient', 'fast'] as const
</script>

<template>
  <div :class="['s-model-row', { 'opacity-50': !enabled }]" @click.stop>
    <div class="s-model-row__switch" @click="emit('toggle-enabled')">
      <ToggleSwitch :model-value="enabled" />
    </div>
    <span class="s-model-row__name">{{ name }}</span>
    <span class="s-model-row__ctx">{{ ctx }}</span>
    <div class="s-tag-group">
      <TagPill
        v-for="tag in allTags"
        :key="tag"
        :variant="tag"
        :active="tags.includes(tag)"
        class="s-tag-pill--readonly"
      >
        {{ tag === 'power' ? '\u5f3a\u529b' : tag === 'efficient' ? '\u9ad8\u6548' : '\u5feb\u901f' }}
      </TagPill>
    </div>
  </div>
</template>
