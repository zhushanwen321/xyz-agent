/**
 * OAuth flow 编排单测（mock fetch，覆盖各 provider 协议分支）。
 *
 * 覆盖：xai 标准 device（缺 expires_in 默认 3600s + 5min skew）/ kimi 无 skew /
 * github-copilot 两段式（epoch 秒 expires）/ openai-codex 非标 device（device_auth_id
 * → authorization_code 二次 exchange）/ anthropic callback（PKCE + state）/ openrouter
 * callback（无 clientId + 永久 key）/ 事件钩子 / abort 取消。
 *
 * callback 分支用真实 http server（端口 0 动态），只 mock token 端点 fetch。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BuiltinOAuthConfig } from '@xyz-agent/shared'
import { runOAuthLogin, type OAuthFlowHooks } from '../oauth-flow.js'

// 每个测试开头重设（模块加载与测试执行间隔在设备/回调等待后可达数秒，断言 expires 需相对测试起点）
let now = Date.now()

// ── 各 provider 的 oauthConfig（形状对齐 builtin-providers.json）──

const XAI_CONFIG: BuiltinOAuthConfig = {
  clientId: 'xai-client',
  flow: 'device',
  endpoints: {
    token: 'https://auth.x.ai/oauth2/token',
    deviceCode: 'https://auth.x.ai/oauth2/device/code',
  },
  scopes: ['openid', 'profile', 'offline_access'],
}

const KIMI_CONFIG: BuiltinOAuthConfig = {
  clientId: 'kimi-client',
  flow: 'device',
  endpoints: {
    token: 'https://auth.kimi.com/api/oauth/token',
    deviceCode: 'https://auth.kimi.com/api/oauth/device_authorization',
  },
  scopes: [],
}

const COPILOT_CONFIG: BuiltinOAuthConfig = {
  clientId: 'Iv1.copilot',
  flow: 'device',
  endpoints: {
    token: 'https://github.com/login/oauth/access_token',
    deviceCode: 'https://github.com/login/device/code',
  },
  scopes: ['read:user'],
}

const OPENAI_CODEX_CONFIG: BuiltinOAuthConfig = {
  clientId: 'app_codex',
  flow: 'both',
  endpoints: {
    token: 'https://auth.openai.com/oauth/token',
    deviceCode: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    verify: 'https://auth.openai.com/codex/device',
  },
  scopes: ['openid', 'offline_access'],
}

const ANTHROPIC_CONFIG: BuiltinOAuthConfig = {
  clientId: 'anthropic-client',
  flow: 'callback',
  endpoints: {
    authorize: 'https://claude.ai/oauth/authorize',
    token: 'https://platform.claude.com/v1/oauth/token',
  },
  scopes: ['org:create_api_key', 'user:profile'],
}

const OPENROUTER_CONFIG: BuiltinOAuthConfig = {
  clientId: '',
  noClientId: true,
  flow: 'callback',
  endpoints: {
    authorize: 'https://openrouter.ai/auth',
    token: 'https://openrouter.ai/api/v1/auth/keys',
  },
  scopes: [],
}

// ── fetch mock 工具 ─────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

let fetchCalls: FetchCall[] = []

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () => jsonResponse({})

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  fetchImpl = impl
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => fetchImpl(url, init)))
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  const raw = call.init?.body
  if (raw instanceof URLSearchParams) return Object.fromEntries(raw)
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>
  return {}
}

function bodyTextOf(call: FetchCall): string {
  const raw = call.init?.body
  return raw instanceof URLSearchParams ? raw.toString() : String(raw ?? '')
}

beforeEach(() => {
  now = Date.now()
  fetchCalls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runOAuthLogin — 标准 device flow', () => {
  it('xai：device 起始 → 轮询 pending → token complete；expires 含 5min skew + 缺 expires_in 默认 3600s', async () => {
    let polled = 0
    mockFetch(async (url, init) => {
      const body = bodyOf({ url, init })
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        // xai 特判：请求体带 referrer:"pi"
        expect(body.referrer).toBe('pi')
        expect(body.client_id).toBe('xai-client')
        return jsonResponse({
          device_code: 'dc-1', user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate', interval: 1, expires_in: 1800,
        })
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        if (polled++ === 0) {
          expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
          expect(body.device_code).toBe('dc-1')
          return jsonResponse({ error: 'authorization_pending' }, 400)
        }
        // 无 expires_in：走 defaultExpiresIn 3600s
        return jsonResponse({ access_token: 'at-xai', refresh_token: 'rt-xai' })
      }
      return jsonResponse({}, 404)
    })

    const hooks: OAuthFlowHooks = { onDeviceCode: vi.fn() }
    const flow = runOAuthLogin('xai', XAI_CONFIG, hooks, new AbortController().signal)

    // 首次轮询需要 advance：waitBeforeFirstPoll 等一个 interval。测试里让第一次 fetch 直接返回 pending
    const credential = await flow

    expect(credential.type).toBe('oauth')
    expect(credential.access).toBe('at-xai')
    expect(credential.refresh).toBe('rt-xai')
    // expires = 实际运行 now + 3600s - 5min skew ≈ now + 3300s（容差覆盖 waitBeforeFirstPoll）
    expect(Math.abs(credential.expires - (now + 3_300 * 1_000))).toBeLessThan(5_000)
    expect(hooks.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.x.ai/activate',
      interval: 1,
    }))
  })

  it('kimi：无 skew（expires = now + expires_in*1000）', async () => {
    mockFetch(async (url, init) => {
      const body = bodyOf({ url, init })
      if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
        return jsonResponse({
          device_code: 'dc-k', user_code: 'KIMI-CODE',
          verification_uri: 'https://auth.kimi.com/activate',
          verification_uri_complete: 'https://auth.kimi.com/activate?code=KIMI-CODE',
          interval: 1, expires_in: 900,
        })
      }
      if (url === 'https://auth.kimi.com/api/oauth/token') {
        return jsonResponse({ access_token: 'at-kimi', refresh_token: 'rt-kimi', expires_in: 120 })
      }
      return jsonResponse({}, 404)
    })

    const hooks: OAuthFlowHooks = { onDeviceCode: vi.fn() }
    const credential = await runOAuthLogin('kimi-coding', KIMI_CONFIG, hooks, new AbortController().signal)

    expect(credential.access).toBe('at-kimi')
    // 无 skew：实际运行 now + 120s（容差覆盖 waitBeforeFirstPoll）
    expect(Math.abs(credential.expires - (now + 120 * 1_000))).toBeLessThan(5_000)
    // verificationUriComplete 优先于 verificationUri
    expect(hooks.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      verificationUri: 'https://auth.kimi.com/activate?code=KIMI-CODE',
    }))
  })

  it('slow_down → interval 递增后继续轮询成功', async () => {
    let polled = 0
    mockFetch(async (url, init) => {
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return jsonResponse({
          device_code: 'dc-1', user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate', interval: 1, expires_in: 1800,
        })
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        if (polled++ === 0) return jsonResponse({ error: 'slow_down', interval: 1 }, 400)
        return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      }
      return jsonResponse({}, 404)
    })
    const credential = await runOAuthLogin('xai', XAI_CONFIG, {}, new AbortController().signal)
    expect(credential.access).toBe('at')
  })

  it('expired_token → flow 失败并带可读错误', async () => {
    mockFetch(async (url) => {
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return jsonResponse({
          device_code: 'dc-1', user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate', interval: 1, expires_in: 1800,
        })
      }
      return jsonResponse({ error: 'expired_token' }, 400)
    })
    await expect(runOAuthLogin('xai', XAI_CONFIG, {}, new AbortController().signal))
      .rejects.toThrow('OAuth device code expired')
  })
})

describe('runOAuthLogin — github-copilot 两段式', () => {
  it('第一段换 GitHub token → 第二段换 Copilot token（expires_at epoch 秒）', async () => {
    mockFetch(async (url, init) => {
      const body = bodyOf({ url, init })
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url === 'https://github.com/login/device/code') {
        expect(headers['User-Agent']).toBe('GitHubCopilotChat/0.35.0')
        expect(body.client_id).toBe('Iv1.copilot')
        expect(body.scope).toBe('read:user')
        return jsonResponse({
          device_code: 'dc-gh', user_code: 'GH-CODE',
          verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900,
        })
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        expect(headers['User-Agent']).toBe('GitHubCopilotChat/0.35.0')
        expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
        return jsonResponse({ access_token: 'github-token' })
      }
      if (url === 'https://api.github.com/copilot_internal/v2/token') {
        expect(headers.Authorization).toBe('Bearer github-token')
        // expires_at 是 epoch 秒
        return jsonResponse({ token: 'copilot-token', expires_at: Math.floor((now + 30 * 60 * 1_000) / 1_000) })
      }
      return jsonResponse({}, 404)
    })

    const hooks: OAuthFlowHooks = { onDeviceCode: vi.fn() }
    const credential = await runOAuthLogin('github-copilot', COPILOT_CONFIG, hooks, new AbortController().signal)

    expect(credential.access).toBe('copilot-token')
    // refresh 存 GitHub token（pi 侧 refresh 用它换新 copilot token）
    expect(credential.refresh).toBe('github-token')
    // expires = expires_at*1000 - 5min skew（容差覆盖轮询等待）
    expect(Math.abs(credential.expires - (now + 25 * 60 * 1_000))).toBeLessThan(5_000)
    expect(hooks.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'GH-CODE' }))
  })
})

describe('runOAuthLogin — openai-codex 非标 device 协议', () => {
  it('device_auth_id → 轮询返回 authorization_code → 二次 exchange 正式 token', async () => {
    let polled = 0
    mockFetch(async (url, init) => {
      const body = bodyOf({ url, init })
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        // 起始是 JSON POST
        expect(init?.method).toBe('POST')
        expect(body.client_id).toBe('app_codex')
        return jsonResponse({ device_auth_id: 'da-1', user_code: 'CODEX-CODE', interval: '1' })
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        if (polled++ === 0) {
          // 403 = 未完成授权（非标语义：pending）
          return jsonResponse({ error: { code: 'deviceauth_authorization_pending' } }, 403)
        }
        // 完成：返回 authorization_code + code_verifier（非直接 token）
        expect(body.device_auth_id).toBe('da-1')
        expect(body.user_code).toBe('CODEX-CODE')
        return jsonResponse({ authorization_code: 'authz-code', code_verifier: 'verifier-x' })
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        // 二次 exchange：form 编码 + redirect_uri 派生自 deviceCode 端点 origin
        const form = bodyTextOf({ url, init })
        expect(form).toContain('grant_type=authorization_code')
        expect(form).toContain('code=authz-code')
        expect(form).toContain('code_verifier=verifier-x')
        expect(form).toContain('redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback')
        return jsonResponse({ access_token: 'at-codex', refresh_token: 'rt-codex', expires_in: 3600 })
      }
      return jsonResponse({}, 404)
    })

    const hooks: OAuthFlowHooks = { onDeviceCode: vi.fn() }
    const credential = await runOAuthLogin('openai-codex', OPENAI_CODEX_CONFIG, hooks, new AbortController().signal)

    expect(credential.access).toBe('at-codex')
    expect(credential.refresh).toBe('rt-codex')
    // 无 skew：实际运行 now + 3600s（容差覆盖轮询等待）
    expect(Math.abs(credential.expires - (now + 3_600 * 1_000))).toBeLessThan(5_000)
    // verify 端点作为 verificationUri
    expect(hooks.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      userCode: 'CODEX-CODE',
      verificationUri: 'https://auth.openai.com/codex/device',
    }))
  })
})

describe('runOAuthLogin — callback flow', () => {
  it('anthropic：真实回调服务器收 code → JSON token exchange（含 state/PKCE 参数）', async () => {
    // 只 mock token 端点；回调请求走真实 fetch（本地 http server）
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://platform.claude.com/v1/oauth/token') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.grant_type).toBe('authorization_code')
        expect(body.client_id).toBe('anthropic-client')
        expect(body.code).toBe('authz-123')
        expect(typeof body.code_verifier).toBe('string')
        // state 独立随机（不复用 PKCE verifier——code+verifier 同现于明文 loopback URL 有泄露风险）
        expect(body.state).not.toBe(body.code_verifier)
        expect(typeof body.state).toBe('string')
        expect(body.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
        return jsonResponse({ access_token: 'at-an', refresh_token: 'rt-an', expires_in: 7200 })
      }
      return realFetch(url, init)
    }))

    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('anthropic', ANTHROPIC_CONFIG, hooks, new AbortController().signal)

    // 等 server 起来拿到授权 URL，然后模拟浏览器回调
    // onAuthUrl 在 server listen 后同步触发（startCallbackServer await 完成后才调 hooks）
    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    const authUrl = (hooks.onAuthUrl as ReturnType<typeof vi.fn>).mock.calls[0][0] as { url: string }
    const url = new URL(authUrl.url)
    expect(url.searchParams.get('client_id')).toBe('anthropic-client')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    const state = url.searchParams.get('state') as string
    const redirectUri = url.searchParams.get('redirect_uri') as string
    const callbackPort = new URL(redirectUri).port

    // 模拟浏览器回调
    const res = await fetch(`http://127.0.0.1:${callbackPort}/callback?code=authz-123&state=${state}`)
    expect(res.status).toBe(200)

    const credential = await flow
    expect(credential.access).toBe('at-an')
    // 5min skew：实际运行 now + 7200s - 300s（容差覆盖 server 启动）
    expect(Math.abs(credential.expires - (now + 7_200_000 - 5 * 60 * 1_000))).toBeLessThan(5_000)
  })

  it('openrouter：无 clientId，动态端口回调，token 端点返回永久 key（MAX_SAFE_INTEGER）', async () => {
    // 只 mock token 端点；回调请求走真实 fetch（本地 http server）
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://openrouter.ai/api/v1/auth/keys') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.code).toBe('or-code')
        expect(body.code_verifier).toBeTruthy()
        expect(body.code_challenge_method).toBe('S256')
        return jsonResponse({ key: 'sk-orv2-permanent' })
      }
      return realFetch(url, init)
    }))

    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('openrouter', OPENROUTER_CONFIG, hooks, new AbortController().signal)

    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    const authUrl = (hooks.onAuthUrl as ReturnType<typeof vi.fn>).mock.calls[0][0] as { url: string }
    const url = new URL(authUrl.url)
    // authorize 只带 callback_url + challenge（无 client_id/scope/state）
    expect(url.searchParams.has('client_id')).toBe(false)
    expect(url.searchParams.get('callback_url')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\//)

    const callbackUrl = url.searchParams.get('callback_url') as string
    const res = await fetch(`${callbackUrl}?code=or-code`)
    expect(res.status).toBe(200)

    const credential = await flow
    expect(credential.access).toBe('sk-orv2-permanent')
    expect(credential.refresh).toBe('')
    expect(credential.expires).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('abort 取消：进行中 callback flow 立即中断，不抛未捕获错误', async () => {
    mockFetch(async () => jsonResponse({}, 404))
    const controller = new AbortController()
    const hooks: OAuthFlowHooks = { onAuthUrl: vi.fn() }
    const flow = runOAuthLogin('openrouter', OPENROUTER_CONFIG, hooks, controller.signal)

    await vi.waitFor(() => {
      expect(hooks.onAuthUrl).toHaveBeenCalled()
    })
    controller.abort()
    await expect(flow).rejects.toThrow('Login cancelled')
  })
})
