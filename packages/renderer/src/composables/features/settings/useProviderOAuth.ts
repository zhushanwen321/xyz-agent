/**
 * Provider OAuth 授权状态机（wave-quick-setup-c T3）+ QuickSetup env 检测桥接。
 *
 * 驱动 OAuthDialog（ui 包四态组件）+ config api 层：
 * - login(providerId)：打开 Dialog（pending）→ config.oauthLogin 启动 flow
 * - auth.* 事件订阅：deviceCode → Dialog device 态；authUrl → Dialog callback 态；
 *   success → 关 Dialog + authorized 回写 + 回调 onAuthorized；error → Dialog error 态
 * - cancel：config.oauthCancel + 关 Dialog
 * - checkEnv(tpl)：template 变化时调 checkEnvVars 供 QuickSetup 检测态
 *
 * 订阅先行（对齐 runtime broadcast 时序教训）：login 前 onMounted 建订阅，事件不丢。
 * token 永不出现在状态（auth.* payload 无 token，脱敏红线由 runtime 保证）。
 */
import { onMounted, onScopeDispose, ref } from 'vue'
import { config } from '@/api'

// OAuthDialog 的 .vue 导出类型在 plain tsc 下不可用（ui 包 shim 不导出命名类型），本地定义结构兼容
export interface ProviderOAuthDeviceInfo {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn?: number
}

export interface ProviderOAuthAuthUrlInfo {
  url: string
  callbackPort?: number
}

export type ProviderOAuthStatus = 'idle' | 'pending' | 'success' | 'error'

export interface ProviderOAuthState {
  open: boolean
  status: ProviderOAuthStatus
  deviceInfo: ProviderOAuthDeviceInfo | null
  authUrl: ProviderOAuthAuthUrlInfo | null
  errorMessage: string
}

export function useProviderOAuth(onAuthorized: (providerId: string) => void) {
  /** env 检测结果（template 变化时调 checkEnvVars） */
  const envCheck = ref<Record<string, boolean> | undefined>(undefined)
  const state = ref<ProviderOAuthState>({
    open: false,
    status: 'idle',
    deviceInfo: null,
    authUrl: null,
    errorMessage: '',
  })

  /** 已授权 provider 集合（auth.success 后回写，QuickSetup 显示「已授权」态） */
  const authorized = ref<Set<string>>(new Set())

  let activeProviderId = ''
  const disposers: Array<() => void> = []

  onMounted(() => {
    // 订阅先行：Dialog 打开前事件已挂（broadcast 先于订阅会丢消息）
    disposers.push(
      config.onAuthDeviceCode((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = {
          open: true,
          status: 'pending',
          deviceInfo: {
            userCode: payload.userCode,
            verificationUri: payload.verificationUri,
            verificationUriComplete: payload.verificationUriComplete,
            expiresIn: payload.expiresIn,
          },
          authUrl: null,
          errorMessage: '',
        }
      }),
      config.onAuthAuthUrl((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = {
          open: true,
          status: 'pending',
          deviceInfo: null,
          authUrl: { url: payload.url, callbackPort: payload.callbackPort },
          errorMessage: '',
        }
      }),
      config.onAuthSuccess((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = { ...state.value, open: false, status: 'success' }
        authorized.value = new Set(authorized.value).add(payload.providerId)
        onAuthorized(payload.providerId)
      }),
      config.onAuthError((payload) => {
        if (payload.providerId !== activeProviderId) return
        state.value = { ...state.value, status: 'error', errorMessage: payload.message }
      }),
    )
  })

  onScopeDispose(() => {
    for (const dispose of disposers) dispose()
  })

  /** 启动 OAuth flow（QuickSetup 的 oauth-login 事件触发） */
  async function login(providerId: string): Promise<void> {
    activeProviderId = providerId
    state.value = { open: true, status: 'pending', deviceInfo: null, authUrl: null, errorMessage: '' }
    const result = await config.oauthLogin(providerId)
    if (!result.started) {
      state.value = { ...state.value, status: 'error', errorMessage: result.error ?? 'OAuth 启动失败' }
    }
  }

  /** 用户取消 → 关 Dialog + 通知 runtime 停 flow（幂等） */
  async function cancel(): Promise<void> {
    state.value = { ...state.value, open: false }
    if (activeProviderId) {
      await config.oauthCancel(activeProviderId)
    }
  }

  /** 重试（error 态）→ 重新启动 flow */
  async function retry(): Promise<void> {
    if (activeProviderId) await login(activeProviderId)
  }

  /** env 检测（QuickSetup 打开时调用；失败不显示检测态不阻断配置） */
  async function checkEnv(tpl: { envVars: string[] }): Promise<void> {
    if (tpl.envVars.length === 0) {
      envCheck.value = undefined
      return
    }
    try {
      envCheck.value = await config.checkEnvVars(tpl.envVars)
    } catch {
      envCheck.value = undefined
    }
  }

  return { state, authorized, envCheck, login, cancel, retry, checkEnv }
}
