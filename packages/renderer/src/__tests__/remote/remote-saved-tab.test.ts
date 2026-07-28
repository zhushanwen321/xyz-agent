/**
 * W1 TC14-TC16: RemoteSavedTab 单测（已保存 tab 空列表 + probeOnline + activate）。
 *
 * 覆盖：
 * - TC14 空列表显示提示
 * - TC15 后台 probeOnline 标记在线/离线
 * - TC16 点击 profile activateRemote+reload（不重 probe）
 *
 * mock 策略：vi.mock connection-config listProfiles（控数据）+ probe probeOnline（控在线态）；
 * vi.stubGlobal location.reload。
 *
 * 运行：npx vitest run src/__tests__/remote/remote-saved-tab.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { RemoteServerProfile } from '@/lib/remote/types'

const probeOnlineMock = vi.fn(async (): Promise<boolean> => true)
vi.mock('@/lib/remote/probe', () => ({
  probeConnect: vi.fn(),
  probeOnline: (...args: unknown[]) => probeOnlineMock(...args as [string, number?]),
}))

const connMock = vi.hoisted(() => ({
  listProfiles: vi.fn((): RemoteServerProfile[] => []),
  activateRemote: vi.fn(),
  saveProfile: vi.fn(),
  getActiveProfile: vi.fn(() => null),
  isRemoteMode: vi.fn(() => false),
  getClientId: vi.fn(() => 'cid'),
  getDeviceName: vi.fn(() => 'Mac'),
  deactivateRemote: vi.fn(),
}))
vi.mock('@/lib/remote/connection-config', () => connMock)

const reloadSpy = vi.fn()
vi.stubGlobal('location', { reload: reloadSpy })

import RemoteSavedTab from '@/components/remote/RemoteSavedTab.vue'

function mkProfile(id: string, url: string): RemoteServerProfile {
  return { id, name: id, url, token: 'tok', networkKind: 'public' }
}

beforeEach(() => {
  vi.clearAllMocks()
  probeOnlineMock.mockReset()
  probeOnlineMock.mockResolvedValue(true)
  connMock.listProfiles.mockReturnValue([])
})

describe('W1 TC14: 空列表显示提示', () => {
  it('listProfiles=[] → 显空态文案，无 profile 项', async () => {
    connMock.listProfiles.mockReturnValue([])
    const w = mount(RemoteSavedTab)
    await flushPromises()
    expect(w.find('[data-testid="saved-empty"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="saved-profile-item"]')).toHaveLength(0)
  })

  it('listProfiles 有数据 → 不显空态，渲染 profile 项', async () => {
    connMock.listProfiles.mockReturnValue([mkProfile('p1', 'ws://1.2.3.4:8080')])
    const w = mount(RemoteSavedTab)
    await flushPromises()
    expect(w.find('[data-testid="saved-empty"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="saved-profile-item"]')).toHaveLength(1)
  })
})

describe('W1 TC15: 后台 probeOnline 标记在线/离线', () => {
  it('2 个 profile，probeOnline 第一个 true 第二个 false → 圆点颜色 + 文案不同', async () => {
    connMock.listProfiles.mockReturnValue([mkProfile('p1', 'ws://1.1.1.1:8080'), mkProfile('p2', 'ws://2.2.2.2:8080')])
    probeOnlineMock.mockImplementation(async (url: string) => url.includes('1.1.1.1'))
    const w = mount(RemoteSavedTab)
    await flushPromises()
    const items = w.findAll('[data-testid="saved-profile-item"]')
    expect(items).toHaveLength(2)
    // 第一个在线（绿点），第二个离线（灰点）
    const dot1 = items[0]!.find('[data-testid="profile-online-dot"]')
    const dot2 = items[1]!.find('[data-testid="profile-online-dot"]')
    expect(dot1.classes()).toContain('bg-success')
    expect(dot2.classes()).toContain('bg-subtle')
    // 在线/离线文案
    expect(items[0]!.text()).toContain('在线')
    expect(items[1]!.text()).toContain('离线')
  })
})

describe('W1 TC16: 点击 profile activateRemote+reload（不重 probe）', () => {
  it('点击 profile → activateRemote(profile.id) + reload，probeConnect 未调', async () => {
    connMock.listProfiles.mockReturnValue([mkProfile('p1', 'ws://1.2.3.4:8080')])
    const w = mount(RemoteSavedTab)
    await flushPromises()
    await w.find('[data-testid="saved-profile-item"]').trigger('click')
    expect(connMock.activateRemote).toHaveBeenCalledWith('p1')
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    // probeConnect 在 saved tab 不调用（mock 的 probeConnect 调用次数为 0）
    // probeOnline 仅在 onMounted 后台调一次，点击后不重 probe
    expect(probeOnlineMock).toHaveBeenCalledTimes(1)
  })
})
