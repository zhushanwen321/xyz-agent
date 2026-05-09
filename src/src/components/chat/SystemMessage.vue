<template>
  <div :class="['msg--system', { 'msg--system--alert': type === 'alert' }]">
    <span :class="['msg--system__dot', type === 'done' ? 'msg--system__dot--done' : 'msg--system__dot--alert']"></span>
    <div class="msg--system__content">
      <div class="msg--system__title">{{ title }}</div>
      <div v-if="description" class="msg--system__desc">{{ description }}</div>
      <span v-if="actionLabel" class="msg--system__action" @click="$emit('action')">
        {{ actionLabel }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  type: 'done' | 'alert'
  title: string
  description?: string
  actionLabel?: string
}>()

defineEmits<{
  action: []
}>()
</script>

<style scoped>
.msg--system {
  align-self: stretch;
  width: 100%;
  max-width: none;
  border: 1px solid oklch(80% 0.02 145);
  background: oklch(97% 0.02 145);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 13px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  box-sizing: border-box;
}
.msg--system--alert { border-left-color: var(--danger); }
.msg--system__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
.msg--system__dot--done { background: var(--success); }
.msg--system__dot--alert { background: var(--danger); }
.msg--system__content { flex: 1; }
.msg--system__title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
.msg--system__desc { color: var(--muted); font-size: 12px; }
.msg--system__action { font-size: 12px; color: var(--accent); font-weight: 600; cursor: pointer; margin-top: 4px; display: inline-flex; align-items: center; gap: 3px; }
.msg--system__action:hover { text-decoration: underline; }
</style>
