<script setup lang="ts">
import { computed } from 'vue'
import type { SettingsPage } from '@/composables/useStore'
import GroupCard from './GroupCard.vue'

/** PlaceholderPage：spec 未补全页面的占位（terminal/preset/worktree/update/system/skill）。*/
const props = defineProps<{ page: SettingsPage }>()

const LABELS: Record<string, string> = {
  terminal: '终端',
  preset: '预设',
  worktree: '工作区',
  update: '更新',
  system: '系统',
}
const title = computed(() => LABELS[props.page] ?? '设置')
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">{{ title }}</h1>
      <p class="desc">此页面 spec 待补，当前为占位。</p>
    </header>
    <GroupCard>
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
        <p>该模块尚未设计。</p>
      </div>
    </GroupCard>
  </div>
</template>

<style scoped>
.page-head {
  margin-bottom: var(--space-6);
}
.title {
  font-size: 18px;
  font-weight: 700;
  color: var(--neutral-fg);
  letter-spacing: -0.01em;
}
.desc {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-12) var(--space-4);
  color: var(--neutral-dim);
}
.empty svg {
  width: 28px;
  height: 28px;
  color: var(--neutral-faint);
}
.empty p {
  font-size: var(--text-sm);
}
</style>
