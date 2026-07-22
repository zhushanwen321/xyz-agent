/**
 * DirSelectPopover worktree 动作项条件显示测试 —— TDD 红灯阶段（AC-1/AC-2）。
 *
 * 测 DirSelectPopover.vue 待实现的改动（实现未写，本文件先红灯）：
 * - 动作项区新增「新建 worktree…」（data-testid="action-create-worktree"）
 * - 仅当 isBareWorkspace===true 时 v-if 显示（非 bare repo 不显示）
 * - 点击 emit 'create-worktree' 事件
 * - 位置：放在「打开文件夹」（action-open-dir）与「远程连接」（action-remote）之间
 *
 * 覆盖：
 * - DP-1: isBareWorkspace=true → action-create-worktree 存在（DOM 断言）
 * - DP-2: isBareWorkspace=false → action-create-worktree 不存在（DOM 断言）
 * - DP-3: 点击 action-create-worktree → emit 'create-worktree'
 * - DP-4: 动作项顺序——action-create-worktree 在 action-open-dir 之后、action-remote 之前
 *
 * Mock 策略：参考 dir-select-popover-workspace.test.ts。mock workspaceStore 控 records；
 * isBareWorkspace 通过 prop 注入（DirSelectPopover 待加 prop `isBareWorkspace?: boolean`）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/dir-select-popover-worktree.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'

// mock workspaceStore（vi.mock 自动 hoist）
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

describe('DP-1: isBareWorkspace=true → action-create-worktree 存在', () => {
  it('bare repo 下渲染「新建 worktree…」动作项', () => {
    setupWorkspaceStore([mkRecord('/repo-a', 300)])
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null, isBareWorkspace: true },
    })
    expect(wrapper.find('[data-testid="action-create-worktree"]').exists()).toBe(true)
  })
})

describe('DP-2: isBareWorkspace=false → action-create-worktree 不存在', () => {
  it('非 bare repo 下隐藏「新建 worktree…」动作项', () => {
    setupWorkspaceStore([mkRecord('/repo-a', 300)])
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null, isBareWorkspace: false },
    })
    expect(wrapper.find('[data-testid="action-create-worktree"]').exists()).toBe(false)
  })

  it('未传 isBareWorkspace（缺省）→ 默认不显示（非 bare 兜底）', () => {
    setupWorkspaceStore([mkRecord('/repo-a', 300)])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(wrapper.find('[data-testid="action-create-worktree"]').exists()).toBe(false)
  })
})

describe('DP-3: 点击 action-create-worktree → emit create-worktree', () => {
  it('点击动作项 emit 单 payload 对象（空 payload）', async () => {
    setupWorkspaceStore([mkRecord('/repo-a', 300)])
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null, isBareWorkspace: true },
    })
    await wrapper.find('[data-testid="action-create-worktree"]').trigger('click')
    expect(wrapper.emitted('create-worktree')).toBeTruthy()
    // emit 一次（防重复触发断言）
    expect(wrapper.emitted('create-worktree')).toHaveLength(1)
  })
})

describe('DP-4: 动作项顺序——create-worktree 在 open-dir 之后、remote 之前', () => {
  it('DOM 顺序：action-open-dir → action-create-worktree → action-remote', () => {
    setupWorkspaceStore([mkRecord('/repo-a', 300)])
    const wrapper = mount(DirSelectPopover, {
      props: { currentCwd: null, isBareWorkspace: true },
    })
    const openDir = wrapper.find('[data-testid="action-open-dir"]').element
    const createWorktree = wrapper.find('[data-testid="action-create-worktree"]').element
    const remote = wrapper.find('[data-testid="action-remote"]').element

    // create-worktree 必须在 open-dir 之后（DOM 顺序）
    expect(
      openDir.compareDocumentPosition(createWorktree) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    // create-worktree 必须在 remote 之前（即 remote 在 create-worktree 之后）
    expect(
      createWorktree.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
  })
})
