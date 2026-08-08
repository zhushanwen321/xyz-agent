/**
 * ProviderQuickSetup 表单逻辑（wave-quick-setup-c，script setup 行数上限拆分）。
 *
 * 认证方式状态机 + 保存构造（I6 authMethod）+ env 检测态派生 + footer hint。
 * 纯逻辑层（无模板）：组件 script 只留 props/emits/渲染数据。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { BuiltinProviderTemplate, SetProviderData } from '@xyz-agent/shared'

export type AuthMethod = 'plaintext' | 'env' | 'oauth' | 'ambient'

/** 「自定义变量名」Select sentinel value（F4 · §6.4：下拉含常见 env var + 自定义入口） */
export const CUSTOM_ENV_VALUE = '__custom__'

export interface UseQuickSetupForm {
  authMethod: Ref<AuthMethod>
  apiKeyInput: Ref<string>
  envVar: Ref<string>
  customEnvVar: Ref<string>
  showKey: Ref<boolean>
  envSupported: ComputedRef<boolean>
  resolvedEnvVar: ComputedRef<string>
  authOptions: ComputedRef<Array<{ id: AuthMethod; titleKey: string; rec?: boolean; available: boolean }>>
  saveDisabled: ComputedRef<boolean>
  footerHintKey: ComputedRef<string>
  envDetected: ComputedRef<boolean | undefined>
  onSave: () => void
}

/**
 * 初始化表单状态。t 是 i18n 翻译函数（key 拼接在组件层做，这里只产 key）。
 * @param template template ref（props.template）
 * @param envCheck env 检测结果（props.envCheck）
 * @param oauthAuthorized OAuth 已授权（props.oauthAuthorized）
 * @param emitSave emit('save') 包装
 */
export function useQuickSetupForm(
  template: Ref<BuiltinProviderTemplate>,
  envCheck: Ref<Record<string, boolean> | undefined>,
  oauthAuthorized: Ref<boolean | undefined>,
  emitSave: (payload: { providerId: string; data: SetProviderData }) => void,
): UseQuickSetupForm {
  /** 当前认证方式 */
  const authMethod = ref<AuthMethod>('plaintext')
  /** 明文 API Key 输入 */
  const apiKeyInput = ref('')
  /** 选中的环境变量名（默认预填 template.envVars[0]，或 CUSTOM_ENV_VALUE 走自定义输入） */
  const envVar = ref('')
  /** 自定义环境变量名输入 */
  const customEnvVar = ref('')
  /** 是否明文显示 API Key */
  const showKey = ref(false)

  /** template 是否支持环境变量方式（envVars 非空） */
  const envSupported = computed(() => template.value.envVars.length > 0)

  /** 当前生效的 env var 名（自定义 sentinel 时取输入框值） */
  const resolvedEnvVar = computed(() =>
    envVar.value === CUSTOM_ENV_VALUE ? customEnvVar.value.trim() : envVar.value,
  )

  /** 认证 radio 选项（按 authMode 条件渲染，demo auth-options） */
  const authOptions = computed<Array<{ id: AuthMethod; titleKey: string; rec?: boolean; available: boolean }>>(() => {
    const mode = template.value.authMode
    const options: Array<{ id: AuthMethod; titleKey: string; rec?: boolean; available: boolean }> = []
    if (mode === 'api_key' || mode === 'both') {
      options.push({ id: 'plaintext', titleKey: 'authOptionPlaintext', available: true })
      options.push({ id: 'env', titleKey: 'authOptionEnv', rec: true, available: envSupported.value })
    }
    if (mode === 'oauth' || mode === 'both') {
      options.push({ id: 'oauth', titleKey: 'authOptionOauth', available: true })
    }
    if (mode === 'ambient') {
      options.push({ id: 'ambient', titleKey: 'authOptionAmbient', available: true })
    }
    return options
  })

  /** template 切换时重置表单（默认选 env（推荐）或 plaintext） */
  watch(template, (tpl) => {
    envVar.value = tpl.envVars[0] ?? ''
    customEnvVar.value = ''
    apiKeyInput.value = ''
    showKey.value = false
    const mode = tpl.authMode
    authMethod.value =
      (mode === 'api_key' || mode === 'both') && tpl.envVars.length > 0 ? 'env' : mode === 'oauth' ? 'oauth' : mode === 'ambient' ? 'ambient' : 'plaintext'
  }, { immediate: true })

  /** 保存禁用：明文模式空 key 禁用；OAuth 未授权且非已有授权时禁用 */
  const saveDisabled = computed(() => {
    if (authMethod.value === 'plaintext' && !apiKeyInput.value.trim()) return true
    if (authMethod.value === 'oauth' && !oauthAuthorized.value) return true
    return false
  })

  /** footer hint key（spec §4.1 规格文案列，有意偏离 demo 的明文/env 态） */
  const footerHintKey = computed(() => {
    return {
      plaintext: 'footerHintPlaintext',
      env: 'footerHintEnv',
      oauth: 'footerHintOauth',
      ambient: 'footerHintAmbient',
    }[authMethod.value]
  })

  /** env 检测态：当前 env var 是否已设置（envCheck 未拉取时不显示） */
  const envDetected = computed<boolean | undefined>(() => {
    if (!envCheck.value) return undefined
    const name = resolvedEnvVar.value
    return name ? envCheck.value[name] : undefined
  })

  /** 保存：构造 SetProviderData（I6 填 authMethod；oauth 不塞 apiKey——凭据在 auth.json） */
  function onSave(): void {
    const data: SetProviderData = {
      name: template.value.name,
      ...(template.value.api ? { api: template.value.api } : {}),
      ...(template.value.baseUrl ? { baseUrl: template.value.baseUrl } : {}),
    }
    if (authMethod.value === 'plaintext') {
      data.apiKey = apiKeyInput.value
      data.authMethod = 'api_key'
    } else if (authMethod.value === 'env') {
      data.apiKey = resolvedEnvVar.value ? `$${resolvedEnvVar.value}` : ''
      data.authMethod = 'env_var'
    } else if (authMethod.value === 'oauth') {
      data.authMethod = 'oauth'
    }
    emitSave({ providerId: template.value.id, data })
  }

  return {
    authMethod, apiKeyInput, envVar, customEnvVar, showKey,
    envSupported, resolvedEnvVar, authOptions, saveDisabled, footerHintKey, envDetected,
    onSave,
  }
}
