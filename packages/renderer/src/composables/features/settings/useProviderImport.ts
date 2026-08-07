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
 *     → 失败（envelope error 或 transport reject）：toast 报错，回 'idle'
 *   onImportConfirm(selectedIds)
 *     → config.applyImportProviders(importId, selectedIds)
 *     → 成功：toast 导入/跳过/失败统计 + key 缺失提示，复位 idle
 *     → 失败（envelope error 或 transport reject）：保持 'previewing' 允许重试
 *
 * 注意：config.previewImportProviders/applyImportProviders 在 transport 层（请求超时、
 * WebSocket 断连 pending.rejectAll、传输发送失败）会 reject Promise，故两个 async 函数
 * 都用 try/catch 包裹 await，避免 importState 卡死在 'loading-preview'/'applying'。
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

  /** 选中源 agent → 拉 preview（transport reject 时回 idle + toast） */
  async function onImportSelect(source: ProviderSource): Promise<void> {
    importSource.value = source
    importState.value = 'loading-preview'
    importError.value = ''
    try {
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
    } catch (e) {
      // transport 层 reject（请求超时 / WebSocket 断连 pending.rejectAll / 传输发送失败）
      const msg = e instanceof Error ? e.message : String(e)
      importError.value = msg
      importState.value = 'idle'
      toastError(msg)
    }
  }

  /** 确认导入 → apply（失败保持对话框开允许重试） */
  async function onImportConfirm(selectedIds: string[]): Promise<void> {
    if (!importId.value) return
    importState.value = 'applying'
    importError.value = ''
    try {
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
      // wave 4 import-credential-types：分类提示选中 provider 的凭据形态
      // - missing：apiKey 空，需手填；env：$ENV 引用，需确保环境变量已设；oauth：Phase 2 跳过
      const selectedProviders = importPreview.value?.providers.filter((p) => selectedIds.includes(p.id)) ?? []
      const missingCount = selectedProviders.filter((p) => p.credentialType === 'missing').length
      const envCount = selectedProviders.filter((p) => p.credentialType === 'env').length
      const oauthCount = selectedProviders.filter((p) => p.credentialType === 'oauth').length
      if (missingCount > 0) {
        toastInfo(t('settings.provider.importToast.partialKeyMissing'))
      }
      if (envCount > 0) {
        toastInfo(t('settings.provider.importToast.envVarNeeded', { count: envCount }))
      }
      if (oauthCount > 0) {
        toastInfo(t('settings.provider.importToast.oauthSkipped', { count: oauthCount }))
      }
      resetImportState()
    } catch (e) {
      // transport 层 reject（请求超时 / WebSocket 断连 pending.rejectAll / 传输发送失败）：
      // 回 previewing 保留对话框允许重试 + toast
      const msg = e instanceof Error ? e.message : String(e)
      importError.value = msg
      importState.value = 'previewing'
      toastError(msg)
    }
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
