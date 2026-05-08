<script setup lang="ts">
import { useSettingsStore } from '../../stores/settings'
import type { ToolPermission } from '@xyz-agent/shared'

const settingsStore = useSettingsStore()

const DEFAULT_PERMISSIONS: Record<string, ToolPermission> = {
  read: 'allow', grep: 'allow', find: 'allow', ls: 'allow',
  bash: 'ask', edit: 'ask', write: 'ask',
}

const permissionOptions: { value: ToolPermission; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
]

function resetDefaults() {
  settingsStore.toolPermissions = { ...DEFAULT_PERMISSIONS }
}
</script>

<template>
  <div class="tool-permissions">
    <h3>Tool Permissions</h3>
    <div v-for="(perm, tool) in settingsStore.toolPermissions" :key="tool" class="perm-row">
      <span class="tool-name">{{ tool }}</span>
      <select
        :value="perm"
        class="perm-select"
        @change="settingsStore.setToolPermission(tool, ($event.target as HTMLSelectElement).value as ToolPermission)"
      >
        <option v-for="opt in permissionOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
    </div>
    <button class="reset-btn" @click="resetDefaults">Reset to Defaults</button>
  </div>
</template>

<style scoped>
.tool-permissions {
  padding: 16px;
}
.perm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border);
}
.tool-name {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
}
.perm-select {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-primary);
}
.reset-btn {
  margin-top: 16px;
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.reset-btn:hover {
  color: var(--color-text-primary);
  border-color: var(--color-text-muted);
}
</style>
