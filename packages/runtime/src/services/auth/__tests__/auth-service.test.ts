/**
 * AuthService 单测（mock flow/storage/broadcast）。
 *
 * 覆盖：login 无 oauthConfig → started:false / 已有 flow 幂等拒绝 / 正常启动 →
 * 事件序列（deviceCode → success）+ clearApiKey（I9 both 清理②）/ 失败 → auth.error /
 * cancel（无 flow 幂等 + 有 flow abort 且不发 error）/ hasOAuth 委托。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import type { BuiltinOAuthConfig } from '@xyz-agent/shared'
import { AuthService, type AuthServiceDeps } from '../auth-service.js'
import type { OAuthCredential } from '../auth-storage.js'
import type { DeviceCodeInfo } from '../oauth-flow.js'

// mock oauth-flow：让测试聚焦 AuthService 编排，不触发真实网络
vi.mock('../oauth-flow.js', () => ({
  runOAuthLogin: vi.fn(),
}))

import { runOAuthLogin } from '../oauth-flow.js'

const OAUTH_CONFIG: BuiltinOAuthConfig = {
  clientId: 'client-x',
  flow: 'device',
  endpoints: { token: 'https://x/token', deviceCode: 'https://x/device' },
  scopes: [],
}

function makeDeps(overrides?: Partial<AuthServiceDeps>): AuthServiceDeps & { events: ServerMessage[] } {
  const events: ServerMessage[] = []
  const authStorage: Pick<AuthServiceDeps['authStorage'], 'get' | 'getAll' | 'set' | 'remove' | 'hasOAuth'> = {
    get: vi.fn(async () => undefined),
    getAll: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    hasOAuth: vi.fn(async () => false),
  }
  return {
    authStorage,
    getOAuthConfig: vi.fn((id: string) => (id === 'xai' ? OAUTH_CONFIG : undefined)),
    broadcast: vi.fn((msg: ServerMessage) => events.push(msg)),
    nextPushId: vi.fn(() => 'evt-1'),
    clearApiKey: vi.fn(),
    events,
    ...overrides,
  }
}

function oauthCred(access = 'at'): OAuthCredential {
  return { type: 'oauth', access, refresh: 'rt', expires: Date.now() + 3_600_000 }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runOAuthLogin).mockReset()
})

describe('AuthService.login', () => {
  it('provider 无 oauthConfig → started:false + error，不启动 flow', () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    const result = svc.login('openai')
    expect(result).toEqual({ started: false, error: 'provider "openai" 不支持 OAuth' })
    expect(runOAuthLogin).not.toHaveBeenCalled()
  })

  it('正常启动 → started:true，flow 成功推 deviceCode + success，且清 models.json apiKey（I9）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockImplementation(async (_id, _cfg, hooks) => {
      hooks.onDeviceCode?.({ userCode: 'ABCD-EFGH', verificationUri: 'https://x/activate' } as DeviceCodeInfo)
      return oauthCred()
    })

    const result = svc.login('xai')
    expect(result).toEqual({ started: true })

    // 等异步 flow 完成
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(true)
    })

    expect(runOAuthLogin).toHaveBeenCalledWith('xai', OAUTH_CONFIG, expect.any(Object), expect.any(AbortSignal))
    expect(deps.authStorage.set).toHaveBeenCalledWith('xai', expect.objectContaining({ type: 'oauth', access: 'at' }))
    // I9 both 清理②：OAuth 成功 → 清 models.json apiKey
    expect(deps.clearApiKey).toHaveBeenCalledWith('xai')
    // 事件顺序：deviceCode → success
    const types = deps.events.map((e) => e.type)
    expect(types.indexOf('auth.deviceCode')).toBeLessThan(types.indexOf('auth.success'))
    expect(deps.events.find((e) => e.type === 'auth.deviceCode')?.payload).toMatchObject({
      providerId: 'xai', userCode: 'ABCD-EFGH',
    })
    expect(deps.events.find((e) => e.type === 'auth.success')?.payload).toEqual({ providerId: 'xai' })
  })

  it('已有进行中 flow → started:false + error（幂等拒绝）', () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    // flow 永不完成：挂起，模拟进行中
    vi.mocked(runOAuthLogin).mockImplementation(() => new Promise(() => {}))
    expect(svc.login('xai')).toEqual({ started: true })
    expect(svc.login('xai').started).toBe(false)
  })

  it('flow 失败 → 推 auth.error，不写 auth.json，不清 apiKey', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockRejectedValue(new Error('OAuth device code expired'))

    svc.login('xai')
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.error')).toBe(true)
    })

    expect(deps.events.find((e) => e.type === 'auth.error')?.payload).toEqual({
      providerId: 'xai', message: 'OAuth device code expired',
    })
    expect(deps.authStorage.set).not.toHaveBeenCalled()
    expect(deps.clearApiKey).not.toHaveBeenCalled()
  })

  it('token 永不出现在事件 payload（成功/错误都不含 access/refresh）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(runOAuthLogin).mockImplementation(async () => oauthCred('SUPER-SECRET-TOKEN'))

    svc.login('xai')
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.success')).toBe(true)
    })
    const serialized = JSON.stringify(deps.events)
    expect(serialized).not.toContain('SUPER-SECRET-TOKEN')
  })
})

describe('AuthService.cancel', () => {
  it('无进行中 flow → cancelled:false（幂等）', () => {
    const svc = new AuthService(makeDeps())
    expect(svc.cancel('xai')).toEqual({ cancelled: false })
  })

  it('有进行中 flow → cancelled:true + abort 触发，且不发 auth.error（用户主动取消非错误）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    let signal: AbortSignal | undefined
    vi.mocked(runOAuthLogin).mockImplementation(async (_id, _cfg, _hooks, sig) => {
      signal = sig
      return new Promise<OAuthCredential>((_resolve, reject) => {
        sig?.addEventListener('abort', () => reject(new Error('Login cancelled')))
      })
    })

    svc.login('xai')
    await vi.waitFor(() => {
      expect(signal).toBeDefined()
    })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })

    // flow 因 abort 结束：没有 auth.error 事件
    await vi.waitFor(() => {
      expect(deps.events.some((e) => e.type === 'auth.error')).toBe(false)
    })
    // 结束后 activeFlows 已清空：再次 cancel 幂等返回 false
    await vi.waitFor(() => {
      expect(svc.cancel('xai')).toEqual({ cancelled: false })
    })
  })

  it('cancel 后立即重新 login 不被拒（activeFlows 同步清理，exec-review must-fix #1 回归）', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    let signal: AbortSignal | undefined
    vi.mocked(runOAuthLogin).mockImplementation(async (_id, _cfg, _hooks, sig) => {
      signal = sig
      return new Promise<OAuthCredential>(() => {
        sig?.addEventListener('abort', () => {
          // 挂起模拟：abort 后 runFlow 的 finally 尚未执行（真实场景 abort 沿异步链传播有延迟）
        })
      })
    })

    svc.login('xai')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
    // 立即重新 login：必须成功（cancel 已同步清理 activeFlows）
    expect(svc.login('xai')).toEqual({ started: true })
    expect(svc.cancel('xai')).toEqual({ cancelled: true })
  })
})

describe('AuthService.hasOAuth', () => {
  it('委托 authStorage.hasOAuth', async () => {
    const deps = makeDeps()
    const svc = new AuthService(deps)
    vi.mocked(deps.authStorage.hasOAuth as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    expect(await svc.hasOAuth('anthropic')).toBe(true)
    expect(deps.authStorage.hasOAuth).toHaveBeenCalledWith('anthropic')
  })
})
