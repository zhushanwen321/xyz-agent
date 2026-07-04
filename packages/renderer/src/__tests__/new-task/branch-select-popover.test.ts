/**
 * BranchSelectPopover 组件单测（#6，T4.3/T4.6/T4.9）。
 *
 * 覆盖：
 * - T4.3 unborn HEAD（isRepo=true 无分支）→ 空态文案引导首次 commit
 * - T4.6 getStatus reject → 显错不崩，列表空
 * - T4.9 分支 100+ → 渲染节点数受限（虚拟滚动/上限）+ 搜索过滤命中
 *
 * mock 策略：vi.mock('@/api') → git.status 返回可控 GitStatusResult / reject。
 * 组件 onMounted 真调 gitApi.status，动作（select/confirm-dirty/open-branch-modal）走 emit。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/new-task/branch-select-popover.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { GitStatusResult } from '@xyz-agent/shared'
import BranchSelectPopover from '@/components/new-task/BranchSelectPopover.vue'

const statusMock = vi.hoisted(() => vi.fn())
vi.mock('@/api', () => ({
  git: { status: (...args: unknown[]) => statusMock(...(args as [string])) },
}))

function mkStatus(over: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    sessionId: 's1',
    isRepo: true,
    branch: 'main',
    stagedCount: 0,
    unstagedCount: 0,
    stats: { add: 0, del: 0 },
    hasConflict: false,
    files: [],
    branches: ['main'],
    ...over,
  }
}

beforeEach(() => {
  statusMock.mockReset()
})

describe('BranchSelectPopover unborn HEAD（T4.3）', () => {
  it('isRepo=true 无分支 → 空态文案 + 引导首次 commit', async () => {
    statusMock.mockResolvedValue(mkStatus({ branch: undefined, branches: [] }))
    const wrapper = mount(BranchSelectPopover, { props: { sessionId: 's1' } })
    await flushPromises()
    expect(wrapper.text()).toContain('无分支')
    expect(wrapper.text()).toContain('commit')
    expect(wrapper.findAll('[data-testid="branch-item"]')).toHaveLength(0)
  })
})

describe('BranchSelectPopover getStatus 失败（T4.6）', () => {
  it('status reject → 显错不崩，分支列表空', async () => {
    statusMock.mockRejectedValue(new Error('exec fail'))
    const wrapper = mount(BranchSelectPopover, { props: { sessionId: 's1' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="status-error"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="branch-item"]')).toHaveLength(0)
    // 不崩：组件根仍在
    expect(wrapper.find('[data-testid="branch-select-popover"]').exists()).toBe(true)
  })
})

describe('BranchSelectPopover 虚拟滚动（T4.9）', () => {
  it('分支 100+ → 渲染节点数受限（≤ MAX_RENDER_BRANCHES）', async () => {
    const branches = Array.from({ length: 120 }, (_, i) => `branch-${i}`)
    statusMock.mockResolvedValue(mkStatus({ branches, branch: 'branch-0' }))
    const wrapper = mount(BranchSelectPopover, { props: { sessionId: 's1' } })
    await flushPromises()
    const items = wrapper.findAll('[data-testid="branch-item"]')
    expect(items.length).toBeLessThanOrEqual(50)
    expect(items.length).toBeLessThan(120)
  })

  it('搜索过滤命中（输入关键词仅渲染命中项）', async () => {
    const branches = Array.from({ length: 120 }, (_, i) => `branch-${i}`)
    statusMock.mockResolvedValue(mkStatus({ branches, branch: 'branch-0' }))
    const wrapper = mount(BranchSelectPopover, { props: { sessionId: 's1' } })
    await flushPromises()
    await wrapper.find('input').setValue('branch-99')
    const filtered = wrapper.findAll('[data-testid="branch-item"]')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].text()).toContain('branch-99')
  })
})

describe('BranchSelectPopover 选分支 emit', () => {
  it('选干净分支 → emit select 单 payload { name }', async () => {
    statusMock.mockResolvedValue(
      mkStatus({ branches: ['main', 'feature'], branch: 'main', unstagedCount: 0 }),
    )
    const wrapper = mount(BranchSelectPopover, { props: { sessionId: 's1' } })
    await flushPromises()
    await wrapper.findAll('[data-testid="branch-item"]')[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([[{ name: 'feature' }]])
  })

  it('当前工作区 dirty → 选其它分支弹 inline 确认条，确认 → emit confirm-dirty-switch', async () => {
    statusMock.mockResolvedValue(
      mkStatus({ branches: ['main', 'feature'], branch: 'main', unstagedCount: 3 }),
    )
    const wrapper = mount(BranchSelectPopover, { props: { sessionId: 's1' } })
    await flushPromises()
    // 选 feature（当前 main dirty）→ 弹确认条
    await wrapper.findAll('[data-testid="branch-item"]')[1].trigger('click')
    expect(wrapper.find('[data-testid="dirty-confirm"]').exists()).toBe(true)
    // 未直接 emit select（等确认）
    expect(wrapper.emitted('select')).toBeFalsy()
    // 确认切走
    await wrapper.find('[data-testid="dirty-confirm-ok"]').trigger('click')
    expect(wrapper.emitted('confirm-dirty-switch')).toEqual([[{ name: 'feature' }]])
  })

  it('dirty 确认条取消 → 不 emit，隐藏确认条', async () => {
    statusMock.mockResolvedValue(
      mkStatus({ branches: ['main', 'feature'], branch: 'main', unstagedCount: 3 }),
    )
    const wrapper = mount(BranchSelectPopover, { props: { sessionId: 's1' } })
    await flushPromises()
    await wrapper.findAll('[data-testid="branch-item"]')[1].trigger('click')
    await wrapper.find('[data-testid="dirty-confirm-cancel"]').trigger('click')
    expect(wrapper.emitted('confirm-dirty-switch')).toBeFalsy()
    expect(wrapper.find('[data-testid="dirty-confirm"]').exists()).toBe(false)
  })

  it('点击「创建并检出新分支」→ emit open-branch-modal', async () => {
    statusMock.mockResolvedValue(mkStatus({ branches: ['main'], branch: 'main' }))
    const wrapper = mount(BranchSelectPopover, { props: { sessionId: 's1' } })
    await flushPromises()
    await wrapper.find('[data-testid="action-create-branch"]').trigger('click')
    expect(wrapper.emitted('open-branch-modal')).toBeTruthy()
  })
})
