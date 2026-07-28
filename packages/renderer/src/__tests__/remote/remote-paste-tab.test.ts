/**
 * W1 TC4-TC10: RemotePasteTab 单测（粘贴 tab parse + probe + clipboard）。
 *
 * 覆盖：
 * - TC4 实时解析 ws-url 显示 tailscale networkKind chip
 * - TC5 无法识别显示橙色提示不清空
 * - TC6 连接成功 saveProfile+activateRemote+reload
 * - TC7 probeConnect auth 失败显示红色错误不落库
 * - TC8 probeConnect network/timeout 三态文案区分
 * - TC9 剪贴板探测预填 ws 格式
 * - TC10 剪贴板探测失败静默
 *
 * mock 策略：
 * - vi.mock remote/probe（probeConnect 返可控 Promise，避免 new WebSocket hang）
 * - vi.mock remote/connection-config（spy saveProfile/activateRemote）
 * - vi.stubGlobal location.reload（避免真重载）
 * - vi.stubGlobal navigator.clipboard.readText（控预填/reject）
 *
 * 运行：npx vitest run src/__tests__/remote/remote-paste-tab.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { ProbeConnectResult } from '@/lib/remote/probe'

// 可控 probeConnect 返回值（每个 it 设定）
let probeResult: ProbeConnectResult = { ok: true, serverVersion: '1.0' }
const probeConnectMock = vi.fn(async (): Promise<ProbeConnectResult> => probeResult)

vi.mock('@/lib/remote/probe', () => ({
  probeConnect: (...args: unknown[]) => probeConnectMock(...args as [string, string, number?]),
  probeOnline: vi.fn(async () => true),
}))

const connMock = vi.hoisted(() => ({
  saveProfile: vi.fn((p: { url: string }) => ({ id: 'pid-1', name: 'h', url: p.url, token: 't', networkKind: 'public' })),
  activateRemote: vi.fn(),
  listProfiles: vi.fn(() => []),
  getActiveProfile: vi.fn(() => null),
  isRemoteMode: vi.fn(() => false),
  getClientId: vi.fn(() => 'cid'),
  getDeviceName: vi.fn(() => 'Mac'),
  deactivateRemote: vi.fn(),
}))
vi.mock('@/lib/remote/connection-config', () => connMock)

// location.reload spy（避免真重载）
const reloadSpy = vi.fn()
vi.stubGlobal('location', { reload: reloadSpy })

import RemotePasteTab from '@/components/remote/RemotePasteTab.vue'

beforeEach(() => {
  vi.clearAllMocks()
  probeConnectMock.mockClear()
  probeResult = { ok: true, serverVersion: '1.0' }
  // 默认 clipboard 不可用（多数用例不依赖）
  vi.stubGlobal('navigator', { clipboard: { readText: async () => '' } })
})

describe('W1 TC4: RemotePasteTab 实时解析 ws-url 显示 networkKind chip', () => {
  it('输入 tailscale CGNAT 网段 ws-url → chip 显示 Tailscale', async () => {
    const w = mount(RemotePasteTab)
    await w.find('[data-testid="paste-textarea"]').setValue('ws://100.64.0.1:8080')
    await flushPromises()
    const result = w.find('[data-testid="parse-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('Tailscale')
    expect(w.find('[data-testid="unrecognized-hint"]').exists()).toBe(false)
  })
})

describe('W1 TC5: 无法识别文本显示橙色提示不清空', () => {
  it('输入 random garbage → 显示 unrecognized 提示，textarea 值保留', async () => {
    const w = mount(RemotePasteTab)
    await w.find('[data-testid="paste-textarea"]').setValue('random garbage text')
    await flushPromises()
    expect(w.find('[data-testid="unrecognized-hint"]').exists()).toBe(true)
    expect(w.find('[data-testid="parse-result"]').exists()).toBe(false)
    // textarea 值保留
    expect((w.find('[data-testid="paste-textarea"]').element as HTMLTextAreaElement).value).toContain('random garbage')
  })
})

describe('W1 TC6: 连接成功 saveProfile+activateRemote+reload', () => {
  it('有效 url-token-lines（ws-url + Token 行），probe ok → 三件套各调 1 次', async () => {
    const w = mount(RemotePasteTab)
    // url-token-lines 格式：parseConnectionInfo 提取 url + token 两字段
    await w.find('[data-testid="paste-textarea"]').setValue('URL: ws://1.2.3.4:8080\nToken: abc')
    await flushPromises()
    await w.find('[data-testid="paste-connect-btn"]').trigger('click')
    await flushPromises()
    expect(probeConnectMock).toHaveBeenCalledTimes(1)
    expect(probeConnectMock).toHaveBeenCalledWith('ws://1.2.3.4:8080', 'abc')
    expect(connMock.saveProfile).toHaveBeenCalledTimes(1)
    const saved = connMock.saveProfile.mock.calls[0]![0] as { url: string; token: string; networkKind: string }
    expect(saved.url).toBe('ws://1.2.3.4:8080')
    expect(saved.token).toBe('abc')
    expect(connMock.activateRemote).toHaveBeenCalledWith('pid-1')
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })
})

describe('W1 TC7: probeConnect auth 失败显示红色错误不落库', () => {
  it('probe ok:false error:auth → 红色 auth 文案，saveProfile/activateRemote/reload 全 0', async () => {
    probeResult = { ok: false, error: 'auth' }
    const w = mount(RemotePasteTab)
    await w.find('[data-testid="paste-textarea"]').setValue('ws://1.2.3.4:8080#token=wrong')
    await flushPromises()
    await w.find('[data-testid="paste-connect-btn"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="probe-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="probe-error"]').text()).toContain('认证')
    expect(connMock.saveProfile).not.toHaveBeenCalled()
    expect(connMock.activateRemote).not.toHaveBeenCalled()
    expect(reloadSpy).not.toHaveBeenCalled()
  })
})

describe('W1 TC8: probeConnect network/timeout 三态文案区分', () => {
  it('network → 文案含「无法连接」', async () => {
    probeResult = { ok: false, error: 'network' }
    const w = mount(RemotePasteTab)
    await w.find('[data-testid="paste-textarea"]').setValue('ws://1.2.3.4:8080')
    await flushPromises()
    await w.find('[data-testid="paste-connect-btn"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="probe-error"]').text()).toContain('无法连接')
  })

  it('timeout → 文案含「超时」', async () => {
    probeResult = { ok: false, error: 'timeout' }
    const w = mount(RemotePasteTab)
    await w.find('[data-testid="paste-textarea"]').setValue('ws://1.2.3.4:8080')
    await flushPromises()
    await w.find('[data-testid="paste-connect-btn"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="probe-error"]').text()).toContain('超时')
  })
})

describe('W1 TC9: 剪贴板探测预填 ws 格式', () => {
  it('clipboard 有 ws:// url → textarea 自动填入 + 解析 chip 显示', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: async () => 'ws://1.2.3.4:8080#token=abc' } })
    const w = mount(RemotePasteTab)
    await flushPromises()
    expect((w.find('[data-testid="paste-textarea"]').element as HTMLTextAreaElement).value).toBe('ws://1.2.3.4:8080#token=abc')
    expect(w.find('[data-testid="clipboard-detected-hint"]').exists()).toBe(true)
    expect(w.find('[data-testid="parse-result"]').exists()).toBe(true)
  })
})

describe('W1 TC10: 剪贴板探测失败静默', () => {
  it('clipboard readText reject → textarea 空 + 无异常文案', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: async () => Promise.reject(new Error('denied')) } })
    const w = mount(RemotePasteTab)
    await flushPromises()
    expect((w.find('[data-testid="paste-textarea"]').element as HTMLTextAreaElement).value).toBe('')
    expect(w.find('[data-testid="clipboard-detected-hint"]').exists()).toBe(false)
    expect(w.find('[data-testid="unrecognized-hint"]').exists()).toBe(false)
  })
})
