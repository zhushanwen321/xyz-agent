<script setup lang="ts">
import { TagPill } from './shared'

interface Props {
  name: string
  ctx: string
  tags: string[]
}

defineProps<Props>()

const allTags = ['power', 'efficient', 'fast'] as const
</script>

<template>
  <div class="model-row">
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
        {{ tag === 'power' ? '强力' : tag === 'efficient' ? '高效' : '快速' }}
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

.model-row:hover {
  background: var(--bg);
}

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

.tag-group {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
</style>
