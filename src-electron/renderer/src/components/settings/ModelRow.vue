<script setup lang="ts">
import { computed } from 'vue'

type ThinkingStrategy = 'all-levels' | 'on-off' | 'high-max'

const props = defineProps<{
  name: string
  ctx: string
  thinkingLevelMap?: Record<string, string | null>
}>()

function getStrategy(map?: Record<string, string | null>): ThinkingStrategy {
  if (!map) return 'all-levels'
  if (map.xhigh === 'max') return 'high-max'
  return 'on-off'
}

const strategy = computed(() => getStrategy(props.thinkingLevelMap))

const BADGE_LABELS: Record<ThinkingStrategy, string> = {
  'all-levels': 'All',
  'on-off': 'On/Off',
  'high-max': 'H/M',
}
</script>

<template>
  <div class="flex items-center gap-0 py-1.5 px-4 transition-colors duration-100 hover:bg-[var(--hover-bg)]">
    <span class="font-mono text-[11px] text-muted flex-1 min-w-0 truncate">{{ name }}</span>
    <span
      :class="['badge-sm', {
        'badge-sm--default': strategy === 'all-levels',
        'badge-sm--binary': strategy === 'on-off',
        'badge-sm--highmax': strategy === 'high-max',
      }]"
    >{{ BADGE_LABELS[strategy] }}</span>
    <span class="col-ctx-sm">{{ ctx }}</span>
  </div>
</template>

<style scoped>
.badge-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  padding: 1px 0;
  border-radius: 100px;
  font-size: 9px;
  font-weight: 600;
  border: 1px solid transparent;
  flex-shrink: 0;
}
.badge-sm--default { background: var(--section-bg); color: var(--muted); border-color: var(--border); }
.badge-sm--binary { background: var(--agent-light); color: var(--agent); }
.badge-sm--highmax { background: var(--accent-light); color: var(--accent); }

.col-ctx-sm {
  width: 48px;
  flex-shrink: 0;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted);
  padding-right: 0;
}
</style>
