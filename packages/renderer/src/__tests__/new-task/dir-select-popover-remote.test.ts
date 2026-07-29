/**
 * W2 TC1-TC6: DirSelectPopover 远程模式单测（动作项 + 手动路径 Enter）。
 *
 * 覆盖：
 * - TC1 远程模式隐藏「打开文件夹」+ 显「远程连接」
 * - TC2 本地模式「打开文件夹」逐字节不变（不显远程连接）
 * - TC3 点「远程连接」emit remote-connect
 * - TC4 手动路径：远程模式 Enter 无 records 命中 emit select
 * - TC5 Enter 有 records 命中选中 filtered[0]（不手动路径）
 * - TC6 本地模式 Enter 无 records 命中不 emit select
 *
 * mock 策略：vi.mock connection-config isRemoteMode 控 true/false + workspaceStore records 控数据。
 *
 * 运行：npx vitest run src/__tests__/new-task/dir-select-popover-remote.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'

// 可控 isRemoteMode（每个 describe 设定）
let remoteMode = false
vi.mock('@/lib/remote/connection-config', () => ({
  isRemoteMode: () => remoteMode,
  getActiveProfile: () => null,
  deactivateRemote: vi.fn(),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(),
}))

import DirSelectPopover from '@/components/new-task/DirSelectPopover.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const mockUseWorkspaceStore = vi.mocked(useWorkspaceStore)

function mkRecord(cwd: string): RecentWorkspaceRecord {
  return { cwd, lastUsedAt: 1, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}

function setupStore(records: RecentWorkspaceRecord[]): void {
  mockUseWorkspaceStore.mockReturnValue({
    records,
    defaultCwd: records[0]?.cwd,
    load: vi.fn(),
  } as ReturnType<typeof useWorkspaceStore>)
}

beforeEach(() => {
  remoteMode = false
  mockUseWorkspaceStore.mockReset()
  setupStore([])
})

describe('W2 TC1: DirSelectPopover 远程模式隐藏打开文件夹 + 显远程连接', () => {
  it('isRemoteMode=true → action-open-dir 不存在，action-remote-connect 显远程连接文案', () => {
    remoteMode = true
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(w.find('[data-testid="action-open-dir"]').exists()).toBe(false)
    const remoteItem = w.find('[data-testid="action-remote-connect"]')
    expect(remoteItem.exists()).toBe(true)
    expect(remoteItem.text()).toContain('远程连接')
  })
})

describe('W2 TC2: DirSelectPopover 本地模式打开文件夹逐字节不变', () => {
  it('isRemoteMode=false → action-open-dir 存在，action-remote-connect 不存在', () => {
    remoteMode = false
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(w.find('[data-testid="action-open-dir"]').exists()).toBe(true)
    expect(w.find('[data-testid="action-remote-connect"]').exists()).toBe(false)
  })
})

describe('W2 TC3: 点远程连接 emit remote-connect', () => {
  it('isRemoteMode=true，点 action-remote-connect → emit remote-connect 1 次', async () => {
    remoteMode = true
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    await w.find('[data-testid="action-remote-connect"]').trigger('click')
    expect(w.emitted('remote-connect')).toBeTruthy()
    expect(w.emitted('remote-connect')).toHaveLength(1)
  })
})

describe('W2 TC4: 手动路径 Enter（远程模式 + 无 records 命中）', () => {
  it('isRemoteMode=true，records=[]，输入路径 Enter → emit select {cwd}', async () => {
    remoteMode = true
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    await w.find('input').setValue('/remote/path')
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('select')).toEqual([[{ cwd: '/remote/path' }]])
  })
})

describe('W2 TC5: Enter 有 records 命中选中 filtered[0]（不手动路径）', () => {
  it('isRemoteMode=true，records=[/a,/b]，输入 a 命中 → emit select {cwd:/a}', async () => {
    remoteMode = true
    setupStore([mkRecord('/work/a'), mkRecord('/work/b')])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    await w.find('input').setValue('a')
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('select')).toEqual([[{ cwd: '/work/a' }]])
  })
})

describe('W2 TC6: 本地模式 Enter 无 records 命中不 emit select', () => {
  it('isRemoteMode=false，records=[]，输入路径 Enter → 不 emit select（有打开文件夹兜底）', async () => {
    remoteMode = false
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    await w.find('input').setValue('/any/path')
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('select')).toBeFalsy()
  })
})

describe('W2 TC7: 远程模式独立手动路径输入行（spec §九.2）', () => {
  it('isRemoteMode=true → 手动路径行 + input + 确认按钮存在', () => {
    remoteMode = true
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(w.find('[data-testid="manual-path-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="manual-path-input"]').exists()).toBe(true)
    expect(w.find('[data-testid="manual-path-confirm"]').exists()).toBe(true)
  })

  it('isRemoteMode=false → 手动路径行不存在', () => {
    remoteMode = false
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(w.find('[data-testid="manual-path-row"]').exists()).toBe(false)
  })

  it('输入路径点确认按钮 → emit select {cwd}（独立于搜索框）', async () => {
    remoteMode = true
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    await w.find('[data-testid="manual-path-input"]').setValue('/remote/server/path')
    await w.find('[data-testid="manual-path-confirm"]').trigger('click')
    expect(w.emitted('select')).toEqual([[{ cwd: '/remote/server/path' }]])
  })

  it('手动路径 input Enter 也 emit select', async () => {
    remoteMode = true
    setupStore([])
    const w = mount(DirSelectPopover, { props: { currentCwd: null } })
    await w.find('[data-testid="manual-path-input"]').setValue('~/projects/xyz-agent')
    await w.find('[data-testid="manual-path-input"]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('select')).toEqual([[{ cwd: '~/projects/xyz-agent' }]])
  })
})
