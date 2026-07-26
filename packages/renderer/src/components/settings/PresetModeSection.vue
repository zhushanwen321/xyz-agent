<!--
  预设工具/扩展模式区。
  4 种 mode 切换（all/allowlist/denylist/none）+ Checkbox 列表。
  工具列表标注「默认启用/默认禁用」。扩展列表复用 settings store extensions。
-->
<template>
  <div class="flex flex-col gap-4">
    <!-- 工具模式 -->
    <div>
      <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
        {{ t('settings.preset.toolMode') }}
      </Label>
      <div class="flex items-center gap-1.5">
        <Button
          v-for="m in TOOL_MODES"
          :key="m.value"
          variant="ghost"
          size="dense"
          class="rounded-sm text-[11px]"
          :class="preset.toolMode === m.value ? 'bg-surface-hover text-fg ring-1 ring-inset ring-accent' : 'text-muted hover:text-fg'"
          :disabled="disabled"
          @click="onToolModeChange(m.value)"
        >
          {{ m.label }}
        </Button>
      </div>
      <!-- allowlist/denylist Checkbox 列表 -->
      <div v-if="preset.toolMode === 'allowlist' || preset.toolMode === 'denylist'" class="mt-2 flex flex-wrap gap-2">
        <Label
          v-for="tool in BUILTIN_TOOLS"
          :key="tool"
          class="flex cursor-pointer items-center gap-1.5 rounded-sm border border-border px-2 py-1 hover:bg-surface"
          :class="{ 'opacity-50': disabled }"
        >
          <Checkbox
            :model-value="isToolChecked(tool)"
            :disabled="disabled"
            @update:model-value="onToolToggle(tool)"
          />
          <span class="text-[11px] text-fg">{{ tool }}</span>
          <span
            class="text-[9px]"
            :class="isDefaultEnabled(tool) ? 'text-success' : 'text-subtle'"
          >{{ isDefaultEnabled(tool) ? t('settings.preset.defaultOn') : t('settings.preset.defaultOff') }}</span>
        </Label>
      </div>
    </div>

    <!-- 扩展模式 -->
    <div>
      <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
        {{ t('settings.preset.extensionMode') }}
      </Label>
      <div class="flex items-center gap-1.5">
        <Button
          v-for="m in EXT_MODES"
          :key="m.value"
          variant="ghost"
          size="dense"
          class="rounded-sm text-[11px]"
          :class="preset.extensionMode === m.value ? 'bg-surface-hover text-fg ring-1 ring-inset ring-accent' : 'text-muted hover:text-fg'"
          :disabled="disabled"
          @click="onExtModeChange(m.value)"
        >
          {{ m.label }}
        </Button>
      </div>
      <!-- allowlist/denylist Checkbox 列表 -->
      <div v-if="preset.extensionMode === 'allowlist' || preset.extensionMode === 'denylist'" class="mt-2 flex flex-wrap gap-2">
        <div v-if="!availableExtensions.length" class="text-[11px] text-muted">
          {{ t('settings.preset.noExtensions') }}
        </div>
        <Label
          v-for="ext in availableExtensions"
          :key="ext"
          class="flex cursor-pointer items-center gap-1.5 rounded-sm border border-border px-2 py-1 hover:bg-surface"
          :class="{ 'opacity-50': disabled }"
        >
          <Checkbox
            :model-value="isExtChecked(ext)"
            :disabled="disabled"
            @update:model-value="onExtToggle(ext)"
          />
          <span class="text-[11px] text-fg">{{ ext }}</span>
        </Label>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { useSettingsStore } from '@/stores/settings'
import { BUILTIN_TOOLS } from '@xyz-agent/shared'
import type { PiLaunchPreset, ToolMode, ExtensionMode } from '@xyz-agent/shared'

const props = defineProps<{
  preset: PiLaunchPreset
  disabled: boolean
}>()

const emit = defineEmits<{
  update: [payload: {
    presetId: string
    toolMode?: ToolMode
    extensionMode?: ExtensionMode
    allowedTools?: string[]
    deniedTools?: string[]
    allowedExtensions?: string[]
    deniedExtensions?: string[]
  }]
}>()

const { t } = useI18n()
const { extensions } = storeToRefs(useSettingsStore())

const TOOL_MODES = computed(() => [
  { value: 'all' as ToolMode, label: t('settings.preset.modeAll') },
  { value: 'allowlist' as ToolMode, label: t('settings.preset.modeAllowlist') },
  { value: 'denylist' as ToolMode, label: t('settings.preset.modeDenylist') },
  { value: 'none' as ToolMode, label: t('settings.preset.modeNone') },
])

const EXT_MODES = computed(() => [
  { value: 'all' as ExtensionMode, label: t('settings.preset.modeAll') },
  { value: 'allowlist' as ExtensionMode, label: t('settings.preset.modeAllowlist') },
  { value: 'denylist' as ExtensionMode, label: t('settings.preset.modeDenylist') },
  { value: 'none' as ExtensionMode, label: t('settings.preset.modeNone') },
])

/** 可用扩展列表（排除 3 个内置文件型 extension） */
const availableExtensions = computed(() =>
  extensions.value
    .map((e) => e.name)
    .filter((name) => !name.endsWith('.js')),
)

/** 默认启用的工具（read/write/bash/edit） */
const DEFAULT_ENABLED_TOOLS = new Set(['read', 'write', 'bash', 'edit'])

function isDefaultEnabled(tool: string): boolean {
  return DEFAULT_ENABLED_TOOLS.has(tool)
}

function isToolChecked(tool: string): boolean {
  if (props.preset.toolMode === 'allowlist') {
    return (props.preset.allowedTools ?? []).includes(tool)
  }
  // denylist: checked = not denied
  return !(props.preset.deniedTools ?? []).includes(tool)
}

function isExtChecked(ext: string): boolean {
  if (props.preset.extensionMode === 'allowlist') {
    return (props.preset.allowedExtensions ?? []).includes(ext)
  }
  return !(props.preset.deniedExtensions ?? []).includes(ext)
}

function onToolModeChange(mode: ToolMode) {
  emit('update', { presetId: props.preset.id, toolMode: mode })
}

function onExtModeChange(mode: ExtensionMode) {
  emit('update', { presetId: props.preset.id, extensionMode: mode })
}

function onToolToggle(tool: string) {
  if (props.preset.toolMode === 'allowlist') {
    const list = props.preset.allowedTools ?? []
    const next = list.includes(tool) ? list.filter((t) => t !== tool) : [...list, tool]
    emit('update', { presetId: props.preset.id, allowedTools: next })
  } else {
    const list = props.preset.deniedTools ?? []
    const next = list.includes(tool) ? list.filter((t) => t !== tool) : [...list, tool]
    emit('update', { presetId: props.preset.id, deniedTools: next })
  }
}

function onExtToggle(ext: string) {
  if (props.preset.extensionMode === 'allowlist') {
    const list = props.preset.allowedExtensions ?? []
    const next = list.includes(ext) ? list.filter((e) => e !== ext) : [...list, ext]
    emit('update', { presetId: props.preset.id, allowedExtensions: next })
  } else {
    const list = props.preset.deniedExtensions ?? []
    const next = list.includes(ext) ? list.filter((e) => e !== ext) : [...list, ext]
    emit('update', { presetId: props.preset.id, deniedExtensions: next })
  }
}
</script>
