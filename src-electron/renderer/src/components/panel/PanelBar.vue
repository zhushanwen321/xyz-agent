<script setup lang="ts">
import AnchorDropdown from './AnchorDropdown.vue'

interface AgentOption {
  id: string
  label: string
  color?: string
}

defineProps<{
  agentOptions: AgentOption[]
  activeAgentId: string
  doneCount?: number
  alertCount?: number
  showClose?: boolean
  closeLabel?: string
}>()

defineEmits<{
  'switch-agent': [id: string]
  'open-drawer': [type: string]
  'close-split': []
}>()

</script>

<template>
  <div class="panel-bar">
    <AnchorDropdown
      :options="agentOptions"
      :current-id="activeAgentId"
      @select="$emit('switch-agent', $event)"
    />
    <div v-if="(doneCount ?? 0) > 0 || (alertCount ?? 0) > 0 || showClose" class="panel-notifs">
      <span v-if="(doneCount ?? 0) > 0" class="pn-chip pn-chip--done" role="button" tabindex="0" @click="$emit('open-drawer', 'done')" @keydown.enter="$emit('open-drawer', 'done')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px"><polyline points="2 6 5 9 10 3"/></svg>
        <span class="pn-chip__num">{{ doneCount }}</span>
      </span>
      <span v-if="(alertCount ?? 0) > 0" class="pn-chip pn-chip--alert" role="button" tabindex="0" @click="$emit('open-drawer', 'alert')" @keydown.enter="$emit('open-drawer', 'alert')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="width:10px;height:10px"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v2.5M6 8v.5"/></svg>
        <span class="pn-chip__num">{{ alertCount }}</span>
      </span>
      <span v-if="showClose" class="pn-close" role="button" tabindex="0" @click="$emit('close-split')" @keydown.enter="$emit('close-split')">{{ closeLabel || '关闭' }}</span>
    </div>
  </div>
</template>

<style scoped>
.panel-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  height: 36px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  font-size: 12px;
}

/* Inline notifications */
.panel-notifs {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
}
.pn-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 100px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  transition: all 0.15s var(--ease);
  border: 1px solid transparent;
}
.pn-chip--done {
  background: var(--success-light);
  color: var(--success);
}
.pn-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.pn-chip--done:hover {
  border-color: var(--success);
}
.pn-chip--alert {
  background: var(--danger-light);
  color: var(--danger);
}
.pn-chip--alert:hover {
  border-color: var(--danger);
}
.pn-chip__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  font-size: 9px;
  font-weight: 700;
  color: white;
}
.pn-chip--done .pn-chip__num {
  background: var(--success);
}
.pn-chip--alert .pn-chip__num {
  background: var(--danger);
  animation: pulse-dot 2s infinite;
}
@keyframes pulse-dot {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
}
.pn-close {
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border);
  transition: all 0.15s var(--ease);
  font-family: var(--font-body);
}
.pn-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.pn-close:hover {
  background: var(--accent-light);
  color: var(--accent);
  border-color: var(--accent);
}
</style>
