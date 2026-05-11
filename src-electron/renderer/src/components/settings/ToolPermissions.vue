<script setup lang="ts">
import { useSettingsStore } from '../../stores/settings'
import { Button, Select } from '../../design-system'
import type { ToolPermission } from '@xyz-agent/shared'

const settingsStore = useSettingsStore()

const DEFAULT_PERMISSIONS: Record<string, ToolPermission> = {
  read: 'allow', grep: 'allow', find: 'allow', ls: 'allow',
  bash: 'ask', edit: 'ask', write: 'ask',
}

const permissionOptions: { value: string; label: string }[] = [
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
      <Select
        :model-value="perm"
        :options="permissionOptions"
        class="perm-select"
        @update:model-value="settingsStore.setToolPermission(tool, $event as ToolPermission)"
      />
    </div>
    <Button variant="ghost" size="sm" class="reset-btn" @click="resetDefaults">Reset to Defaults</Button>
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
  min-width: 100px;
}
.reset-btn {
  margin-top: 16px;
}
</style>
