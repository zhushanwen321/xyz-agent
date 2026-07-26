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
      <p class="text-[12px] text-muted">{{ t('settings.preset.pageDesc') }}</p>
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
    <div v-if="!presets.length" class="py-8 text-center text-[12px] text-muted">
      {{ t('settings.preset.empty') }}
    </div>

    <!-- 预设列表 -->
    <div
      v-for="p in presets"
      :key="p.id"
      class="rounded-md border border-border bg-bg"
    >
      <!-- 预设头部 -->
      <div class="flex items-center gap-3 px-3 py-2.5">
        <div class="min-w-0 flex-1 flex flex-col gap-0.5">
          <div class="flex items-center gap-2">
            <span class="truncate text-[13px] font-medium text-fg">{{ p.name }}</span>
            <span
              v-if="p.builtin"
              class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-subtle"
            >{{ t('settings.preset.builtin') }}</span>
            <span
              v-if="p.id === defaultPresetId"
              class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent"
            >{{ t('settings.preset.default') }}</span>
          </div>
          <span v-if="p.description" class="truncate text-[11px] text-muted">{{ p.description }}</span>
        </div>
        <div class="flex items-center gap-1">
          <!-- 设为默认 -->
          <Button
            v-if="p.id !== defaultPresetId"
            variant="ghost"
            size="dense"
            class="rounded-sm text-[11px] text-subtle hover:text-fg"
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
            class="rounded-sm text-[11px] text-subtle hover:text-fg"
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
            class="rounded-sm text-[11px] text-subtle hover:text-danger"
            @click="confirmDeleteId = p.id"
          >
            <Trash2 class="size-3.5" />
          </Button>
        </div>
      </div>

      <!-- 编辑区（展开/折叠） -->
      <div class="border-t border-border px-3 py-3">
        <div class="flex flex-col gap-3">
          <!-- 名称 + ID（内置 disabled） -->
          <!-- 受控写法（:model-value + @update:model-value）有意为之：配合 debounce
               控制字段更新的 flush 时机（onFieldChange → debouncedUpdate 400ms）。
               改 v-model 会失去 debounce 能力（每次 keystroke 立即触发 RPC）。 -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <Label class="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
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
              <Label class="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
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
            <Label class="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
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
      </div>
    </div>

    <!-- 3 个内置扩展提示 -->
    <p class="text-[11px] text-subtle">
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
import { computed, ref, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import { Plus, Star, Trash2, RotateCcw, AlertCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/ui/dialog'
import { usePresetStore } from '@/stores/preset'
import { usePiPresets } from '@/composables/features/usePiPresets'
import { useToast } from '@/composables/useToast'
import { DEFAULT_PRESETS } from '@xyz-agent/shared'
import type { PiLaunchPreset, ToolMode, ExtensionMode } from '@xyz-agent/shared'
import PresetModeSection from './PresetModeSection.vue'

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

onMounted(() => {
  if (!presets.value.length) loadPresets()
})

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
