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
  <div class="p-4">
    <h3>Tool Permissions</h3>
    <div v-for="(perm, tool) in settingsStore.toolPermissions" :key="tool" class="flex items-center justify-between py-2 border-b border-border">
      <span class="font-mono text-[13px]">{{ tool }}</span>
      <Select
        :model-value="perm"
        :options="permissionOptions"
        class="min-w-[100px]"
        @update:model-value="settingsStore.setToolPermission(tool, $event as ToolPermission)"
      />
    </div>
    <Button variant="ghost" size="sm" class="mt-4" @click="resetDefaults">Reset to Defaults</Button>
  </div>
</template>

