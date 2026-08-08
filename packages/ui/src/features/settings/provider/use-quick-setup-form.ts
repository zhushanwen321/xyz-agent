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

/** 已存配置的认证方式（ProviderInfo.authMethod；QuickSetup 重开时恢复上次方式） */
export type ExistingAuthMethod = 'api_key' | 'oauth' | 'env_var' | 'ambient'

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
  existingAuthMethod?: Ref<ExistingAuthMethod | undefined>,
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

  /** template 切换时重置表单：已存配置标注过 authMethod 则恢复上次方式（MF-1：both provider 已 OAuth 授权后重开，不默认 env 盲保存清凭据），否则默认 env（推荐）或 plaintext */
  watch(template, (tpl) => {
    envVar.value = tpl.envVars[0] ?? ''
    customEnvVar.value = ''
    apiKeyInput.value = ''
    showKey.value = false
    authMethod.value = resolveInitialAuthMethod(tpl)
  }, { immediate: true })

  /** 初始认证方式：existingAuthMethod 优先（恢复上次选择），不适用时回退默认 */
  function resolveInitialAuthMethod(tpl: BuiltinProviderTemplate): AuthMethod {
    const existing = existingAuthMethod?.value
    const mode = tpl.authMode
    if (existing === 'oauth' && (mode === 'oauth' || mode === 'both')) return 'oauth'
    if (existing === 'env_var' && (mode === 'api_key' || mode === 'both') && tpl.envVars.length > 0) return 'env'
    if (existing === 'api_key' && (mode === 'api_key' || mode === 'both')) return 'plaintext'
    if (existing === 'ambient' && mode === 'ambient') return 'ambient'
    if ((mode === 'api_key' || mode === 'both') && tpl.envVars.length > 0) return 'env'
    if (mode === 'oauth') return 'oauth'
    if (mode === 'ambient') return 'ambient'
    return 'plaintext'
  }

  /** 保存禁用：明文模式空 key 禁用；env 模式空变量名禁用（MF-1：空自定义变量不产生无意义 env_var 配置）；OAuth 未授权且非已有授权时禁用 */
  const saveDisabled = computed(() => {
    if (authMethod.value === 'plaintext' && !apiKeyInput.value.trim()) return true
    if (authMethod.value === 'env' && !resolvedEnvVar.value) return true
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

  /** env 检测态：当前 env var 是否已设置。envCheck 未拉取时不显示（undefined）；
   *  自定义变量名不在 envCheck 结果里 → 视为未设置（S-C：demo 显示 ⚠「未设置」，不隐藏检测态） */
  const envDetected = computed<boolean | undefined>(() => {
    if (!envCheck.value) return undefined
    const name = resolvedEnvVar.value
    return name ? (envCheck.value[name] ?? false) : undefined
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
      // MF-1：空自定义变量不上送 apiKey——apiKey:'' 会触发 config-service I9 清理①
      // （`!== undefined` 成立）静默删除 auth.json OAuth 凭据。空变量名已被 saveDisabled 挡住，
      // 此处再守卫一层（防未来调用方绕过 disabled 直调 onSave）。
      if (resolvedEnvVar.value) {
        data.apiKey = `$${resolvedEnvVar.value}`
      }
      data.authMethod = 'env_var'
    } else if (authMethod.value === 'oauth') {
      data.authMethod = 'oauth'
    } else if (authMethod.value === 'ambient') {
      data.authMethod = 'ambient'
    }
    emitSave({ providerId: template.value.id, data })
  }

  return {
    authMethod, apiKeyInput, envVar, customEnvVar, showKey,
    envSupported, resolvedEnvVar, authOptions, saveDisabled, footerHintKey, envDetected,
    onSave,
  }
}
