<template>
  <GroupCard :title="t('settings.system.autoRenameSession')">
    <div class="px-2.5 pt-1 pb-2">
      <SettingRow :label="t('settings.system.autoRenameSession')" :desc="t('settings.system.autoRenameDesc')">
        <Switch
          data-testid="setting-auto-rename-session"
          :model-value="autoRenameEnabled"
          :disabled="togglingAutoRename"
          @update:model-value="onSaveAutoRename"
        />
      </SettingRow>
      <SettingRow :label="t('settings.system.renameModel')" :desc="t('settings.system.renameModelHint')">
        <Select
          :model-value="selectedValue"
          :disabled="!autoRenameEnabled || savingRenameModel"
          @update:model-value="onRenameModelChange"
        >
          <SelectTrigger class="h-8 w-[200px] px-2 text-xs" data-testid="setting-rename-model">
            <SelectValue :placeholder="t('settings.system.renameModelNotSet')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="RENAME_MODEL_UNSET">{{ t('settings.system.renameModelNotSet') }}</SelectItem>
            <SelectGroup v-for="group in modelGroups" :key="group.providerId">
              <SelectLabel>{{ group.providerName }}</SelectLabel>
              <SelectItem v-for="m in group.models" :key="m.value" :value="m.value">
                {{ m.label }}
              </SelectItem>
            </SelectGroup>
            <!-- 当前配置的 ref 不在可选列表（模型被删/provider 未配凭证）→ 保留显示供改选，标记不可用 -->
            <SelectItem v-if="staleRef" :value="staleRef" disabled>
              {{ staleRef }} {{ t('settings.system.renameModelUnavailable') }}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard } from '@xyz-agent/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSettingsStore, type SystemSettings } from '@xyz-agent/core'
import { getAutoRenameEnabled, getRenameModel, setAutoRenameEnabled, setRenameModel } from '@/api/domains/settings'
import { useToast } from '@/composables/useToast'

// 统一 Section 契约（未使用 system：autoRename 走独立 API；不 emit：变更经各自 API 持久化）
defineProps<{
  system: SystemSettings
}>()

defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

// ── 会话自动重命名开关（独立 flag file，不走 SystemSettings 体系）──
const autoRenameEnabled = ref(true)
const togglingAutoRename = ref(false)

// ── 重命名模型（extension 配置文件，"provider/modelId" 复合串，空串 = 未设置）──
const renameModel = ref('')
const savingRenameModel = ref(false)

/**
 * 「未设置」项 sentinel value。reka-ui 禁止 SelectItem value=""（空串是 Select
 * 清空选择的保留值），与 SystemPage 提示音 SOUND_DEFAULT='__default__' 同款处理：
 * change 时映射回空串持久化（空串 = extension 的 model.ref 默认值）。
 * 不会与真实模型 ref 冲突（ref 必含 '/'，'__unset__' 不含）。
 */
const RENAME_MODEL_UNSET = '__unset__'

/** Select 受控值：空串 → sentinel；否则原样 ref（不在列表时由 staleRef 项兜底显示）。 */
const selectedValue = computed(() => (renameModel.value === '' ? RENAME_MODEL_UNSET : renameModel.value))

/** 可选模型值集合（判断当前 ref 是否 stale）。 */
const availableValues = computed(() => new Set(modelGroups.value.flatMap((g) => g.models.map((m) => m.value))))

/** 当前 ref 不在可选列表时返回该 ref（渲染 disabled 兜底项），否则 null。 */
const staleRef = computed(() => {
  const ref = renameModel.value
  return ref !== '' && !availableValues.value.has(ref) ? ref : null
})

/**
 * 按 provider 分组的可选模型（只列已配凭证 provider 的模型——extension 的
 * resolveModel 对无凭证模型 hasConfiguredAuth 不通过，选了也不工作，不如不列）。
 * 数据源：settings store（runtime aggregateModels 常驻订阅，与
 * ModelSelectPopover 同源）；凭证过滤用 providers 的 apiKeySet。
 */
const settingsStore = getSettingsStore()

interface RenameModelOption {
  value: string
  label: string
}
interface RenameModelGroup {
  providerId: string
  providerName: string
  models: RenameModelOption[]
}

const modelGroups = computed<RenameModelGroup[]>(() => {
  const authedProviderIds = new Set(settingsStore.providers.value.filter((p) => p.apiKeySet).map((p) => p.id))
  const groups: RenameModelGroup[] = []
  const byProviderId = new Map<string, RenameModelGroup>()
  for (const m of settingsStore.models.value) {
    if (!authedProviderIds.has(m.providerId)) continue
    let group = byProviderId.get(m.providerId)
    if (!group) {
      group = { providerId: m.providerId, providerName: m.providerName, models: [] }
      byProviderId.set(m.providerId, group)
      groups.push(group)
    }
    group.models.push({ value: `${m.providerId}/${m.id}`, label: m.name || m.id })
  }
  return groups
})

onMounted(async () => {
  try {
    const res = await getAutoRenameEnabled()
    autoRenameEnabled.value = res.enabled
  } catch (e) {
    // best-effort：加载失败保持默认 true（开关仍可操作，保存时重新校验），不打扰用户
    console.warn('[SystemAutoRenameSection] failed to load auto-rename state:', e)
  }
  try {
    const res = await getRenameModel()
    renameModel.value = res.model
  } catch (e) {
    // best-effort：拉取失败保持未设置（''），不阻塞页面
    console.warn('[SystemAutoRenameSection] failed to load rename model:', e)
  }
})

async function onSaveAutoRename(enabled: boolean): Promise<void> {
  if (togglingAutoRename.value) return
  togglingAutoRename.value = true
  const prev = autoRenameEnabled.value
  autoRenameEnabled.value = enabled
  try {
    await setAutoRenameEnabled(enabled)
    toastInfo(t('settings.system.saved'))
  } catch (_e) {
    autoRenameEnabled.value = prev
    toastError(t('settings.system.saveFailed'))
  } finally {
    togglingAutoRename.value = false
  }
}

/** Select change：sentinel → 空串（extension 默认未设置语义）；乐观更新 + 失败回滚。 */
async function onRenameModelChange(value: unknown): Promise<void> {
  if (savingRenameModel.value) return
  const next = typeof value === 'string' && value !== RENAME_MODEL_UNSET ? value : ''
  savingRenameModel.value = true
  const prev = renameModel.value
  renameModel.value = next
  try {
    await setRenameModel(next)
    toastInfo(t('settings.system.saved'))
  } catch (_e) {
    renameModel.value = prev
    toastError(t('settings.system.saveFailed'))
  } finally {
    savingRenameModel.value = false
  }
}
</script>
