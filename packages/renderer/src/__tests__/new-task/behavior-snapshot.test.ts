/**
 * 行为快照测试（W0 prefactor，code-architecture §7）
 *
 * W3 改接后比对基线：recentWorkspaces/resolveDefaultCwd 已迁移至 workspaceStore。
 * 本测试保留 DirSelectPopover 渲染形态比对（改接 workspaceStore 后行为等价）。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/behavior-snapshot.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'

// W3: mock workspaceStore 让 DirSelectPopover 渲染改接后的 records
import { vi } from 'vitest'

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(),
}))

import DirSelectPopover from '@/components/new-task/DirSelectPopover.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const mockUseWorkspaceStore = vi.mocked(useWorkspaceStore)

function mkRecord(cwd: string, lastUsedAt: number): RecentWorkspaceRecord {
  return { cwd, lastUsedAt, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}

function setupWorkspaceStore(records: RecentWorkspaceRecord[]) {
  mockUseWorkspaceStore.mockReturnValue({
    records,
    defaultCwd: records[0]?.cwd,
    load: vi.fn(),
  } as ReturnType<typeof useWorkspaceStore>)
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockUseWorkspaceStore.mockReset()
})

describe('行为快照：DirSelectPopover 渲染形态（W3 改接后比对基线）', () => {
  it('有 records → 渲染列表项 + 目录名 + 路径两行', () => {
    setupWorkspaceStore([
      mkRecord('/repo-a', 200),
      mkRecord('/repo-b', 100),
    ])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    const items = wrapper.findAll('[data-testid="workspace-item"]')
    expect(items).toHaveLength(2)
    // 第一项含目录名和路径
    expect(items[0].text()).toContain('repo-a')
    expect(items[0].text()).toContain('/repo-a')
  })

  it('空态 → 渲染「暂无最近工作区」文案', () => {
    setupWorkspaceStore([])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(wrapper.text()).toContain('暂无最近工作区')
  })

  it('搜索过滤：输入 foo → 只含 cwd 含 foo 的项', async () => {
    setupWorkspaceStore([
      mkRecord('/foo-bar', 200),
      mkRecord('/baz-qux', 100),
    ])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    await wrapper.find('input').setValue('foo')
    const items = wrapper.findAll('[data-testid="workspace-item"]')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('/foo-bar')
  })
})
