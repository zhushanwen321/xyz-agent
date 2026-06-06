<template>
  <div :class="['sys-notif', typeClass]">
    <!-- Icon per type -->
    <svg v-if="type === 'done'" class="sys-notif__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2 3.5-3.5"/></svg>
    <svg v-else-if="type === 'alert'" class="sys-notif__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11" r="0.5" fill="currentColor"/></svg>
    <svg v-else-if="type === 'warning'" class="sys-notif__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2L2 13h12L8 2z"/><line x1="8" y1="6" x2="8" y2="9.5"/><circle cx="8" cy="11" r="0.5" fill="currentColor"/></svg>
    <svg v-else class="sys-notif__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2.5 1.5"/></svg>

    <span class="sys-notif__text">
      {{ title || content }}
      <span v-if="description" class="sys-notif__desc"> · {{ description }}</span>
    </span>
    <span v-if="actionLabel" class="sys-notif__action" @click="$emit('action')">{{ actionLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  type: 'done' | 'alert' | 'info' | 'warning'
  title: string
  content?: string
  description?: string
  actionLabel?: string
}>()

defineEmits<{
  action: []
}>()

const typeClass = computed(() => {
  switch (props.type) {
    case 'done': return 'sys-notif--done'
    case 'alert': return 'sys-notif--alert'
    case 'warning': return 'sys-notif--warning'
    default: return 'sys-notif--info'
  }
})
</script>

<style scoped>
.sys-notif {
  width: 100%;
  padding: 5px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  border-radius: var(--radius);
}
.sys-notif__icon { width: 12px; height: 12px; flex-shrink: 0; }
.sys-notif__text { flex: 1; font-weight: 500; }
.sys-notif__desc { color: var(--muted); font-weight: 400; }
.sys-notif__action { font-weight: 600; cursor: pointer; text-decoration: underline; }

.sys-notif--done { background: var(--success-light); color: var(--success); }
.sys-notif--alert { background: var(--danger-light); color: var(--danger); }
.sys-notif--warning { background: var(--warning-light); color: var(--warning); }
.sys-notif--info { background: var(--agent-light); color: var(--agent); }
</style>
