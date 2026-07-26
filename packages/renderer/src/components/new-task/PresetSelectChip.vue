<script setup lang="ts">
/**
 * PresetSelectChip —— pi 启动预设选择 chip（设计文档 pi-launch-presets.md §3 / §5.4）。
 *
 * 三态（由 props.sessionId + props.launchPresetId 派生）：
 * 1. landing 态（sessionId=null）：Popover 可展开，列预设（Button+Check 实现 RadioGroup 语义）+
 *    描述 + 「设为默认」Checkbox。selectedPresetId 本地 ref，初值在 loadPresets 后设为 defaultPresetId。
 * 2. 已创建态（sessionId!=null + launchPresetId 有值）：Lock 图标 + 预设名 + HoverCard tooltip
 *    「此 Session 使用 {预设名} 模式创建，不可更改」。不展开 Popover。
 * 3. 历史 session（sessionId!=null + launchPresetId undefined）：Lock 图标 + 「全工具模式」+
 *    HoverCard tooltip 加注「（历史 session，未记录预设）」。
 *
 * 数据流：onMounted 调 usePiPresets().loadPresets() 拉预设列表 + 默认预设写 store。
 * 组件直接读 preset store（presets/defaultPresetId）——store 是数据态 SSOT，selectedPresetId 是交互态留本地。
 *
 * 范式参考：ThinkingLevelPopover.vue（Popover+TriggerButton+Content + Button+Check RadioGroup 语义）。
 *
 * emit select：landing 态用户选定预设变化时通知父组件（wave3 session.create 透传链路用）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Lock, SlidersHorizontal } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { usePresetStore } from '@/stores/preset'
import { usePiPresets } from '@/composables/features/usePiPresets'
import type { PiLaunchPreset } from '@xyz-agent/shared'

const props = defineProps<{
  /** 绑定的 session id（landing 态为 null） */
  sessionId: string | null
  /** session 创建时锁定的预设 id（SessionSummary.launchPresetId）。undefined=历史 session */
  launchPresetId?: string
}>()

const emit = defineEmits<{
  /** landing 态用户选定预设变化（wave3 session.create 透传用，单参数对象） */
  select: [{ presetId: string }]
}>()

const { t } = useI18n()
const store = usePresetStore()
const { loadPresets, setDefault } = usePiPresets()

/** Popover 展开态（仅 landing 态用） */
const open = ref(false)
/**
 * landing 态用户本次选定的预设 id（交互态，不放 store）。
 * 初值 '' —— onMounted loadPresets 完成后设为 store.defaultPresetId（回显全局默认）。
 */
const selectedPresetId = ref('')

// ── 三态派生 ──
/** landing 态：sessionId 为空（无绑定 session，可创建/选预设） */
const isLanding = computed(() => props.sessionId == null)
/** 历史 session 态：sessionId 非空 + launchPresetId 缺失（设计上线前创建的 session） */
const isLegacy = computed(() => props.sessionId != null && props.launchPresetId == null)
// 注：已创建锁定态（sessionId!=null + launchPresetId 有值）是 isLegacy 的补集，
// 模板用 v-else 覆盖（isLanding=false 且 isLegacy=false 即锁定态），无需独立 isLocked computed。

/** 锁定态/历史态显示的预设名 */
const lockedPresetName = computed(() => {
  if (isLegacy.value) return t('newTask.presetSelect.legacyPresetName')
  const id = props.launchPresetId
  // presets 未加载 / 找不到时用 id 兜底（不崩）
  return store.presets.find((p) => p.id === id)?.name ?? id ?? ''
})

/** landing 态触发按钮显示的预设名（selectedPresetId 查名，找不到用 id 兜底） */
const selectedPresetName = computed(() => {
  const id = selectedPresetId.value
  if (!id) return t('newTask.presetSelect.loadingPresets')
  return store.presets.find((p) => p.id === id)?.name ?? id
})

/** 锁定态 tooltip 文案（已创建态 + 历史态分别拼接） */
const lockedTooltip = computed(() => {
  const base = t('newTask.presetSelect.presetLockedTooltip', { name: lockedPresetName.value })
  if (isLegacy.value) {
    return `${base}${t('newTask.presetSelect.legacySessionTooltip')}`
  }
  return base
})

/** 「设为默认」Checkbox 勾选态（当前选定 = 全局默认） */
const isDefaultChecked = computed(() => {
  if (!selectedPresetId.value) return false
  return selectedPresetId.value === store.defaultPresetId
})

// onMounted 拉预设数据 + 回显默认预设（landing 态）
onMounted(async () => {
  if (!isLanding.value) return // 锁定/历史态无需拉数据（只读展示，预设名从 launchPresetId 查）
  await loadPresets()
  // loadPresets 后回显全局默认预设（landing 态 chip 所见即默认）
  if (store.defaultPresetId && !selectedPresetId.value) {
    selectedPresetId.value = store.defaultPresetId
    store.selectPreset(store.defaultPresetId)
    emit('select', { presetId: store.defaultPresetId })
  }
})

/**
 * landing 态选预设（RadioGroup 语义：单选 + 立即选中）。
 * 同步写 store.selectedPresetId（Composer onSend 时读取透传 session.create）。
 */
function onSelectPreset(preset: PiLaunchPreset): void {
  selectedPresetId.value = preset.id
  store.selectPreset(preset.id)
  emit('select', { presetId: preset.id })
}

/**
 * 勾选/取消「设为默认」。
 * 勾选：调 setDefault(selectedPresetId) 写全局默认 + store 更新。
 * 取消：no-op（全局默认至少有一个值，不支持取消到空——用户可选其他预设设默认替代）。
 */
async function onToggleDefault(checked: boolean | string): Promise<void> {
  if (checked && selectedPresetId.value) {
    await setDefault(selectedPresetId.value)
  }
}

// store.defaultPresetId 变化时（外部 setDefault），同步 selectedPresetId 若用户未主动选过
watch(() => store.defaultPresetId, (newDefault) => {
  if (isLanding.value && newDefault && !open.value) {
    // 仅在 Popover 未展开时回显（避免用户正在选时被覆盖）
    selectedPresetId.value = newDefault
    store.selectPreset(newDefault)
  }
})
</script>

<template>
  <!-- landing 态：Popover 可选预设 -->
  <Popover v-if="isLanding" v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        data-testid="chip-preset"
        variant="ghost"
        class="h-auto gap-1.5 px-2 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
        :class="{ '!text-accent': !selectedPresetId }"
      >
        <SlidersHorizontal class="shrink-0" />
        <span class="font-mono">{{ selectedPresetName }}</span>
        <ChevronDown
          class="ml-px size-[9px] shrink-0 transition-transform duration-200"
          :class="open && 'rotate-180'"
        />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" class="w-[320px] p-0">
      <!-- head -->
      <div
        class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle"
      >
        <span>{{ t('newTask.presetSelect.title') }}</span>
      </div>
      <!-- 预设列表（Button + Check 实现 RadioGroup 语义，ui 无 RadioGroup） -->
      <div v-if="store.presets.length === 0" class="px-2.5 py-3 text-[12px] text-subtle">
        {{ t('newTask.presetSelect.noPresets') }}
      </div>
      <Button
        v-for="preset in store.presets"
        :key="preset.id"
        variant="ghost"
        class="flex w-full flex-col items-start gap-0.5 rounded-none px-2.5 py-2 text-muted hover:bg-surface-hover hover:text-fg"
        :class="selectedPresetId === preset.id && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'"
        @click="onSelectPreset(preset)"
      >
        <div class="flex w-full items-center gap-2">
          <span
            class="size-[7px] shrink-0 rounded-full"
            :class="selectedPresetId === preset.id ? 'bg-accent' : 'bg-subtle'"
          />
          <span class="flex-1 text-left text-[13px]">{{ preset.name }}</span>
          <Check
            class="size-[13px] text-accent transition-opacity"
            :class="selectedPresetId === preset.id ? 'opacity-100' : 'opacity-0'"
          />
        </div>
        <span v-if="preset.description" class="pl-[15px] text-left text-[11px] text-subtle">
          {{ preset.description }}
        </span>
      </Button>
      <!-- 设为默认（分隔线 + Checkbox） -->
      <div class="flex items-center gap-2 border-t border-border px-2.5 py-2">
        <Checkbox
          :model-value="isDefaultChecked"
          data-testid="checkbox-set-default"
          @update:model-value="onToggleDefault"
        />
        <span class="text-[12px] text-muted">{{ t('newTask.presetSelect.setAsDefault') }}</span>
      </div>
    </PopoverContent>
  </Popover>

  <!-- 锁定态 / 历史 session 态：Lock 图标 + 预设名 + HoverCard tooltip -->
  <HoverCard v-else :open-delay="200">
    <HoverCardTrigger as-child>
      <Button
        data-testid="chip-preset-locked"
        variant="ghost"
        class="h-auto cursor-default gap-1.5 px-2 py-1 text-[12px] text-subtle hover:bg-transparent hover:text-subtle [&_svg]:size-3.5"
      >
        <Lock class="shrink-0" />
        <span class="font-mono">{{ lockedPresetName }}</span>
      </Button>
    </HoverCardTrigger>
    <HoverCardContent side="top" class="max-w-[280px] px-2.5 py-1.5 text-[11px] text-muted">
      {{ lockedTooltip }}
    </HoverCardContent>
  </HoverCard>
</template>
