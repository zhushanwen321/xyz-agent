<!--
  Settings · Pi 启动预设管理页。
  列出全部预设（内置 + 自定义），支持新建/编辑/删除自定义预设。
  内置预设 name/id disabled + 恢复默认按钮。
  工具/extension 黑白名单 UI（4 种 mode 切换 + Checkbox 列表）在子组件 PresetModeSection。
  数据来自 usePiPresets composable（features 层），本组件只做展示 + 事件绑定。
-->
<template>
  <div class="flex flex-col gap-4">
    <!-- 新建按钮 -->
    <div class="flex items-center justify-between">
      <p class="text-[12px] text-neutral-mid">{{ t('settings.preset.pageDesc') }}</p>
      <Button size="dense" class="rounded-sm text-[12px]" @click="onCreate">
        <Plus class="size-3.5" />
        {{ t('settings.preset.new') }}
      </Button>
    </div>

    <!-- 加载失败提示（S-RN-7：消费 loadError 错误态） -->
    <div
      v-if="loadError"
      class="flex items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-[12px] text-danger"
    >
      <AlertCircle class="size-3.5 shrink-0" />
      <span class="flex-1">{{ loadError }}</span>
      <Button variant="ghost" size="dense" class="rounded-sm text-[11px]" @click="retryLoad">
        {{ t('common.retry') }}
      </Button>
    </div>

    <!-- 空态 -->
    <div v-if="!presets.length" class="py-8 text-center text-[12px] text-neutral-mid">
      {{ t('settings.preset.empty') }}
    </div>

    <!-- 预设列表（每个卡片独立折叠：自定义默认展开便于编辑，内置默认折叠便于扫视） -->
    <Collapsible
      v-for="p in presets"
      :key="p.id"
      :open="isExpanded(p.id)"
      class="rounded-card bg-card"
      @update:open="(v) => toggleExpanded(p.id, v)"
    >
      <!-- 预设头部：CollapsibleTrigger as-child 包 Button，构成全宽点击区。
           操作按钮组（设为默认/恢复/删除）放 Trigger 外的同级 div，避免点操作也触发展开。 -->
      <div class="flex items-center gap-3 px-3 py-2.5">
        <CollapsibleTrigger as-child>
          <Button
            variant="ghost"
            class="h-auto flex-1 justify-start gap-2 rounded-sm px-2 text-neutral-fg hover:bg-surface"
            :title="isExpanded(p.id) ? t('settings.preset.collapse') : t('settings.preset.expand')"
          >
            <ChevronDown
              class="size-3.5 shrink-0 text-neutral-dim transition-transform duration-200"
              :class="isExpanded(p.id) ? 'rotate-180' : ''"
            />
            <div class="min-w-0 flex-1 flex flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span class="truncate text-[13px] font-medium">{{ p.name }}</span>
                <span
                  v-if="p.builtin"
                  class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-neutral-dim"
                >{{ t('settings.preset.builtin') }}</span>
                <span
                  v-if="p.id === defaultPresetId"
                  class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent"
                >{{ t('settings.preset.default') }}</span>
              </div>
              <!-- 折叠态摘要行：一行 mode 概览（如「工具访问策略: 全部可用 · 扩展访问策略: 白名单 3 项」） -->
              <span class="truncate text-[11px] text-neutral-mid">{{ summaryText(p) }}</span>
              <!-- 展开态额外显示描述（折叠态由摘要代替，避免行数过多） -->
              <span v-if="p.description && isExpanded(p.id)" class="truncate text-[11px] text-neutral-dim">{{ p.description }}</span>
            </div>
          </Button>
        </CollapsibleTrigger>
        <div class="flex items-center gap-1">
          <!-- 设为默认 -->
          <Button
            v-if="p.id !== defaultPresetId"
            variant="ghost"
            size="dense"
            class="rounded-sm text-[11px] text-neutral-dim hover:text-neutral-fg"
            @click="onSetDefault(p.id)"
          >
            <Star class="size-3.5" />
            {{ t('settings.preset.setDefault') }}
          </Button>
          <!-- 恢复默认（仅内置） -->
          <Button
            v-if="p.builtin"
            variant="ghost"
            size="dense"
            class="rounded-sm text-[11px] text-neutral-dim hover:text-neutral-fg"
            :disabled="restoring.has(p.id)"
            @click="onRestore(p)"
          >
            <RotateCcw class="size-3.5" />
            {{ t('settings.preset.restore') }}
          </Button>
          <!-- 删除（仅自定义） -->
          <Button
            v-if="!p.builtin"
            variant="ghost"
            size="dense"
            class="rounded-sm text-[11px] text-neutral-dim hover:text-danger"
            @click="confirmDeleteId = p.id"
          >
            <Trash2 class="size-3.5" />
          </Button>
        </div>
      </div>

      <!-- 编辑区（仅展开时渲染） -->
      <CollapsibleContent class="border-t border-border">
        <div class="flex flex-col gap-3 px-3 py-3">
          <!-- 名称 + ID（内置 disabled） -->
          <!-- 受控写法（:model-value + @update:model-value）有意为之：配合 debounce
               控制字段更新的 flush 时机（onFieldChange → debouncedUpdate 400ms）。
               改 v-model 会失去 debounce 能力（每次 keystroke 立即触发 RPC）。 -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <Label class="mb-1 block text-[11px] font-semibold text-neutral-mid">
                {{ t('settings.preset.name') }}
              </Label>
              <Input
                :model-value="p.name"
                :disabled="p.builtin"
                class="h-8 text-[12px]"
                :placeholder="t('settings.preset.namePlaceholder')"
                @update:model-value="(v) => onFieldChange(p, 'name', String(v))"
              />
            </div>
            <div>
              <Label class="mb-1 block text-[11px] font-semibold text-neutral-mid">
                {{ t('settings.preset.id') }}
              </Label>
              <Input
                :model-value="p.id"
                disabled
                class="h-8 text-[12px] font-mono"
              />
            </div>
          </div>
          <!-- 描述（受控写法 + debounce，同 name 字段，见上文注释） -->
          <div>
            <Label class="mb-1 block text-[11px] font-semibold text-neutral-mid">
              {{ t('settings.preset.description') }}
            </Label>
            <Input
              :model-value="p.description ?? ''"
              :disabled="p.builtin"
              class="h-8 text-[12px]"
              :placeholder="t('settings.preset.descPlaceholder')"
              @update:model-value="(v) => onFieldChange(p, 'description', String(v))"
            />
          </div>

          <!-- 工具模式 + 扩展模式 -->
          <PresetModeSection :preset="p" :disabled="p.builtin" @update="onModeUpdate" />
        </div>
      </CollapsibleContent>
    </Collapsible>

    <!-- 3 个内置扩展提示 -->
    <p class="text-[11px] text-neutral-dim">
      {{ t('settings.preset.builtinExtensionHint') }}
    </p>

    <!-- 删除确认弹窗 -->
    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      variant="danger"
      :title="t('settings.preset.deleteConfirmTitle', { name: deleteTargetName })"
      :description="t('settings.preset.deleteConfirmDesc')"
      :confirm-text="t('settings.preset.deleteConfirmBtn')"
      :cancel-text="t('settings.preset.cancel')"
      :loading="deleting"
      @confirm="onConfirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import { Plus, Star, Trash2, RotateCcw, AlertCircle, ChevronDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { ConfirmDialog } from '@/components/ui/dialog'
import { usePresetStore } from '@/stores/preset'
import { usePiPresets } from '@/composables/features/usePiPresets'
import { useToast } from '@/composables/useToast'
import { DEFAULT_PRESETS } from '@xyz-agent/shared'
import type { PiLaunchPreset, ToolMode, ExtensionMode } from '@xyz-agent/shared'
import { PresetModeSection } from '@xyz-agent/ui/features/settings'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()
const store = usePresetStore()
const { presets, defaultPresetId, loadError } = storeToRefs(store)
const { loadPresets, setDefault, create, update, remove } = usePiPresets()

/** 字段编辑（name/description）的 debounce 延迟——W-RN-2 节流 RPC 频率。 */
const FIELD_UPDATE_DEBOUNCE_MS = 400
/** base36 进制基数（Math.toString 参数，标准 JS 写法）。 */
const BASE36_RADIX = 36
/** Math.random() 输出 '0.xxx'，slice 跳过前 2 字符（'0.'）取余下随机串。 */
const RANDOM_PREFIX_LEN = 2

// 删除确认
const confirmDeleteId = ref('')
const deleting = ref(false)
const deleteDialogOpen = computed({
  get: () => confirmDeleteId.value !== '',
  set: (open: boolean) => {
    if (!open) confirmDeleteId.value = ''
  },
})
const deleteTargetName = computed(() =>
  presets.value.find((p) => p.id === confirmDeleteId.value)?.name ?? '',
)

// 恢复中集合
const restoring = ref<Set<string>>(new Set())

/**
 * expandedIds —— 每个预设卡片的展开态（id → 是否展开）。
 *
 * 初始化为空 Set，由下方 watch(presets) 在预设加载/新增时按 builtin 决定初始态：
 * 自定义预设默认展开（用户要编辑），内置预设默认折叠（当作文档扫视）。
 * 不能在 setup eager 初始化（此时 presets 为空，loadPresets 在 onMounted 异步跑），
 * 否则 expandedIds 永远空 → 生产环境自定义预设也折叠（与设计意图相反）。
 * 用户手动折叠/展开后，对应 id 的态被记住，不被 watch 覆盖（watch 只处理未见过的 id）。
 *
 * 删除预设时 stale id 残留：无害（isExpanded 只对当前渲染的预设调用），不专门清理。
 */
const expandedIds = ref<Set<string>>(new Set())
function isExpanded(id: string): boolean {
  return expandedIds.value.has(id)
}
function toggleExpanded(id: string, open: boolean): void {
  const next = new Set(expandedIds.value)
  if (open) next.add(id)
  else next.delete(id)
  expandedIds.value = next
}

/**
 * watch presets —— 新预设出现时按 builtin 决定初始展开态。
 *
 * 只处理「未见过的 id」（expandedIds 里没有的），避免覆盖用户手动操作过的态。
 * immediate: true 覆盖首屏 store 已有数据的情况（PiPresetsPage 挂载前 store 可能已被
 * 其他入口预加载）；非 immediate 路径覆盖 onMounted loadPresets 后异步到达的情况。
 */
watch(
  presets,
  (next) => {
    const nextSet = new Set(expandedIds.value)
    for (const p of next) {
      if (!nextSet.has(p.id) && !p.builtin) {
        nextSet.add(p.id)
      }
    }
    expandedIds.value = nextSet
  },
  { immediate: true },
)

onMounted(() => {
  if (!presets.value.length) loadPresets()
})

/**
 * 单个 mode 的小标题：生成如「全部可用」/「白名单 3 项」。
 *
 * allowlist 看的是 allowedTools/allowedExtensions（被显式授权的数量），
 * denylist 看的是 deniedTools/deniedExtensions（被显式禁用的数量）——
 * 即「用户特殊配置了几项」。由调用方传入对应模式的 list。
 */
function modeSummary(mode: ToolMode | ExtensionMode, list: string[] | undefined): string {
  switch (mode) {
    case 'all':
      return t('settings.preset.summaryAll')
    case 'none':
      return t('settings.preset.summaryNone')
    case 'allowlist':
      return t('settings.preset.summaryAllowlist', { count: list?.length ?? 0 })
    case 'denylist':
      return t('settings.preset.summaryDenylist', { count: list?.length ?? 0 })
    default:
      // 未来 ToolMode/ExtensionMode 加枚举值时兜底返回空，避免静默返回 undefined
      return ''
  }
}

/**
 * 折叠态摘要行：拼接「工具访问策略: xxx · 扩展访问策略: yyy」一行 mode 概览。
 * 让用户在折叠态即可扫视每个预设的访问策略，无需展开。
 */
function summaryText(p: PiLaunchPreset): string {
  const toolList = p.toolMode === 'allowlist' ? p.allowedTools : p.deniedTools
  const extList = p.extensionMode === 'allowlist' ? p.allowedExtensions : p.deniedExtensions
  const tool = `${t('settings.preset.toolMode')}: ${modeSummary(p.toolMode, toolList)}`
  const ext = `${t('settings.preset.extensionMode')}: ${modeSummary(p.extensionMode, extList)}`
  return tool + t('settings.preset.summarySeparator') + ext
}

/** 重试加载预设（S-RN-7：loadError 态下的手动重试入口）。 */
async function retryLoad() {
  try {
    await loadPresets()
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/** 设为默认预设 */
async function onSetDefault(presetId: string) {
  try {
    await setDefault(presetId)
    toastInfo(t('settings.preset.defaultSet'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/** 新建自定义预设 */
async function onCreate() {
  // crypto.randomUUID 在非安全上下文（HTTP / 旧环境）可能不可用，用 Date+random 兜底
  const uuid = crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(BASE36_RADIX).slice(RANDOM_PREFIX_LEN)}`
  const id = `custom:${uuid}`
  const newPreset: PiLaunchPreset = {
    id,
    name: t('settings.preset.newPresetName'),
    builtin: false,
    order: presets.value.length,
    toolMode: 'all',
    extensionMode: 'all',
  }
  try {
    await create(newPreset)
    toastInfo(t('settings.preset.created'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/**
 * 字段变更（name/description）→ 乐观更新。
 *
 * W-RN-2：每次 keystroke 不直接调 update RPC，先 debounce 400ms 聚合连续输入。
 * 同一输入框的连续 keystroke 共享一个 debounce timer（人类一次只编辑一个字段），
 * 最后一次输入的 preset 镜像被 flush 发 RPC。
 * update 内部已乐观 upsert + reply 回写（W-RN-3），这里只负责节流 RPC 频率。
 *
 * debounce 而非「失焦/Enter flush」：编辑器场景用户期望静默自动保存（无需手动
 * 失焦/回车），debounce 是更符合直觉的折中。
 */
const updateFieldDebounced = useDebounceFn(
  async (preset: PiLaunchPreset) => {
    try {
      await update(preset)
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e))
    }
  },
  FIELD_UPDATE_DEBOUNCE_MS,
)

/** 字段变更（name/description）入口：构造乐观镜像并交 debounce 节流。 */
function onFieldChange(preset: PiLaunchPreset, field: 'name' | 'description', value: string) {
  if (preset.builtin) return
  const updated = { ...preset, [field]: value || undefined }
  void updateFieldDebounced(updated)
}

/** 恢复内置预设到出厂设置 */
async function onRestore(preset: PiLaunchPreset) {
  const original = DEFAULT_PRESETS.find((d) => d.id === preset.id)
  if (!original) return
  const next = new Set(restoring.value)
  next.add(preset.id)
  restoring.value = next
  try {
    await update({ ...original, order: preset.order })
    toastInfo(t('settings.preset.restored'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    const after = new Set(restoring.value)
    after.delete(preset.id)
    restoring.value = after
  }
}

/** 删除自定义预设 */
async function onConfirmDelete() {
  if (!confirmDeleteId.value || deleting.value) return
  deleting.value = true
  try {
    await remove(confirmDeleteId.value)
    confirmDeleteId.value = ''
    toastInfo(t('settings.preset.deleted'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  } finally {
    deleting.value = false
  }
}

/** 工具/扩展模式变更（来自 PresetModeSection） */
async function onModeUpdate(payload: { presetId: string; toolMode?: ToolMode; extensionMode?: ExtensionMode; allowedTools?: string[]; deniedTools?: string[]; allowedExtensions?: string[]; deniedExtensions?: string[] }) {
  const target = presets.value.find((p) => p.id === payload.presetId)
  if (!target || target.builtin) return
  const updated: PiLaunchPreset = {
    ...target,
    ...(payload.toolMode !== undefined && { toolMode: payload.toolMode }),
    ...(payload.extensionMode !== undefined && { extensionMode: payload.extensionMode }),
    ...(payload.allowedTools !== undefined && { allowedTools: payload.allowedTools }),
    ...(payload.deniedTools !== undefined && { deniedTools: payload.deniedTools }),
    ...(payload.allowedExtensions !== undefined && { allowedExtensions: payload.allowedExtensions }),
    ...(payload.deniedExtensions !== undefined && { deniedExtensions: payload.deniedExtensions }),
  }
  try {
    await update(updated)
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}
</script>
