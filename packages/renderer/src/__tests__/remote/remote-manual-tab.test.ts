/**
 * W1 TC11-TC13: RemoteManualTab 单测（手填 tab disabled + url 拼接 + 连接成功）。
 *
 * 覆盖：
 * - TC11 host 为空连接按钮 disabled
 * - TC12 url 拼接规则（无前缀 ws://host:port / 有 ws:// 前缀）
 * - TC13 连接成功 saveProfile+activateRemote+reload
 *
 * mock 策略：vi.mock probe + connection-config；vi.stubGlobal location.reload。
 *
 * 运行：npx vitest run src/__tests__/remote/remote-manual-tab.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { ProbeConnectResult } from '@/lib/remote/probe'

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

const reloadSpy = vi.fn()
vi.stubGlobal('location', { reload: reloadSpy })

import RemoteManualTab from '@/components/remote/RemoteManualTab.vue'

beforeEach(() => {
  vi.clearAllMocks()
  probeConnectMock.mockClear()
  probeResult = { ok: true, serverVersion: '1.0' }
})

describe('W1 TC11: host 为空连接按钮 disabled', () => {
  it('初始 host 空 → connect btn disabled', () => {
    const w = mount(RemoteManualTab)
    const btn = w.find('[data-testid="manual-connect-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('填入 host → connect btn 不再 disabled', async () => {
    const w = mount(RemoteManualTab)
    await w.find('[data-testid="manual-host"]').setValue('1.2.3.4')
    expect(w.find('[data-testid="manual-connect-btn"]').attributes('disabled')).toBeUndefined()
  })
})

describe('W1 TC12: url 拼接规则', () => {
  it('host=1.2.3.4 port=8080 → url=ws://1.2.3.4:8080', async () => {
    const w = mount(RemoteManualTab)
    await w.find('[data-testid="manual-host"]').setValue('1.2.3.4')
    // port 默认 8080
    await w.find('[data-testid="manual-connect-btn"]').trigger('click')
    await flushPromises()
    expect(probeConnectMock).toHaveBeenCalledWith('ws://1.2.3.4:8080', '')
  })

  it('host=ws://example.com port=9090 → url=ws://example.com:9090（保留 scheme + 补 port）', async () => {
    const w = mount(RemoteManualTab)
    await w.find('[data-testid="manual-host"]').setValue('ws://example.com')
    await w.find('[data-testid="manual-port"]').setValue('9090')
    await w.find('[data-testid="manual-connect-btn"]').trigger('click')
    await flushPromises()
    expect(probeConnectMock).toHaveBeenCalledWith('ws://example.com:9090', '')
  })

  it('host=ws://example.com:7070 port=9090 → url=ws://example.com:7070（已有 port 保留不覆盖）', async () => {
    const w = mount(RemoteManualTab)
    await w.find('[data-testid="manual-host"]').setValue('ws://example.com:7070')
    await w.find('[data-testid="manual-port"]').setValue('9090')
    await w.find('[data-testid="manual-connect-btn"]').trigger('click')
    await flushPromises()
    expect(probeConnectMock).toHaveBeenCalledWith('ws://example.com:7070', '')
  })
})

describe('W1 TC13: 连接成功 saveProfile+activateRemote+reload', () => {
  it('host/port/token 有效 + probe ok → 三件套各调 1 次', async () => {
    const w = mount(RemoteManualTab)
    await w.find('[data-testid="manual-host"]').setValue('1.2.3.4')
    await w.find('[data-testid="manual-port"]').setValue('8080')
    await w.find('[data-testid="manual-token"]').setValue('tok123')
    await w.find('[data-testid="manual-connect-btn"]').trigger('click')
    await flushPromises()
    expect(probeConnectMock).toHaveBeenCalledWith('ws://1.2.3.4:8080', 'tok123')
    expect(connMock.saveProfile).toHaveBeenCalledTimes(1)
    const saved = connMock.saveProfile.mock.calls[0]![0] as { url: string; token: string }
    expect(saved.url).toBe('ws://1.2.3.4:8080')
    expect(saved.token).toBe('tok123')
    expect(connMock.activateRemote).toHaveBeenCalledWith('pid-1')
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })
})
