/**
 * useProviderImport —— 从其他 agent 迁移 Provider 配置的业务编排（W2 · cw-2026-07-26-migration-other-agents）。
 *
 * 承载有限状态机 idle → loading-preview → previewing → applying，封装 preview/apply RPC
 * 与 toast 结果反馈，让 ProviderPage.vue 仅持有展示态。
 *
 * 数据流：
 *   onImportSelect(source)
 *     → config.previewImportProviders(source)
 *     → 成功：存 importId + importPreview，转入 'previewing'
 *     → 失败：toast 报错，回 'idle'
 *   onImportConfirm(selectedIds)
 *     → config.applyImportProviders(importId, selectedIds)
 *     → 成功：toast 导入/跳过/失败统计 + key 缺失提示，复位 idle
 *     → 失败：保持 'previewing' 允许重试
 *
 * 依赖方向：@xyz-agent/shared 类型 + @/api(config) + useToast + i18n。
 */
import { ref } from 'vue'
import { config } from '@/api'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import type { ProviderSource, ProviderImportPreview } from '@xyz-agent/shared'

const t = i18n.global.t

/** 导入流程状态 */
export type ImportState = 'idle' | 'loading-preview' | 'previewing' | 'applying'

export function useProviderImport() {
  const { info: toastInfo, error: toastError } = useToast()

  const importState = ref<ImportState>('idle')
  const importSource = ref<ProviderSource | null>(null)
  const importId = ref<string | null>(null)
  const importPreview = ref<ProviderImportPreview | null>(null)
  const importError = ref('')

  /** 选中源 agent → 拉 preview */
  async function onImportSelect(source: ProviderSource): Promise<void> {
    importSource.value = source
    importState.value = 'loading-preview'
    importError.value = ''
    const result = await config.previewImportProviders(source)
    if ('error' in result) {
      importError.value = result.error.message
      importState.value = 'idle'
      toastError(result.error.message)
      return
    }
    importId.value = result.importId
    importPreview.value = result.preview
    importError.value = ''
    importState.value = 'previewing'
  }

  /** 确认导入 → apply（失败保持对话框开允许重试） */
  async function onImportConfirm(selectedIds: string[]): Promise<void> {
    if (!importId.value) return
    importState.value = 'applying'
    importError.value = ''
    const result = await config.applyImportProviders(importId.value, selectedIds)
    if ('error' in result) {
      importError.value = result.error.message
      importState.value = 'previewing'
      return
    }
    const { imported, failedCount } = result.result
    const ok = imported.filter((i) => i.status === 'imported').length
    toastInfo(t('settings.provider.importToast.success', { count: ok }))
    if (failedCount > 0) {
      toastError(t('settings.provider.importToast.failed', { count: failedCount }))
    }
    // 若有 key 未提取的导入项，额外提示需手动补
    const keyMissing = importPreview.value?.providers.some(
      (p) => selectedIds.includes(p.id) && !p.apiKeyExtracted,
    )
    if (keyMissing) {
      toastInfo(t('settings.provider.importToast.partialKeyMissing'))
    }
    resetImportState()
  }

  /** 预览弹窗开关受控：关闭（非 applying）时复位导入态 */
  function onPreviewDialogToggle(open: boolean): void {
    if (!open && importState.value !== 'applying') {
      resetImportState()
    }
  }

  function resetImportState(): void {
    importState.value = 'idle'
    importSource.value = null
    importId.value = null
    importPreview.value = null
    importError.value = ''
  }

  return {
    importState,
    importSource,
    importId,
    importPreview,
    importError,
    onImportSelect,
    onImportConfirm,
    onPreviewDialogToggle,
    resetImportState,
  }
}
