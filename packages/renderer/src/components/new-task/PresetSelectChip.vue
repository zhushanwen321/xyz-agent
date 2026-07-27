<script setup lang="ts">
/**
 * PresetSelectChip —— pi 启动预设选择 chip（设计文档 pi-launch-presets.md §3 / §5.4）。
 *
 * 三态（由 props.sessionId + props.launchPresetId 派生）：
 * 1. landing 态（sessionId=null）：Popover 可展开，列预设（RadioGroup + RadioGroupItem 原语，
 *    标准 radio 键盘可达）+ 描述 + 「设为默认」Checkbox。selectedPresetId 本地 ref，初值在
 *    loadPresets 后设为 defaultPresetId。
 * 2. 已创建态（sessionId!=null + launchPresetId 有值）：Lock 图标 + 预设名 + HoverCard tooltip
 *    「此 Session 使用 {预设名} 模式创建，不可更改」。不展开 Popover。
 * 3. 历史 session（sessionId!=null + launchPresetId undefined）：Lock 图标 + 「全工具模式」+
 *    HoverCard tooltip 加注「（历史 session，未记录预设）」。
 *
 * 互斥（preset 互斥 wave）：Popover 展开态不再用本地 open ref，改由父组件经 v-model:presetOpen
 * 透传的 prop 驱动。Landing.vue 的 isPresetOpen computed 接 flow.state==='preset-popover'，
 * 与 dir/branch popover 共享 NewTaskFlowState 单实例状态机，三 popover 互斥（开 preset 自动
 * 关 dir/branch，反之亦然）。组件本身不读 flow——只声明 presetOpen prop + emit update:presetOpen。
 *
 * 数据流（B6 修复）：onMounted 调 usePiPresets().loadPresets() 拉预设列表 + 默认预设写 store
 * （presets/defaultPresetId/loadError）。选中态用本地 ref selectedPresetId（仅回显），透传走
 * emit('select') → 父组件（Landing.vue）调 flow.setPendingPreset → submitFirstMessage 透传。
 * 不再读写 store.selectedPresetId（已删除第二真源）。
 *
 * emit select 的契约：**仅在用户真实点击预设项时 emit**（onSelectPreset），onMounted 回显默认
 * 预设**不 emit**——避免把「默认回显」伪装成「用户选择」污染透传链路（透传源是 NewTaskFlow.pendingPreset，
 * 用户没选时不写，submitFirstMessage 用 undefined → runtime 走默认）。
 *
 * 加载错误态（S-RN-2）：loadPresets rejected 时 store.loadError 写入错误消息，本组件区分
 * 「未加载（presets=[] + loadError=null）」与「加载失败（presets=[] + loadError 有值）」，
 * 不再因 RPC 永久 reject 卡「加载中…」。
 *
 * 范式参考：ThinkingLevelPopover.vue（Popover+TriggerButton+Content + RadioGroup 原语）。
 */
import { computed, onMounted, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Lock, SlidersHorizontal } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { usePresetStore } from '@/stores/preset'
import { usePiPresets } from '@/composables/features/usePiPresets'
import type { PiLaunchPreset } from '@xyz-agent/shared'

const props = defineProps<{
  /** 绑定的 session id（landing 态为 null） */
  sessionId: string | null
  /** session 创建时锁定的预设 id（SessionSummary.launchPresetId）。undefined=历史 session */
  launchPresetId?: string
  /**
   * Popover 展开态（仅 landing 态用）。由父组件经 v-model:presetOpen 透传，派生自
   * NewTaskFlowState==='preset-popover'，与 dir/branch popover 共享 flow 单实例状态机互斥。
   * 组件只声明 + emit update，不读 flow（flow 耦合在 Landing.vue）。
   */
  presetOpen: boolean
}>()

const emit = defineEmits<{
  /** landing 态用户真实点击选定预设变化（session.create 透传用，单参数对象） */
  select: [{ presetId: string }]
  /** v-model:presetOpen 同步（Popover 内部 open 变化回传父组件） */
  'update:presetOpen': [boolean]
}>()

const { t } = useI18n()
const store = usePresetStore()
const { loadPresets, setDefault } = usePiPresets()

/**
 * landing 态触发按钮回显的预设 id（纯本地交互态，不放 store——B6：store 不再持有 selectedPresetId）。
 * 初值 '' —— onMounted loadPresets 完成后设为 store.defaultPresetId（仅回显，不 emit）。
 * 用户真实点击 onSelectPreset 时才 emit select 给父组件透传。
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

/**
 * landing 态触发按钮显示的预设名。
 * - 未加载（selectedPresetId 空 + 无 loadError）→ loadingPresets「加载中…」
 * - 加载失败（selectedPresetId 空 + loadError 有值）→ 仍显 loadingPresets（i18n key 不可改，
 *   popover 内空态行区分错误），避免 trigger 文案与 i18n SSOT 脱节。
 * - 有选中 → 查名兜底 id。
 */
const selectedPresetName = computed(() => {
  const id = selectedPresetId.value
  if (!id) return t('newTask.presetSelect.loadingPresets')
  return store.presets.find((p) => p.id === id)?.name ?? id
})

/**
 * popover 列表区空态文案（S-RN-2）：
 * - loadError 有值 → 复用 noPresets（i18n key 不可改；错误详情已在 usePiPresets console.warn）
 * - 无错误 + 列表空 → noPresets「暂无预设」
 * 二者用同一 key 因 i18n 文件不在本任务可改范围；区分点在 loadError 本身（可观测 + 可重试扩展）。
 */
const emptyHint = computed(() => t('newTask.presetSelect.noPresets'))

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

// onMounted 拉预设数据 + 回显默认预设（landing 态）。
// B6 修复：**只回显本地选中态，不 emit select**——避免把「默认回显」伪装成「用户选择」
// 污染透传链路。用户没选时 NewTaskFlow.pendingPreset 保持 null，submitFirstMessage 传
// undefined → runtime 用默认，与「显式选了默认预设」语义区分清晰。
onMounted(async () => {
  if (!isLanding.value) return // 锁定/历史态无需拉数据（只读展示，预设名从 launchPresetId 查）
  await loadPresets()
  // loadPresets 后回显全局默认预设（landing 态 chip 所见即默认，纯视觉一致性）
  if (store.defaultPresetId && !selectedPresetId.value) {
    selectedPresetId.value = store.defaultPresetId
  }
})

// FR-16：键盘快捷键 Cmd+Shift+P → 打开 PresetSelectChip Popover
// store.openRequest 由 useAppCommands 的快捷键 action 递增，watch 到变化后打开。
// preset 互斥 wave：展开态交父组件 flow 单实例状态机，这里 emit update:presetOpen=true，
// Landing.vue 的 isPresetOpen setter 调 flow.openPresetPopover（自动关 dir/branch popover）。
watch(() => store.openRequest, async () => {
  if (!isLanding.value) return
  await nextTick()
  emit('update:presetOpen', true)
})

/**
 * landing 态用户真实点击选预设（RadioGroup 语义：单选 + 立即选中）。
 * B6：仅此处 emit select——透传源是 NewTaskFlow.pendingPreset（父组件 Landing.vue 接收写入），
 * 不再读写 store.selectedPresetId（已删除）。本地 selectedPresetId 只管 trigger 回显。
 */
function onSelectPreset(preset: PiLaunchPreset): void {
  selectedPresetId.value = preset.id
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
  if (isLanding.value && newDefault && !props.presetOpen) {
    // 仅在 Popover 未展开时回显（避免用户正在选时被覆盖）。纯本地回显，不 emit。
    selectedPresetId.value = newDefault
  }
})
</script>

<template>
  <!-- landing 态：Popover 可选预设（preset 互斥 wave：open 态由父 v-model:presetOpen 驱动，不再本地 open ref） -->
  <Popover v-if="isLanding" :open="presetOpen" @update:open="$emit('update:presetOpen', $event)">
    <PopoverTrigger as-child>
      <Button
        data-testid="chip-preset"
        variant="ghost"
        class="h-auto gap-1.5 px-2 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
        :class="{ '!text-accent': selectedPresetId && selectedPresetId === store.defaultPresetId }"
      >
        <SlidersHorizontal class="shrink-0" />
        <span class="font-mono">{{ selectedPresetName }}</span>
        <ChevronDown
          class="ml-px size-[9px] shrink-0 transition-transform duration-200"
          :class="presetOpen && 'rotate-180'"
        />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" :collision-padding="8" :side-offset="8" class="w-[280px] p-0">
      <!-- head（W-RN-1：bg-white/[0.015] → bg-surface-2 语义类，与 PopoverContent 的 bg-bg-elevated 区分头/体层级） -->
      <div
        class="flex items-center justify-between border-b border-border bg-surface-2 px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle"
      >
        <span>{{ t('newTask.presetSelect.title') }}</span>
      </div>
      <!-- 预设列表（RadioGroup + RadioGroupItem 原语：标准 radio 键盘可达，替代旧 ghost Button + 自绘圆点） -->
      <div v-if="store.presets.length === 0" class="px-2.5 py-3 text-[12px] text-subtle">
        {{ emptyHint }}
      </div>
      <RadioGroup
        v-else
        :model-value="selectedPresetId"
        class="gap-0"
        @update:model-value="(val) => { const p = store.presets.find((x) => x.id === val); if (p) onSelectPreset(p) }"
      >
        <Label
          v-for="preset in store.presets"
          :key="preset.id"
          class="flex w-full cursor-pointer flex-col items-start gap-0.5 px-2.5 py-2 text-muted hover:bg-surface-hover hover:text-fg"
          :class="selectedPresetId === preset.id && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'"
        >
          <div class="flex w-full items-center gap-2">
            <RadioGroupItem
              :value="preset.id"
              :data-testid="`preset-option-${preset.id}`"
            />
            <span class="flex-1 text-left text-[13px]">{{ preset.name }}</span>
          </div>
          <span v-if="preset.description" class="pl-[15px] text-left text-[11px] text-subtle">
            {{ preset.description }}
          </span>
        </Label>
      </RadioGroup>
      <!-- 设为默认（分隔线 + Checkbox）。已是默认时 disabled：全局默认至少一个，不能取消到空，只能选其他预设替代 -->
      <div class="flex items-center gap-2 border-t border-border px-2.5 py-2">
        <Checkbox
          :model-value="isDefaultChecked"
          :disabled="isDefaultChecked"
          data-testid="checkbox-set-default"
          @update:model-value="onToggleDefault"
        />
        <span class="text-[12px] text-muted">{{ t('newTask.presetSelect.setAsDefault') }}</span>
        <span v-if="isDefaultChecked" class="text-[10px] text-subtle">· {{ t('newTask.presetSelect.alreadyDefault') }}</span>
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
