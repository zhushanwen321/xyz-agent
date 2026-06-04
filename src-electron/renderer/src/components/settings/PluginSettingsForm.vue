<script setup lang="ts">
import { reactive, onMounted, onUnmounted } from 'vue'
import { usePluginStore } from '../../stores/plugin'
import { Toggle, Input, Select } from '../../design-system'
import type { PluginSettingSchema } from '../../types/plugin'

const props = defineProps<{
  pluginId: string
  settings: PluginSettingSchema[]
  disabled?: boolean
}>()

const store = usePluginStore()

// ── Debounced config writes ────────────────────────────────────

const DEBOUNCE_FLUSH_MS = 500
const pendingChanges = reactive(new Map<string, unknown>())
let flushTimer: ReturnType<typeof setTimeout> | null = null

// Track which keys require restart for inline hint
const changedRestartKeys = reactive(new Set<string>())

function handleSettingChange(key: string, value: unknown) {
  // Optimistic local update via pluginConfigs
  const current = store.pluginConfigs.get(props.pluginId) ?? {}
  store.pluginConfigs.set(props.pluginId, { ...current, [key]: value })

  pendingChanges.set(key, value)

  // Show restart hint if applicable
  const schema = props.settings.find(s => s.key === key)
  if (schema?.requiresRestart) {
    changedRestartKeys.add(key)
  }

  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    for (const [k, v] of pendingChanges) {
      store.setConfig(props.pluginId, k, v)
    }
    pendingChanges.clear()
  }, DEBOUNCE_FLUSH_MS)
}

// ── Value helpers ──────────────────────────────────────────────

function getSettingValue(key: string, fallback: unknown): unknown {
  return store.pluginConfigs.get(props.pluginId)?.[key] ?? fallback
}

function parseInputValue(setting: PluginSettingSchema, raw: string | number): unknown {
  const str = String(raw)
  if (setting.type === 'number') {
    const n = Number(str)
    return Number.isNaN(n) ? setting.default : n
  }
  return str
}

// ── Lifecycle: fetch config on mount ───────────────────────────

onMounted(() => {
  store.getConfig(props.pluginId)
})

onUnmounted(() => {
  if (flushTimer) {
    clearTimeout(flushTimer)
    // Flush remaining changes
    for (const [k, v] of pendingChanges) {
      store.setConfig(props.pluginId, k, v)
    }
    pendingChanges.clear()
  }
})
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="text-[12px] font-semibold text-muted mb-1">Configuration</div>
    <div
      v-for="setting in settings"
      :key="setting.key"
      class="flex items-center justify-between py-2 px-3 border-b border-[var(--divider)] last:border-b-0"
    >
      <!-- Label + description -->
      <div class="flex flex-col min-w-0 flex-1 mr-4">
        <span class="text-[12px] font-medium text-[var(--fg)]">{{ setting.label }}</span>
        <span v-if="setting.description" class="text-[10px] text-muted mt-px">
          {{ setting.description }}
        </span>
      </div>

      <!-- Boolean: Toggle -->
      <Toggle
        v-if="setting.type === 'boolean'"
        :checked="Boolean(getSettingValue(setting.key, setting.default ?? false))"
        :disabled="disabled"
        @update:checked="handleSettingChange(setting.key, $event)"
      />

      <!-- Enum: Select -->
      <Select
        v-else-if="setting.type === 'enum'"
        :model-value="String(getSettingValue(setting.key, setting.default ?? ''))"
        :options="setting.enumValues ?? []"
        :disabled="disabled"
        class="max-w-[200px]"
        @update:model-value="handleSettingChange(setting.key, String($event))"
      />

      <!-- String / Number / Path: Input -->
      <Input
        v-else
        :model-value="String(getSettingValue(setting.key, setting.default ?? ''))"
        :type="setting.type === 'number' ? 'number' : 'text'"
        :placeholder="setting.description ?? ''"
        :disabled="disabled"
        class="max-w-[200px]"
        @update:model-value="handleSettingChange(setting.key, parseInputValue(setting, $event))"
      />

      <!-- Restart hint badge -->
      <span
        v-if="setting.requiresRestart && changedRestartKeys.has(setting.key)"
        class="ml-2 text-[9px] text-[var(--warning)] bg-[var(--warning-light)] py-[1px] px-1.5 rounded-sm shrink-0 whitespace-nowrap"
      >
        Restart required
      </span>
    </div>
  </div>
</template>
