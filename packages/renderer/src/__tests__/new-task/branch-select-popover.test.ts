/**
 * BranchSelectPopover 组件单测（#6，T4.3/T4.6/T4.9）。
 *
 * IA 重构（spec §3.3）后：按 git 模式裁剪 panel，tab bar 删除。
 * - plain-repo 模式：渲染分支 panel（onMounted 调 worktreeApi.listBranches(cwd) 拉分支列表）
 * - bare-workspace 模式：渲染 Worktree panel（不拉分支，数据从 worktreeItems prop 传入）
 *
 * 覆盖：
 * - T4.3 unborn HEAD（plain-repo + local=[]）→ 空态文案引导首次 commit
 * - T4.6 listBranches reject → 显错不崩，列表空
 * - T4.9 分支 100+ → 渲染节点数受限（上限 50）+ 搜索过滤命中
 * - 分支 panel 动作（选/confirm-dirty/open-branch-modal）+ Worktree panel 动作（select-worktree/create-worktree）
 *
 * mock 策略：vi.mock('@/api/domains/worktree') → worktreeApi.listBranches 返回可控 local/remote/defaultBranch / reject。
 * 组件 onMounted 在 plain-repo 模式才真调 listBranches(cwd)，动作走 emit。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/branch-select-popover.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import BranchSelectPopover from '@/components/new-task/BranchSelectPopover.vue'

const listBranchesMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/domains/worktree', () => ({
  worktreeApi: {
    listBranches: (...args: unknown[]) => listBranchesMock(...(args as [string])),
    list: vi.fn(),
    create: vi.fn(),
  },
}))

/** Worktree panel 列表项类型（与组件 worktreeItems prop 一致） */
type WorktreeItem = { path: string; branch: string; HEAD: boolean; bare: boolean }

function mkWorktreeItem(
  over: Partial<WorktreeItem> = {},
): WorktreeItem {
  return { path: '/ws/main', branch: 'main', HEAD: false, bare: false, ...over }
}

beforeEach(() => {
  listBranchesMock.mockReset()
})

describe('BranchSelectPopover unborn HEAD（T4.3）', () => {
  it('plain-repo 无分支（local=[]）→ 空态文案 + 引导首次 commit', async () => {
    listBranchesMock.mockResolvedValue({ local: [], remote: [], defaultBranch: '' })
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'plain-repo', cwd: '/repo' },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('无分支')
    expect(wrapper.text()).toContain('commit')
    expect(wrapper.findAll('[data-testid="branch-item"]')).toHaveLength(0)
  })
})

describe('BranchSelectPopover listBranches 失败（T4.6）', () => {
  it('plain-repo + listBranches reject → 显错不崩，分支列表空', async () => {
    listBranchesMock.mockRejectedValue(new Error('exec fail'))
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'plain-repo', cwd: '/repo' },
    })
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
    listBranchesMock.mockResolvedValue({ local: branches, remote: [], defaultBranch: 'branch-0' })
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'plain-repo', cwd: '/repo', currentBranch: 'branch-0' },
    })
    await flushPromises()
    const items = wrapper.findAll('[data-testid="branch-item"]')
    expect(items.length).toBeLessThanOrEqual(50)
    expect(items.length).toBeLessThan(120)
  })

  it('搜索过滤命中（输入关键词仅渲染命中项）', async () => {
    const branches = Array.from({ length: 120 }, (_, i) => `branch-${i}`)
    listBranchesMock.mockResolvedValue({ local: branches, remote: [], defaultBranch: 'branch-0' })
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'plain-repo', cwd: '/repo', currentBranch: 'branch-0' },
    })
    await flushPromises()
    await wrapper.find('input').setValue('branch-99')
    const filtered = wrapper.findAll('[data-testid="branch-item"]')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].text()).toContain('branch-99')
  })
})

describe('BranchSelectPopover 选分支 emit', () => {
  it('选干净分支 → emit select 单 payload { name }', async () => {
    listBranchesMock.mockResolvedValue({ local: ['main', 'feature'], remote: [], defaultBranch: 'main' })
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'plain-repo', cwd: '/repo', currentBranch: 'main' },
    })
    await flushPromises()
    await wrapper.findAll('[data-testid="branch-item"]')[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([[{ name: 'feature' }]])
  })

  it('点击「创建并检出新分支」→ emit open-branch-modal', async () => {
    listBranchesMock.mockResolvedValue({ local: ['main'], remote: [], defaultBranch: 'main' })
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'plain-repo', cwd: '/repo', currentBranch: 'main' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="action-create-branch"]').trigger('click')
    expect(wrapper.emitted('open-branch-modal')).toBeTruthy()
  })

  it('点击「创建 worktree」→ emit create-worktree', async () => {
    listBranchesMock.mockResolvedValue({ local: ['main'], remote: [], defaultBranch: 'main' })
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'plain-repo', cwd: '/repo', currentBranch: 'main' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="action-create-worktree"]').trigger('click')
    expect(wrapper.emitted('create-worktree')).toBeTruthy()
  })

  it('点击「Git 图谱」→ toast stub（不崩，不 emit 业务事件）', async () => {
    listBranchesMock.mockResolvedValue({ local: ['main'], remote: [], defaultBranch: 'main' })
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'plain-repo', cwd: '/repo', currentBranch: 'main' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="action-git-graph"]').trigger('click')
    // v1 stub：不 emit 业务事件，仅 toast（toast 由 useToast 处理，这里只验证不崩）
    expect(wrapper.find('[data-testid="branch-select-popover"]').exists()).toBe(true)
  })
})

/**
 * Worktree panel（bare-workspace 模式）行为。
 *
 * bare-workspace 模式只渲染 Worktree panel，数据从 worktreeItems prop 传入（不调 listBranches）。
 * tab bar 已删除——直接进 Worktree panel。
 */
describe('BranchSelectPopover Worktree panel（bare-workspace）', () => {
  it('worktreeItems 非空 → 渲染列表 + action-create-worktree（accent-soft 强调）', async () => {
    const worktreeItems = [
      mkWorktreeItem({ path: '/ws/feat-a', branch: 'feat-a' }),
      mkWorktreeItem({ path: '/ws/feat-b', branch: 'feat-b' }),
      mkWorktreeItem({ path: '/ws/feat-c', branch: 'feat-c' }),
    ]
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'bare-workspace', cwd: '/ws', worktreeItems },
    })
    await flushPromises()

    // worktree panel 渲染 3 个列表项
    const items = wrapper.findAll('[data-testid="worktree-item"]')
    expect(items).toHaveLength(3)
    expect(items[0].text()).toContain('feat-a')

    // 底部 action-create-worktree 存在且 class 含 accent-soft（bare-workspace 推荐入口强调）
    const action = wrapper.find('[data-testid="action-create-worktree"]')
    expect(action.exists()).toBe(true)
    expect(action.attributes('class') ?? '').toContain('accent-soft')
  })

  it('worktreeItems=[] → 渲染 wt-empty-state，action-create-worktree 仍在', async () => {
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'bare-workspace', cwd: '/ws', worktreeItems: [] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="wt-empty-state"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="worktree-item"]')).toHaveLength(0)
    // 空态下「新建 worktree」入口仍在（Primary 动作）
    expect(wrapper.find('[data-testid="action-create-worktree"]').exists()).toBe(true)
  })

  it('选中 worktree → emit select-worktree 单 payload { path }', async () => {
    const worktreeItems = [
      mkWorktreeItem({ path: '/x/main', branch: 'main', HEAD: true, bare: true }),
      mkWorktreeItem({ path: '/x/dev', branch: 'dev' }),
    ]
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'bare-workspace', cwd: '/ws', worktreeItems },
    })
    await flushPromises()

    await wrapper.findAll('[data-testid="worktree-item"]')[0].trigger('click')
    expect(wrapper.emitted('select-worktree')).toEqual([[{ path: '/x/main' }]])
  })

  it('点「新建 worktree」→ emit create-worktree', async () => {
    const wrapper = mount(BranchSelectPopover, {
      props: { mode: 'bare-workspace', cwd: '/ws', worktreeItems: [] },
    })
    await flushPromises()
    await wrapper.find('[data-testid="action-create-worktree"]').trigger('click')
    expect(wrapper.emitted('create-worktree')).toBeTruthy()
    expect(wrapper.emitted('create-worktree')).toHaveLength(1)
  })
})
