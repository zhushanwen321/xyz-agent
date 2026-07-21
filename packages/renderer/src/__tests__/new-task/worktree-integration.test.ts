/**
 * worktree 端到端集成测试 —— TDD 红灯阶段（AC-1/2/4/5/6）。
 *
 * 测完整链路：Landing → DirSelectPopover → 点「新建 worktree」→ CreateWorktreeModal
 * → 填表 → 创建 → success → chip 切换。组件实现未写（CreateWorktreeModal / worktreeApi /
 * flow.createWorktree 等均不存在），本文件先红灯——属 TDD 正常状态。
 *
 * 覆盖（使用者视角，DOM 断言 MANDATORY）：
 * - INT-1: 完整成功流程——mount Landing（mock isBareWorkspace=true）→ 打开 DirSelectPopover
 *          → 点「新建 worktree」→ CreateWorktreeModal 出现 → 填分支名 → 点创建 → progress
 *          → worktreeApi.create resolve → success → 2s 后 modal 关闭 + directory chip 切到新 worktree
 * - INT-2: 目录已存在——worktreeApi.create reject(WORKTREE_EXISTS) → modal 转 exists 态
 *          → 点「直接开始」→ directory chip 切到 existingCwd
 * - INT-3: 创建失败——worktreeApi.create reject(SETUP_FAILED) → modal 转 error 态
 *          → 显示退出码+stderr → 点重试 → 重新调 worktreeApi.create
 *
 * Mock 策略：
 * - vi.mock('@/api/domains/worktree') mock worktreeApi（控制 create resolve/reject）
 * - vi.mock('@/composables/features/useNewTaskFlow') mock flow（控制 state / gitInfo / selectWorkspace 等）
 * - 参考 flow-integration.test.ts 完整 mount + mock 模式
 *
 * 注意：CreateWorktreeModal 用 reka-ui Dialog（teleport 到 document.body），
 * DOM 查询走 document.body（@vue/test-utils 的 wrapper.find 不穿透 teleport）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/worktree-integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, readonly } from 'vue'
import type { Ref, DeepReadonly } from 'vue'

// ── worktreeApi mock：控制 create 的 resolve/reject（INT-1/2/3 的核心驱动）──
// CreateWorktreeModal success 态返回新 worktree 的 cwd；exists 态返回已存在 cwd。
// reject 时抛带 code+stderr 的错误（模拟 runtime 的 WorktreeError）。
const worktreeCtrl = vi.hoisted(() => ({
  create: vi.fn(),
}))
vi.mock('@/api/domains/worktree', () => ({
  worktreeApi: {
    create: worktreeCtrl.create,
  },
}))

// ── useNewTaskFlow mock：控制 state/gitInfo/selectWorkspace/currentCwd 等 ──
// 用 hoisted holder：factory 返回 `() => holder.current`（lazy），
// import 后构建 reactive refs 再赋值，组件 computed 才能驱动。
const flowMockHolder = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }))
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => flowMockHolder.current,
  resetNewTaskFlow: vi.fn(),
}))

// ── workspaceStore mock：DirSelectPopover 依赖 records ──
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

// mock useToast 避免真实 i18n / portal 依赖
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))

import Landing from '@/components/new-task/Landing.vue'

// import 后构建 reactive flow mock 态
const flowState: Ref<string> = ref('landing')
const flowCurrentCwd: Ref<string | null> = ref(null)
const flowGitInfo: Ref<{ branch: string; isRepo: boolean; isBare?: boolean } | null> = ref(null)
const flowSelectWorkspace = vi.fn<(cwd: string) => void>()
const flowOpenDirPopover = vi.fn<() => void>()
const flowCloseOverlay = vi.fn<() => void>()
const flowOpenDirDialog = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
const flowOpenCreateWorktree = vi.fn<() => void>()
const flowCreateWorktree = vi.fn<(branch: string) => Promise<void>>().mockResolvedValue(undefined)
const flowStartCreateWorktree = vi.fn<() => void>()

/** 测试直接控制的 flow mock（与组件内 useNewTaskFlow() 返回同一对象） */
const flowMock = {
  state: readonly(flowState) as DeepReadonly<Ref<string>>,
  currentSessionId: readonly(ref(null)) as DeepReadonly<Ref<string | null>>,
  currentCwd: readonly(flowCurrentCwd) as DeepReadonly<Ref<string | null>>,
  currentModel: readonly(ref(null)) as DeepReadonly<Ref<string | null>>,
  gitInfo: readonly(flowGitInfo) as DeepReadonly<Ref<typeof flowGitInfo.value>>,
  isInflight: readonly(ref(false)) as DeepReadonly<Ref<boolean>>,
  isBranchCreating: readonly(ref(false)) as DeepReadonly<Ref<boolean>>,
  isOverlay: readonly(ref(false)) as DeepReadonly<Ref<boolean>>,
  isActive: readonly(ref(false)) as DeepReadonly<Ref<boolean>>,
  selectWorkspace: flowSelectWorkspace,
  openDirPopover: flowOpenDirPopover,
  openDirDialog: flowOpenDirDialog,
  openBranchPopover: vi.fn(),
  selectBranch: vi.fn(),
  confirmDirtySwitch: vi.fn(),
  openBranchModal: vi.fn(),
  submitCreateBranch: vi.fn(),
  // worktree 新增动作（实现未写）
  openCreateWorktree: flowOpenCreateWorktree,
  createWorktree: flowCreateWorktree,
  startCreateWorktree: flowStartCreateWorktree,
  closeOverlay: flowCloseOverlay,
  // 内部 state 直接控制（测试用，下划线前缀标记）
  _state: flowState,
  _currentCwd: flowCurrentCwd,
  _gitInfo: flowGitInfo,
}
flowMockHolder.current = flowMock

/** 在 Dialog teleport 目标（document.body）中查找元素；teleport 内容 wrapper.find 不穿透 */
function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  if (!node) throw new Error(`选择器未匹配: ${selector}`)
  return new DOMWrapper(node)
}
function has(selector: string): boolean {
  return document.body.querySelector(selector) !== null
}

/** Composer stub：渲染 meta-row slot（让 chip 进 DOM 可查），避免拖入真实 Composer 重依赖 */
const landingStubs = {
  Composer: { template: '<div data-testid="composer-stub"><slot name="meta-row" /></div>' },
}

let currentWrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.clearAllMocks()
  // 重置 flow 态：landing / 空 cwd / bare repo gitInfo
  flowMock._state.value = 'landing'
  flowMock._currentCwd.value = null
  flowMock._gitInfo.value = { branch: 'main', isRepo: true, isBare: true }
  // 重置 workspaceStore mock
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
  // 重置 worktreeApi.create：默认成功创建
  worktreeCtrl.create.mockReset()
  worktreeCtrl.create.mockResolvedValue({
    cwd: '/ws/feat-new-thing',
    branch: 'feat-new-thing',
  })
  // 重置 flow worktree 动作
  flowOpenCreateWorktree.mockReset()
  flowCreateWorktree.mockReset().mockResolvedValue(undefined)
  flowStartCreateWorktree.mockReset()
  flowSelectWorkspace.mockReset()
  flowOpenDirPopover.mockReset()
  flowCloseOverlay.mockReset()
})

afterEach(() => {
  // 先 unmount 让 Vue 正常卸载 teleport，再清 body 残留
  currentWrapper?.unmount()
  currentWrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/** mount Landing（mock isBareWorkspace=true 经 gitInfo 注入） */
async function mountLanding(): Promise<ReturnType<typeof mount>> {
  currentWrapper = mount(Landing, {
    props: { sessionId: null, currentCwd: null, gitBranch: null },
    global: { stubs: landingStubs },
    attachTo: document.body,
  })
  await flushPromises()
  return currentWrapper
}

/**
 * 打开 DirSelectPopover（点 directory chip）。
 * Landing 内 Popover open 绑定 flow.state==='dir-popover'，故需切 state 触发渲染。
 */
async function openDirPopover(wrapper: ReturnType<typeof mount>): Promise<void> {
  // 点 chip → flow.openDirPopover()（mock 不真切 state，需测试手动切）
  await wrapper.find('[data-testid="chip-directory"]').trigger('click')
  flowMock._state.value = 'dir-popover'
  await flushPromises()
}

describe('INT-1: 完整成功流程（Landing → popover → modal → 填表 → 创建 → success → chip 切换）', () => {
  it('点击「新建 worktree」→ modal 出现 → 填分支名 → 创建成功 → 2s 后 modal 关闭 + chip 切到新 worktree', async () => {
    const wrapper = await mountLanding()
    await openDirPopover(wrapper)

    // popover 渲染且含「新建 worktree…」动作项（bare repo 下显示）
    expect(wrapper.find('[data-testid="action-create-worktree"]').exists()).toBe(true)

    // 点「新建 worktree…」→ 触发 openCreateWorktree → flow 切到 worktree-modal 态
    await wrapper.find('[data-testid="action-create-worktree"]').trigger('click')
    expect(flowOpenCreateWorktree).toHaveBeenCalled()
    // mock flow 切 worktree-modal 态（CreateWorktreeModal 渲染条件）
    flowMock._state.value = 'worktree-modal'
    await flushPromises()

    // CreateWorktreeModal 出现（teleport 到 body）
    expect(has('[data-testid="create-worktree-modal"]')).toBe(true)

    // 填分支名
    await $('[data-testid="worktree-branch-input"]').setValue('feat-new-thing')
    await flushPromises()

    // worktreeApi.create 默认 resolve（beforeEach 设好）→ 调用前先 mock flow.createWorktree 调 worktreeApi
    // 组件提交会调 flow.createWorktree(branch)，flow 内部调 worktreeApi.create；
    // 这里 mock flow.createWorktree 直接调 worktreeApi.create 模拟真链路
    flowCreateWorktree.mockImplementation(async (branch: string) => {
      const result = await worktreeCtrl.create({ branch })
      flowMock._currentCwd.value = result.cwd
    })

    // 点创建按钮
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()

    // 创建中：worktreeApi.create 被调（progress 态）
    expect(worktreeCtrl.create).toHaveBeenCalledWith({ branch: 'feat-new-thing' })
    // success 态显示（modal 仍在，等 2s 自动关）
    expect(has('[data-testid="worktree-success"]')).toBe(true)

    // 推进 2s → modal 自动关闭
    vi.advanceTimersByTime(2000)
    await flushPromises()

    // modal 关闭（从 DOM 消失）
    expect(has('[data-testid="create-worktree-modal"]')).toBe(false)
    // directory chip 切到新 worktree 的 basename
    expect(wrapper.find('[data-testid="chip-directory"]').text()).toContain('feat-new-thing')
  })
})

describe('INT-2: 目录已存在（worktreeApi.create reject WORKTREE_EXISTS → exists 态 → 直接开始）', () => {
  it('reject WORKTREE_EXISTS → modal 转 exists 态 → 点「直接开始」→ chip 切到 existingCwd', async () => {
    const wrapper = await mountLanding()
    await openDirPopover(wrapper)

    // 进 worktree-modal
    await wrapper.find('[data-testid="action-create-worktree"]').trigger('click')
    flowMock._state.value = 'worktree-modal'
    await flushPromises()
    await $('[data-testid="worktree-branch-input"]').setValue('feat-exists')
    await flushPromises()

    // worktreeApi.create reject：带 code=WORKTREE_EXISTS + existingCwd
    worktreeCtrl.create.mockRejectedValue({
      code: 'WORKTREE_EXISTS',
      existingCwd: '/ws/feat-exists',
      message: 'worktree already exists',
    })
    flowCreateWorktree.mockImplementation(async (branch: string) => {
      try {
        await worktreeCtrl.create({ branch })
      } catch (e) {
        // exists 态：组件捕获错误展示「直接开始」，点后切 cwd
        const err = e as { code: string; existingCwd: string }
        if (err.code === 'WORKTREE_EXISTS') {
          // 暂存 existingCwd 供「直接开始」用（组件内部状态，mock 简化）
          ;(flowCreateWorktree as unknown as { _existingCwd: string })._existingCwd = err.existingCwd
        }
        throw e
      }
    })

    // 点创建 → reject → exists 态
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()

    // modal 转 exists 态：显示「直接开始」入口
    expect(has('[data-testid="worktree-exists"]')).toBe(true)
    expect(has('[data-testid="worktree-start-existing-btn"]')).toBe(true)

    // 点「直接开始」→ chip 切到 existingCwd
    const existingCwd = '/ws/feat-exists'
    flowSelectWorkspace.mockImplementationOnce((cwd: string) => {
      flowMock._currentCwd.value = cwd
    })
    await $('[data-testid="worktree-start-existing-btn"]').trigger('click')
    // mock flow 切回 landing + chip 切 cwd
    flowMock._currentCwd.value = existingCwd
    flowMock._state.value = 'landing'
    await flushPromises()

    // modal 关闭
    expect(has('[data-testid="create-worktree-modal"]')).toBe(false)
    // directory chip 切到已存在 worktree 的 basename
    expect(wrapper.find('[data-testid="chip-directory"]').text()).toContain('feat-exists')
  })
})

describe('INT-3: 创建失败（worktreeApi.create reject SETUP_FAILED → error 态 → 重试）', () => {
  it('reject SETUP_FAILED → modal 转 error 态 → 显示退出码+stderr → 点重试 → 重新调 worktreeApi.create', async () => {
    const wrapper = await mountLanding()
    await openDirPopover(wrapper)

    await wrapper.find('[data-testid="action-create-worktree"]').trigger('click')
    flowMock._state.value = 'worktree-modal'
    await flushPromises()
    await $('[data-testid="worktree-branch-input"]').setValue('feat-fail')
    await flushPromises()

    // worktreeApi.create reject：带 code=SETUP_FAILED + exitCode + stderr
    const setupErr = {
      code: 'SETUP_FAILED',
      exitCode: 128,
      stderr: 'fatal: not a valid object name',
      message: 'git worktree add failed',
    }
    worktreeCtrl.create.mockRejectedValue(setupErr)
    flowCreateWorktree.mockImplementation(async (branch: string) => {
      await worktreeCtrl.create({ branch })
    })

    // 点创建 → reject → error 态
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()

    // modal 转 error 态：显示退出码 + stderr
    expect(has('[data-testid="worktree-error"]')).toBe(true)
    const errorText = $('[data-testid="worktree-error"]').text()
    expect(errorText).toContain('128')
    expect(errorText).toContain('fatal: not a valid object name')

    // 重试：worktreeApi.create 改为成功
    worktreeCtrl.create.mockResolvedValue({
      cwd: '/ws/feat-fail',
      branch: 'feat-fail',
    })
    flowCreateWorktree.mockImplementation(async (branch: string) => {
      const result = await worktreeCtrl.create({ branch })
      flowMock._currentCwd.value = result.cwd
    })

    // 点重试按钮
    await $('[data-testid="worktree-retry-btn"]').trigger('click')
    await flushPromises()

    // worktreeApi.create 被再次调用（重试）
    expect(worktreeCtrl.create).toHaveBeenCalledTimes(2)
    expect(worktreeCtrl.create).toHaveBeenLastCalledWith({ branch: 'feat-fail' })

    // 重试成功 → 进 success 态
    expect(has('[data-testid="worktree-success"]')).toBe(true)

    // 推进 2s → modal 关闭 + chip 切换
    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(has('[data-testid="create-worktree-modal"]')).toBe(false)
    expect(wrapper.find('[data-testid="chip-directory"]').text()).toContain('feat-fail')
  })
})
