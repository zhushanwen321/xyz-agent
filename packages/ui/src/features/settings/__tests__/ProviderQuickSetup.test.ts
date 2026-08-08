/**
 * ProviderQuickSetup 组件单测（wave-quick-setup-c）。
 *
 * 覆盖验收标准：
 * ① 认证 radio 四选一按 authMode 条件渲染（api_key/both/oauth/ambient）
 * ② 内置信息块：推荐 env var 行 + 模型列表 code 标签
 * ③ env 检测态（envCheck props → ✓/⚠）
 * ④ OAuth 流：登录按钮 → emit oauth-login；oauthAuthorized → 已授权态
 * ⑤ footer hint 四态动态文案
 * ⑥ onSave 构造 SetProviderData 填 authMethod（I6）
 *
 * 测试模式：reka Dialog 经 Portal teleport 到 document.body（同 OAuthDialog.test.ts）。
 * i18n mock 返回 key。
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProviderQuickSetup from '../provider/ProviderQuickSetup.vue'
import type { BuiltinProviderTemplate } from '@xyz-agent/shared'

function tpl(overrides: Partial<BuiltinProviderTemplate>): BuiltinProviderTemplate {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    authMode: 'api_key',
    envVars: ['TEST_API_KEY'],
    oauthSupported: false,
    modelCount: 3,
    models: [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
      { id: 'model-c', name: 'Model C' },
    ],
    ...overrides,
  } as BuiltinProviderTemplate
}

interface MountOverrides {
  template?: BuiltinProviderTemplate
  envCheck?: Record<string, boolean>
  oauthAuthorized?: boolean
}

async function mountSetup(overrides: MountOverrides = {}) {
  const wrapper = mount(ProviderQuickSetup, {
    props: {
      template: tpl({}),
      open: true,
      envCheck: undefined,
      oauthAuthorized: false,
      ...overrides,
    },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

function query(selector: string): HTMLElement | null {
  return document.body.querySelector(selector)
}

describe('认证 radio 条件渲染（TC1）', () => {
  it('api_key：明文 + 环境变量 两个 radio', async () => {
    const w = await mountSetup()
    expect(query('[data-testid="auth-option-plaintext"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-env"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-oauth"]')).toBeNull()
    expect(query('[data-testid="auth-option-ambient"]')).toBeNull()
    w.unmount()
  })

  it('both：明文 + 环境变量 + OAuth 三个 radio（OAuth 可点）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'both', oauthName: 'Claude Pro' }) })
    expect(query('[data-testid="auth-option-plaintext"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-env"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-oauth"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-ambient"]')).toBeNull()
    w.unmount()
  })

  it('oauth：仅 OAuth 一个 radio（openai-codex）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'oauth', envVars: [] }) })
    expect(query('[data-testid="auth-option-oauth"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-plaintext"]')).toBeNull()
    expect(query('[data-testid="auth-option-env"]')).toBeNull()
    w.unmount()
  })

  it('ambient：仅云凭证一个 radio（google-vertex）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'ambient', envVars: [] }) })
    expect(query('[data-testid="auth-option-ambient"]')).toBeTruthy()
    expect(query('[data-testid="auth-option-plaintext"]')).toBeNull()
    expect(query('[data-testid="auth-option-oauth"]')).toBeNull()
    w.unmount()
  })
})

describe('内置信息块（TC2）', () => {
  it('推荐环境变量行 + 模型列表 code 标签', async () => {
    const w = await mountSetup({ template: tpl({ envVars: ['OPENAI_API_KEY'], baseUrl: 'https://api.openai.com/v1' }) })
    const envVarRow = query('[data-testid="builtin-envvar"]')
    expect(envVarRow).toBeTruthy()
    expect(envVarRow!.textContent).toContain('OPENAI_API_KEY')
    const models = query('[data-testid="builtin-models"]')
    expect(models!.textContent).toContain('model-a')
    expect(models!.textContent).toContain('model-c')
    w.unmount()
  })
})

describe('env 检测态（TC3）', () => {
  it('envCheck true → ✓ 检测到文案；false → ⚠ 未设置文案', async () => {
    const w = await mountSetup({ envCheck: { TEST_API_KEY: true } })
    // 默认选中 env 模式（envVars 非空），检测态行出现
    const detected = query('[data-testid="env-detected"]')
    expect(detected).toBeTruthy()
    expect(detected!.textContent).toContain('envDetected')
    w.unmount()
  })

  it('envCheck false → 未设置文案', async () => {
    const w = await mountSetup({ envCheck: { TEST_API_KEY: false } })
    const detected = query('[data-testid="env-detected"]')
    expect(detected).toBeTruthy()
    expect(detected!.textContent).toContain('envNotSet')
    w.unmount()
  })

  it('envCheck 未传入（undefined）→ 不显示检测态', async () => {
    const w = await mountSetup()
    expect(query('[data-testid="env-detected"]')).toBeNull()
    w.unmount()
  })
})

describe('OAuth 流（TC4）', () => {
  it('点登录按钮 → emit oauth-login', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'both', oauthName: 'Claude Pro' }) })
    // 切到 OAuth radio
    const oauthOption = query('[data-testid="auth-option-oauth"]')!
    ;(oauthOption as HTMLElement).click()
    await flushPromises()
    const loginBtn = query('[data-testid="oauth-login-button"]')!
    expect(loginBtn).toBeTruthy()
    ;(loginBtn as HTMLElement).click()
    const events = w.emitted('oauth-login')
    expect(events).toBeTruthy()
    expect(events!.length).toBe(1)
    w.unmount()
  })

  it('oauthAuthorized=true → 已授权态（不再显示登录按钮）', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'both', oauthName: 'Claude Pro' }), oauthAuthorized: true })
    const oauthOption = query('[data-testid="auth-option-oauth"]')!
    ;(oauthOption as HTMLElement).click()
    await flushPromises()
    expect(query('[data-testid="oauth-authorized"]')).toBeTruthy()
    expect(query('[data-testid="oauth-login-button"]')).toBeNull()
    w.unmount()
  })
})

describe('footer hint（TC5）', () => {
  it('四态动态文案随认证方式变化', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'both', envVars: ['ANTHROPIC_API_KEY'] }) })
    const hint = query('[data-testid="footer-hint"]')!
    // 默认 env → env hint
    expect(hint.textContent).toContain('footerHintEnv')
    // 明文
    ;(query('[data-testid="auth-option-plaintext"]')! as HTMLElement).click()
    await flushPromises()
    expect(hint.textContent).toContain('footerHintPlaintext')
    // OAuth
    ;(query('[data-testid="auth-option-oauth"]')! as HTMLElement).click()
    await flushPromises()
    expect(hint.textContent).toContain('footerHintOauth')
    w.unmount()
  })
})

describe('onSave authMethod（TC6，I6 契约）', () => {
  it('明文 → authMethod=api_key + apiKey 明文', async () => {
    const w = await mountSetup()
    ;(query('[data-testid="auth-option-plaintext"]')! as HTMLElement).click()
    await flushPromises()
    const input = query('[data-testid="credential-apikey-input"]') as HTMLInputElement
    input.value = 'sk-abc'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    ;(query('[data-testid="provider-quick-setup-save"]')! as HTMLElement).click()
    const save = w.emitted('save')![0][0] as { providerId: string; data: { apiKey?: string; authMethod?: string } }
    expect(save.data.authMethod).toBe('api_key')
    expect(save.data.apiKey).toBe('sk-abc')
    w.unmount()
  })

  it('env → authMethod=env_var + apiKey=$VAR', async () => {
    const w = await mountSetup({ template: tpl({ envVars: ['OPENAI_API_KEY'] }) })
    // 默认 env 模式
    ;(query('[data-testid="provider-quick-setup-save"]')! as HTMLElement).click()
    const save = w.emitted('save')![0][0] as { data: { apiKey?: string; authMethod?: string } }
    expect(save.data.authMethod).toBe('env_var')
    expect(save.data.apiKey).toBe('$OPENAI_API_KEY')
    w.unmount()
  })

  it('oauth（已授权）→ authMethod=oauth，不带 apiKey', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'oauth', envVars: [] }), oauthAuthorized: true })
    ;(query('[data-testid="provider-quick-setup-save"]')! as HTMLElement).click()
    const save = w.emitted('save')![0][0] as { data: { apiKey?: string; authMethod?: string } }
    expect(save.data.authMethod).toBe('oauth')
    expect(save.data.apiKey).toBeUndefined()
    w.unmount()
  })

  it('OAuth 未授权 → 保存禁用', async () => {
    const w = await mountSetup({ template: tpl({ authMode: 'oauth', envVars: [] }), oauthAuthorized: false })
    const saveBtn = query('[data-testid="provider-quick-setup-save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    w.unmount()
  })
})
