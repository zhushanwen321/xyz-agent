/**
 * W2 TC7-TC14: Landing 远程状态条 + presetCwd 远程分支单测。
 *
 * 覆盖：
 * - TC7 远程状态条渲染（host + 切换/断开按钮）
 * - TC8 本地模式不渲染状态条（回归）
 * - TC9 RTT 轮询 2s 刷新显示
 * - TC10 切换按钮打开 RemoteConnectModal
 * - TC11 断开按钮 deactivateRemote + reload
 * - TC12 presetCwd 远程分支：records[0] 存在则预选
 * - TC13 presetCwd 远程分支：records 空保持空 chip 态（不用 props.currentCwd 兑底）
 * - TC14 presetCwd 本地模式回归：用 props.currentCwd 兑底
 *
 * mock 策略：vi.mock connection-config（isRemoteMode/getActiveProfile/deactivateRemote）+
 * ws-client（getRttStats）+ vi.stubGlobal location.reload + flowMock（presetCwd/currentCwd）+
 * workspaceStore records 控数据。Composer/DirSelectPopover stub（与 landing.test.ts 同模式）。
 *
 * 运行：npx vitest run src/__tests__/new-task/landing-remote.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 可控 isRemoteMode（每个 describe 设定）
let remoteMode = false
let activeProfile: { url: string; id: string; name: string; token: string; networkKind: 'public' } | null = null
let rttStats = { count: 0 }

const connMock = vi.hoisted(() => ({
  isRemoteMode: () => remoteMode,
  getActiveProfile: () => activeProfile,
  deactivateRemote: vi.fn(),
}))
vi.mock('@/lib/remote/connection-config', () => connMock)

vi.mock('@/lib/ws-client', () => ({
  getRttStats: () => rttStats,
}))

// flowMock（presetCwd/currentCwd/state，复用 landing.test.ts 模式）
const flowMock = vi.hoisted(() => ({
  currentSessionId: { value: null as string | null },
  currentCwd: { value: null as string | null },
  // pi-launch-presets wave2：Landing 透传 launchPresetId 给 PresetSelectChip（flow.currentSession.value?.launchPresetId），
  // 需 currentSession 兜底（合并 main 后 Landing.vue 新增引用，flowMock 缺失会触发 undefined.value 报错）
  currentSession: { value: null as { launchPresetId?: string } | null },
  presetCwd: vi.fn(),
  gitInfo: { value: null as { branch: string } | null },
  mode: { value: 'not-repo' as string },
  worktreeItems: { value: [] as unknown[] },
  openDirPopover: vi.fn(),
  openBranchPopover: vi.fn(),
  closeOverlay: vi.fn(),
  selectWorkspace: vi.fn(),
  selectBranch: vi.fn(),
  confirmDirtySwitch: vi.fn(),
  openDirDialog: vi.fn(),
  openBranchModal: vi.fn(),
  openCreateWorktree: vi.fn(),
  isBare: { value: false },
  state: { value: 'idle' as string },
  startFlow: vi.fn(),
}))
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => flowMock,
  resetNewTaskFlow: vi.fn(),
}))

const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMock }))

// workspaceStore records 控数据
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(),
}))

import Landing from '@/components/new-task/Landing.vue'
import { useWorkspaceStore } from '@/stores/workspace'
const mockUseWorkspaceStore = vi.mocked(useWorkspaceStore)

function setupStore(records: { cwd: string }[]): void {
  mockUseWorkspaceStore.mockReturnValue({
    records,
    defaultCwd: records[0]?.cwd,
    load: vi.fn(),
  } as ReturnType<typeof useWorkspaceStore>)
}

const reloadSpy = vi.fn()
vi.stubGlobal('location', { reload: reloadSpy })

/** stub 重子组件（与 landing.test.ts 同模式，避免渲染真实 Composer 触发重依赖） */
const stubs = {
  Composer: { template: '<div data-testid="composer-stub"><slot name="meta-row" /></div>' },
  DirSelectPopover: { name: 'DirSelectPopover', template: '<div />', emits: ['select', 'open-dir-dialog', 'remote-connect', 'close'] },
  RemoteConnectModal: { name: 'RemoteConnectModal', props: ['standalone'], emits: ['close'], template: '<div data-testid="remote-connect-modal" />' },
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  remoteMode = false
  activeProfile = null
  rttStats = { count: 0 }
  setupStore([])
  flowMock.state.value = 'landing'
  flowMock.currentCwd.value = null
  flowMock.gitInfo.value = null
  flowMock.mode.value = 'not-repo'
  flowMock.presetCwd.mockClear()
})

describe('W2 TC7: Landing 远程状态条渲染', () => {
  it('isRemoteMode=true + getActiveProfile=ws://host.com → 状态条渲染含 host + 切换/断开按钮', () => {
    remoteMode = true
    activeProfile = { id: 'p1', name: 'h', url: 'ws://host.com:8080', token: 't', networkKind: 'public' }
    const w = mount(Landing, { props: { sessionId: null, currentCwd: null }, global: { stubs } })
    expect(w.find('[data-testid="remote-status-bar"]').exists()).toBe(true)
    expect(w.find('[data-testid="remote-host"]').text()).toContain('host.com')
    expect(w.find('[data-testid="remote-switch-btn"]').exists()).toBe(true)
    expect(w.find('[data-testid="remote-disconnect-btn"]').exists()).toBe(true)
  })
})

describe('W2 TC8: Landing 本地模式不渲染状态条', () => {
  it('isRemoteMode=false → 状态条不渲染', () => {
    remoteMode = false
    const w = mount(Landing, { props: { sessionId: null, currentCwd: null }, global: { stubs } })
    expect(w.find('[data-testid="remote-status-bar"]').exists()).toBe(false)
  })
})

describe('W2 TC9: Landing RTT 轮询 2s 刷新显示', () => {
  it('mount 后 advance 2000ms → RTT 文案含 42ms', async () => {
    remoteMode = true
    activeProfile = { id: 'p1', name: 'h', url: 'ws://host.com:8080', token: 't', networkKind: 'public' }
    rttStats = { count: 0 }
    vi.useFakeTimers()
    try {
      const w = mount(Landing, { props: { sessionId: null, currentCwd: null }, global: { stubs } })
      // 首次渲染 count=0 显「-」
      expect(w.find('[data-testid="remote-rtt"]').text()).toContain('-')
      // 推进 2s，轮询拉取新快照
      rttStats = { count: 1, last: 42 }
      vi.advanceTimersByTime(2000)
      await flushPromises()
      expect(w.find('[data-testid="remote-rtt"]').text()).toContain('42')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('W2 TC10: Landing 切换按钮打开 RemoteConnectModal', () => {
  it('点切换按钮 → RemoteConnectModal 挂载', async () => {
    remoteMode = true
    activeProfile = { id: 'p1', name: 'h', url: 'ws://host.com:8080', token: 't', networkKind: 'public' }
    const w = mount(Landing, { props: { sessionId: null, currentCwd: null }, global: { stubs } })
    expect(w.find('[data-testid="remote-connect-modal"]').exists()).toBe(false)
    await w.find('[data-testid="remote-switch-btn"]').trigger('click')
    expect(w.find('[data-testid="remote-connect-modal"]').exists()).toBe(true)
  })
})

describe('W2 TC11: Landing 断开按钮 deactivateRemote + reload', () => {
  it('点断开按钮 → deactivateRemote 调 1 次 + reload 调 1 次', async () => {
    remoteMode = true
    activeProfile = { id: 'p1', name: 'h', url: 'ws://host.com:8080', token: 't', networkKind: 'public' }
    const w = mount(Landing, { props: { sessionId: null, currentCwd: null }, global: { stubs } })
    await w.find('[data-testid="remote-disconnect-btn"]').trigger('click')
    expect(connMock.deactivateRemote).toHaveBeenCalledTimes(1)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })
})

describe('W2 TC12: Landing presetCwd 远程分支 records[0] 存在则预选', () => {
  it('isRemoteMode=true, records=[{cwd:/remote/ws}] → presetCwd(/remote/ws)', () => {
    remoteMode = true
    setupStore([{ cwd: '/remote/ws' }])
    flowMock.state.value = 'landing'
    flowMock.currentCwd.value = null
    mount(Landing, { props: { sessionId: null, currentCwd: null }, global: { stubs } })
    expect(flowMock.presetCwd).toHaveBeenCalledWith('/remote/ws')
  })
})

describe('W2 TC13: Landing presetCwd 远程分支 records 空保持空 chip（不用 props.currentCwd 兑底）', () => {
  it('isRemoteMode=true, records=[], currentCwd=/local/default → presetCwd 未调', () => {
    remoteMode = true
    setupStore([])
    flowMock.state.value = 'landing'
    flowMock.currentCwd.value = null
    mount(Landing, { props: { sessionId: null, currentCwd: '/local/default' }, global: { stubs } })
    expect(flowMock.presetCwd).not.toHaveBeenCalled()
  })
})

describe('W2 TC14: Landing presetCwd 本地模式回归用 props.currentCwd', () => {
  it('isRemoteMode=false, currentCwd=/local/ws → presetCwd(/local/ws)', () => {
    remoteMode = false
    flowMock.state.value = 'landing'
    flowMock.currentCwd.value = null
    mount(Landing, { props: { sessionId: null, currentCwd: '/local/ws' }, global: { stubs } })
    expect(flowMock.presetCwd).toHaveBeenCalledWith('/local/ws')
  })
})
