/**
 * ui 包 settings 表单组件 barrel（W3 · p3-strangler-domains::settings）。
 *
 * 从 renderer components/settings/ 迁入 11 个表单组件 + apply-system-to-dom 纯函数 + 注入 key。
 * 消费方（renderer 壳 ProviderPage 等）经 '@xyz-agent/ui/features/settings' 子路径 import 组件，
 * 并 provide 三条 InjectionKey（toast/quota/config），ui 组件 inject 取用，零 renderer import。
 *
 * 详细迁移决策见 wave w3-ui-settings-components 的 clarify/design-review。
 */
export { default as CompatField } from './CompatField.vue'
export { default as CompatEditor } from './CompatEditor.vue'
export { default as CodingPlanSection } from './CodingPlanSection.vue'
export { default as GroupCard } from './GroupCard.vue'
export { default as LoadPaths } from './LoadPaths.vue'
export { default as ModelListSection } from './ModelListSection.vue'
export { default as PresetModeSection } from './PresetModeSection.vue'
export { default as ProviderEditModal } from './ProviderEditModal.vue'
export { default as ProviderImportMenu } from './ProviderImportMenu.vue'
export { default as ProviderImportPreviewDialog } from './ProviderImportPreviewDialog.vue'
export { default as SoundPreviewButton } from './SoundPreviewButton.vue'
export { default as SourceImportSection } from './SourceImportSection.vue'

export {
  applySystemToDom,
  resolveTheme,
  type ApplySystemToDomDeps,
} from './apply-system-to-dom'

export {
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
  SETTINGS_CONFIG_API_KEY,
  useSettingsToast,
  useQuotaConfigureFactory,
  useSettingsConfigApi,
  type SettingsToast,
  type QuotaConfigureState,
  type UseQuotaConfigureFactory,
  type SettingsConfigApi,
  type QuotaTestStatus,
} from './injection-keys'
