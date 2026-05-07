<script setup lang="ts">
import { ToggleSwitch, TagPill } from './shared'

interface Props {
  name: string
  ctx: string
  tags: string[]
  enabled: boolean
}

defineProps<Props>()

defineEmits<{
  'toggle-enabled': []
}>()

const allTags = ['power', 'efficient', 'fast'] as const
</script>

<template>
  <div :class="['model-row', { disabled: !enabled }]">
    <ToggleSwitch
      :model-value="enabled"
      @update:model-value="$emit('toggle-enabled')"
      @click.stop
    />
    <span class="model-row__name">{{ name }}</span>
    <span class="model-row__ctx">{{ ctx }}</span>
    <div class="tag-group">
      <TagPill
        v-for="tag in allTags"
        :key="tag"
        :variant="tag"
        :active="tags.includes(tag)"
        @toggle="() => {}"
      >
        {{ tag === 'power' ? '\u5f3a\u529b' : tag === 'efficient' ? '\u9ad8\u6548' : '\u5feb\u901f' }}
      </TagPill>
    </div>
  </div>
</template>

<style scoped>
.model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  margin-bottom: 4px;
  transition: background 0.1s var(--ease);
}
.model-row:hover { background: var(--bg); }
.model-row.disabled { opacity: 0.5; }

.model-row__name {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-row__ctx {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  min-width: 60px;
  text-align: right;
}
.tag-group { display: flex; gap: 4px; flex-shrink: 0; }
</style>
