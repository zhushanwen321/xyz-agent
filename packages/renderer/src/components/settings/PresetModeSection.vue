<!--
  预设工具/扩展模式区。
  4 种 mode 切换（all/allowlist/denylist/none）+ Checkbox 列表。
  工具列表标注「默认启用/默认禁用」。扩展列表复用 settings store extensions。
-->
<template>
  <div class="flex flex-col gap-4">
    <!-- 工具模式 -->
    <div>
      <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-neutral-mid">
        {{ t('settings.preset.toolMode') }}
      </Label>
      <div class="flex items-center gap-1.5">
        <Button
          v-for="m in TOOL_MODES"
          :key="m.value"
          variant="ghost"
          size="dense"
          class="rounded-sm text-[11px]"
          :class="preset.toolMode === m.value ? 'bg-surface-hover text-neutral-fg ring-1 ring-inset ring-accent' : 'text-neutral-mid hover:text-neutral-fg'"
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
            @update:model-value="(checked) => onToolToggle(tool, checked === true)"
          />
          <span class="text-[11px] text-neutral-fg">{{ tool }}</span>
          <span
            class="text-[9px]"
            :class="isDefaultEnabled(tool) ? 'text-success' : 'text-neutral-dim'"
          >{{ isDefaultEnabled(tool) ? t('settings.preset.defaultOn') : t('settings.preset.defaultOff') }}</span>
        </Label>
      </div>
    </div>

    <!-- 扩展模式 -->
    <div>
      <Label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-neutral-mid">
        {{ t('settings.preset.extensionMode') }}
      </Label>
      <div class="flex items-center gap-1.5">
        <Button
          v-for="m in EXT_MODES"
          :key="m.value"
          variant="ghost"
          size="dense"
          class="rounded-sm text-[11px]"
          :class="preset.extensionMode === m.value ? 'bg-surface-hover text-neutral-fg ring-1 ring-inset ring-accent' : 'text-neutral-mid hover:text-neutral-fg'"
          :disabled="disabled"
          @click="onExtModeChange(m.value)"
        >
          {{ m.label }}
        </Button>
      </div>
      <!-- allowlist/denylist Checkbox 列表 -->
      <div v-if="preset.extensionMode === 'allowlist' || preset.extensionMode === 'denylist'" class="mt-2 flex flex-wrap gap-2">
        <div v-if="!availableExtensions.length" class="text-[11px] text-neutral-mid">
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
            @update:model-value="(checked) => onExtToggle(ext, checked === true)"
          />
          <span class="text-[11px] text-neutral-fg">{{ ext }}</span>
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
import { BUILTIN_TOOLS, BUILTIN_EXTENSION_FILES } from '@xyz-agent/shared'
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

/**
 * 可用扩展列表（排除 3 个内置文件型 extension）。
 *
 * S-RN-4：用 BUILTIN_EXTENSION_FILES 精确匹配（shared SSOT），而非 endsWith('.js')
 * 兜底——后者会误伤未来任何 .js 扩展。
 *
 * 类型注记：BUILTIN_EXTENSION_FILES 是 `as const` 字面量元组，`.includes(string)`
 * 会因字面量类型不匹配报 TS2345，故断言为 readonly string[] 做包含判断。
 */
const BUILTIN_EXT_FILES: readonly string[] = BUILTIN_EXTENSION_FILES
const availableExtensions = computed(() =>
  extensions.value
    .map((e) => e.name)
    .filter((name) => !BUILTIN_EXT_FILES.includes(name)),
)

/**
 * 默认启用的工具（read/write/bash/edit）。
 *
 * S-RN-3：此集合与 shared BUILTIN_TOOLS 语义不同——BUILTIN_TOOLS 是 pi 硬编码的全部
 * 7 个内置工具（含 grep/find/ls），DEFAULT_ENABLED_TOOLS 是「内置预设默认勾选的核心
 * 4 个」，仅用于 UI 显示「默认启用/默认禁用」徽章。保留本地定义不导入 shared，因
 * 两者语义不同（核心子集 vs 全集），无法用 BUILTIN_TOOLS 子集表达「核心」概念。
 */
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

/**
 * 工具勾选切换（W-RN-4：显式接收 checked 实参，不靠反转逻辑推断）。
 *
 * - allowlist：checked=true → 加入 allowedTools；checked=false → 移除。
 * - denylist：checked=true（表示启用该工具）→ 从 deniedTools 移除；checked=false → 加入。
 */
function onToolToggle(tool: string, checked: boolean) {
  if (props.preset.toolMode === 'allowlist') {
    const list = props.preset.allowedTools ?? []
    const next = checked ? [...list, tool] : list.filter((t) => t !== tool)
    emit('update', { presetId: props.preset.id, allowedTools: next })
  } else {
    // denylist：deniedTools 存的是「被禁用的工具」，勾选语义相反
    const list = props.preset.deniedTools ?? []
    const next = checked ? list.filter((t) => t !== tool) : [...list, tool]
    emit('update', { presetId: props.preset.id, deniedTools: next })
  }
}

/** 扩展勾选切换（同 onToolToggle 语义，W-RN-4）。 */
function onExtToggle(ext: string, checked: boolean) {
  if (props.preset.extensionMode === 'allowlist') {
    const list = props.preset.allowedExtensions ?? []
    const next = checked ? [...list, ext] : list.filter((e) => e !== ext)
    emit('update', { presetId: props.preset.id, allowedExtensions: next })
  } else {
    const list = props.preset.deniedExtensions ?? []
    const next = checked ? list.filter((e) => e !== ext) : [...list, ext]
    emit('update', { presetId: props.preset.id, deniedExtensions: next })
  }
}
</script>
