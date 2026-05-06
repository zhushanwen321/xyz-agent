<template>
  <div :class="['approval-card', `approval-card--${pending.dangerLevel}`]">
    <div class="approval-header">
      <span class="approval-tool">{{ pending.toolName }}</span>
      <span :class="['approval-level', `approval-level--${pending.dangerLevel}`]">{{ pending.dangerLevel }}</span>
    </div>
    <pre class="approval-input">{{ formattedInput }}</pre>
    <div class="approval-actions">
      <button class="approval-btn approval-btn--always" @click="$emit('alwaysAllow', pending.toolName)">Always Allow</button>
      <button class="approval-btn approval-btn--deny" @click="$emit('deny', pending.toolCallId)">Deny</button>
      <button class="approval-btn approval-btn--approve" @click="$emit('approve', pending.toolCallId)">Approve</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export interface PendingToolCall {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  dangerLevel: 'safe' | 'caution' | 'danger'
}

const props = defineProps<{ pending: PendingToolCall }>()

defineEmits<{
  approve: [toolCallId: string]
  deny: [toolCallId: string]
  alwaysAllow: [toolName: string]
}>()

const formattedInput = computed(() => {
  try {
    return JSON.stringify(props.pending.input, null, 2)
  } catch {
    return String(props.pending.input)
  }
})
</script>

<style scoped>
.approval-card {
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-border);
  background: var(--color-surface);
  overflow: hidden;
}

/* Danger-level left border */
.approval-card--safe { border-left-color: var(--color-success); }
.approval-card--caution { border-left-color: var(--color-warning); }
.approval-card--danger { border-left-color: var(--color-danger); }

.approval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  gap: 8px;
}

.approval-tool {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-primary);
}

.approval-level {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.approval-level--safe {
  color: var(--color-success);
  background: oklch(95% 0.06 145);
}
.approval-level--caution {
  color: var(--color-warning);
  background: oklch(95% 0.06 85);
}
.approval-level--danger {
  color: var(--color-danger);
  background: oklch(95% 0.06 25);
}

[data-theme="dark"] .approval-level--safe { background: oklch(30% 0.06 145); }
[data-theme="dark"] .approval-level--caution { background: oklch(30% 0.06 85); }
[data-theme="dark"] .approval-level--danger { background: oklch(30% 0.06 25); }

.approval-input {
  margin: 0;
  padding: 6px 10px;
  max-height: 160px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-muted);
  border-top: 1px solid var(--color-border);
  white-space: pre-wrap;
  word-break: break-all;
}

.approval-actions {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--color-border);
}

.approval-btn {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

/* Always Allow: ghost */
.approval-btn--always {
  background: none;
  border: 1px solid transparent;
  color: var(--color-text-muted);
}
.approval-btn--always:hover {
  background: var(--color-bg-base);
  color: var(--color-text-primary);
}

/* Deny: bordered */
.approval-btn--deny {
  background: none;
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
}
.approval-btn--deny:hover {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

/* Approve: filled accent */
.approval-btn--approve {
  background: var(--color-accent);
  border: 1px solid var(--color-accent);
  color: #fff;
}
.approval-btn--approve:hover {
  opacity: 0.88;
}
</style>
