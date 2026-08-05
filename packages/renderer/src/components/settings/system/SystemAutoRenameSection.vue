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
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Switch } from '@/components/ui/switch'
import { GroupCard } from '@xyz-agent/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import type { SystemSettings } from '@xyz-agent/core'
import { getAutoRenameEnabled, setAutoRenameEnabled } from '@/api/domains/settings'
import { useToast } from '@/composables/useToast'

// 统一 Section 契约（未使用 system：autoRename 走独立 API；不 emit：变更经 setAutoRenameEnabled 持久化）
defineProps<{
  system: SystemSettings
}>()

defineEmits<{
  update: [patch: Partial<SystemSettings>]
}>()

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()

// ── 会话自动重命名 ──
const autoRenameEnabled = ref(true)
const togglingAutoRename = ref(false)

onMounted(async () => {
  try {
    const res = await getAutoRenameEnabled()
    autoRenameEnabled.value = res.enabled
  } catch (e) {
    // best-effort：加载失败保持默认 true（开关仍可操作，保存时重新校验），不打扰用户
    console.warn('[SystemPage] failed to load auto-rename state:', e)
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
</script>

