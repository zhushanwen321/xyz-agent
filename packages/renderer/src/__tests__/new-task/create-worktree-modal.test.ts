/**
 * CreateWorktreeModal 组件单测（T5 升级版）。
 *
 * 组件契约（T5 spec）：
 * - 五态：form / progress / success / error / exists（内部状态机管理）
 * - Git 仓库选择器：bare-workspace 只读 + badge / plain-repo 可更换 / not-repo 禁用
 * - base branch 可搜索 combobox（Popover + Input + 分组列表）
 * - 创建位置 radio 选项（bare-workspace 仅 workspace / plain-repo 两个选项）
 * - workspaceHint + locationMode 透传到 worktreeApi.create
 * - props：可选 initialBranch
 * - emits：close / success(cwd) / use-existing(cwd)
 *
 * 三视角覆盖（每条 it 至少一个 DOM 断言）：
 * - 构建者视角（白盒/状态）：CM-1~CM-10，断言状态切换、emit、API 调用
 * - 使用者视角（黑盒/DOM）：CM-11~CM-14，断言 DOM 可见结构
 * - 观察者视角（首屏冒烟）：CM-15，mount 不崩 + form DOM 完整
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/create-worktree-modal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

/**
 * worktreeApi mock：create / listBranches 返回可控 Promise。
 */
const worktreeApiMockHolder = vi.hoisted(() => ({
  create: vi.fn(),
  listBranches: vi.fn(),
}))

vi.mock('@/api/domains/worktree', () => ({
  worktreeApi: {
    create: worktreeApiMockHolder.create,
    listBranches: worktreeApiMockHolder.listBranches,
  },
}))

/**
 * workspaceApi mock：detect 返回三态。
 */
const workspaceMockHolder = vi.hoisted(() => ({
  detect: vi.fn(),
}))

vi.mock('@/api/domains/workspace', () => ({
  detect: workspaceMockHolder.detect,
}))

/**
 * pickDirectory mock：OS 原生目录选择器。
 */
const pickDirectoryMockHolder = vi.hoisted(() => ({
  pickDirectory: vi.fn(),
}))

vi.mock('@/lib/ipc', () => ({
  pickDirectory: pickDirectoryMockHolder.pickDirectory,
}))

/**
 * useNewTaskFlow mock：组件读 flow.currentCwd / flow.gitInfo。
 */
const flowMockHolder = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }))

vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => flowMockHolder.current,
  resetNewTaskFlow: vi.fn(),
}))

import { ref, readonly } from 'vue'
import type { Ref, DeepReadonly } from 'vue'
import CreateWorktreeModal from '@/components/new-task/CreateWorktreeModal.vue'

// import 后构建 reactive flow mock
const flowCwd: Ref<string | null> = ref('/workspace')
const flowBranch: Ref<string> = ref('main')

/** 测试直接控制的 flow mock */
const flowMock = {
  currentCwd: flowCwd,
  gitInfo: readonly(ref({ branch: 'main', isRepo: true, isBare: true })) as unknown as DeepReadonly<
    Ref<{ branch: string; isRepo: boolean; isBare: boolean } | null>
  >,
  _branch: flowBranch,
}
flowMockHolder.current = flowMock

/** 默认 workspace.detect 返回值（bare-workspace 模式） */
const defaultDetectResult = {
  mode: 'bare-workspace' as const,
  wsRoot: '/workspace',
  barePath: '/workspace/.bare',
  repoRoot: '/workspace',
  defaultBranch: 'main',
}

/** 默认 worktreeApi.listBranches 返回值 */
const defaultBranchesResult = {
  local: ['main', 'feat-x', 'feat-y'],
  remote: ['origin/main', 'origin/feat-x', 'origin/develop'],
  defaultBranch: 'main',
}

/** 在 Dialog teleport 目标（document.body）中查找元素 */
function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  if (!node) throw new Error(`选择器未匹配: ${selector}`)
  return new DOMWrapper(node)
}
function has(selector: string): boolean {
  return document.body.querySelector(selector) !== null
}

let currentWrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  worktreeApiMockHolder.create.mockReset()
  worktreeApiMockHolder.listBranches.mockReset()
  workspaceMockHolder.detect.mockReset()
  pickDirectoryMockHolder.pickDirectory.mockReset()

  // 默认实现
  worktreeApiMockHolder.create.mockResolvedValue({ cwd: '/workspace/.worktrees/feat-x', branch: 'feat-x' })
  worktreeApiMockHolder.listBranches.mockResolvedValue(defaultBranchesResult)
  workspaceMockHolder.detect.mockResolvedValue(defaultDetectResult)
  pickDirectoryMockHolder.pickDirectory.mockResolvedValue({ canceled: false, path: '/new-repo' })

  flowCwd.value = '/workspace'
  flowMock._branch.value = 'main'
})

afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
  document.body.innerHTML = ''
})

/** mount 组件（attachTo body 让 Dialog teleport 可见） */
async function mountModal(props?: Record<string, unknown>): Promise<void> {
  currentWrapper = mount(CreateWorktreeModal, { attachTo: document.body, props })
  await flushPromises()
}

// ============================================================================
// 构建者视角（白盒/状态）—— CM-1 ~ CM-10
// ============================================================================

describe('CreateWorktreeModal 构建者视角（状态机）', () => {
  it('CM-1: 默认进 form 态，bare-workspace 模式下显示仓库路径 + badge', async () => {
    await mountModal()
    // form 态：分支名 input 可见
    expect(has('[data-testid="worktree-branch-input"]')).toBe(true)
    // bare-workspace 模式：显示 repo-bare 区域 + badge
    expect(has('[data-testid="repo-bare"]')).toBe(true)
    expect(has('[data-testid="repo-bare-badge"]')).toBe(true)
    expect($('[data-testid="repo-bare-badge"]').text()).toContain('bare-workspace')
  })

  it('CM-1b: plain-repo 模式下显示仓库路径 + 更换按钮', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/my-repo',
      defaultBranch: 'develop',
    })
    await mountModal()
    expect(has('[data-testid="repo-plain"]')).toBe(true)
    expect(has('[data-testid="repo-change-btn"]')).toBe(true)
  })

  it('CM-1c: not-repo 模式下显示禁用提示', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'not-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '',
      defaultBranch: '',
    })
    await mountModal()
    expect(has('[data-testid="repo-not-repo"]')).toBe(true)
  })

  it('CM-2: 输入分支名后目录名预览实时更新（feat/oauth → feat-oauth）', async () => {
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('feat/oauth')
    await flushPromises()
    expect($('[data-testid="worktree-dir-preview"]').text()).toContain('feat-oauth')
  })

  it('CM-3: 分支名空 → 创建 disabled', async () => {
    await mountModal()
    await flushPromises()
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
  })

  it('CM-4: 分支名非法 → input danger + error 提示 + 创建 disabled', async () => {
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('a..b')
    await flushPromises()
    expect(has('[data-testid="worktree-branch-error"]')).toBe(true)
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
    const inputCls = $('[data-testid="worktree-branch-input"]').classes().join(' ')
    expect(/border-(destructive|danger)/.test(inputCls)).toBe(true)
  })

  it('CM-4b: 分支名含空格 → error + disabled', async () => {
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('a b')
    await flushPromises()
    expect(has('[data-testid="worktree-branch-error"]')).toBe(true)
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
  })

  it('CM-4c: 分支名开头 - → error + disabled', async () => {
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('-x')
    await flushPromises()
    expect(has('[data-testid="worktree-branch-error"]')).toBe(true)
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
  })

  it('CM-4d: 分支名含 ~ → error + disabled', async () => {
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('a~b')
    await flushPromises()
    expect(has('[data-testid="worktree-branch-error"]')).toBe(true)
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
  })

  it('CM-4e: 分支名含反斜杠 → error + disabled', async () => {
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('a\\b')
    await flushPromises()
    expect(has('[data-testid="worktree-branch-error"]')).toBe(true)
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
  })

  it('CM-5: 点创建 → 进 progress 态 → 调 worktreeApi.create（bare-workspace 模式 locationMode=workspace）', async () => {
    let _resolve!: (v: { cwd: string; branch: string }) => void
    worktreeApiMockHolder.create.mockImplementationOnce(
      () => new Promise((r) => { _resolve = r }),
    )
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-loading-bar"]')).toBe(true)
    expect(worktreeApiMockHolder.create).toHaveBeenCalledTimes(1)
    expect(worktreeApiMockHolder.create).toHaveBeenCalledWith({
      branch: 'feat/x',
      baseBranch: 'origin/main',
      locationMode: 'workspace',
      workspaceHint: '/workspace',
    })
    _resolve({ cwd: '/workspace/.worktrees/feat-x', branch: 'feat-x' })
    await flushPromises()
  })

  it('CM-5b: plain-repo 模式创建时传入 dedicated-dir locationMode', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/my-repo',
      defaultBranch: 'main',
    })
    worktreeApiMockHolder.create.mockResolvedValueOnce({ cwd: '/my-repo/.worktrees/feat-x', branch: 'feat-x' })
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(worktreeApiMockHolder.create).toHaveBeenCalledWith({
      branch: 'feat/x',
      baseBranch: 'origin/main',
      locationMode: 'dedicated-dir',
      workspaceHint: '/my-repo',
    })
  })

  it('CM-6: worktreeApi.create 成功 → 进 success 态 → 2s 后 emit success(cwd)', async () => {
    vi.useFakeTimers()
    try {
      worktreeApiMockHolder.create.mockResolvedValueOnce({ cwd: '/workspace/.worktrees/feat-x', branch: 'feat-x' })
      await mountModal()
      await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
      await flushPromises()
      await $('[data-testid="worktree-create-btn"]').trigger('click')
      await flushPromises()
      expect(has('[data-testid="worktree-success"]')).toBe(true)
      vi.advanceTimersByTime(1999)
      expect(currentWrapper!.emitted('success')).toBeFalsy()
      vi.advanceTimersByTime(1)
      expect(currentWrapper!.emitted('success')).toHaveLength(1)
      expect(currentWrapper!.emitted('success')![0]).toEqual(['/workspace/.worktrees/feat-x'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('CM-7: worktreeApi.create 失败(SETUP_FAILED) → 进 error 态 → 显示退出码+stderr', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('setup script failed'), {
        code: 'SETUP_FAILED',
        exitCode: 1,
        stderr: 'npm: command not found',
      }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-step-failed"]')).toBe(true)
    expect(has('[data-testid="worktree-error-output"]')).toBe(true)
    expect($('[data-testid="worktree-error-output"]').text()).toContain('npm: command not found')
  })

  it('CM-7b: worktreeApi.create 失败(GIT_FAILED) → 进 error 态', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('git worktree add failed'), {
        code: 'GIT_FAILED',
        exitCode: 128,
        stderr: 'fatal: not a valid object name',
      }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-step-failed"]')).toBe(true)
    expect($('[data-testid="worktree-step-failed"]').text()).toContain('128')
    expect(has('[data-testid="worktree-error-output"]')).toBe(true)
    expect($('[data-testid="worktree-error-output"]').text()).toContain('fatal: not a valid object name')
  })

  it('CM-7c: worktreeApi.create 失败(NOT_BARE_REPO) → 进 error 态 → 无 stderr 时显 message fallback', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('当前目录不在 .bare workspace 下'), { code: 'NOT_BARE_REPO' }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-step-failed"]')).toBe(true)
    expect(has('[data-testid="worktree-error-output"]')).toBe(true)
    expect($('[data-testid="worktree-error-output"]').text()).toContain('当前目录不在 .bare workspace 下')
  })

  it('CM-8: worktreeApi.create 失败(WORKTREE_EXISTS) → 进 exists 态', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('worktree exists'), { code: 'WORKTREE_EXISTS', cwd: '/workspace/.worktrees/feat-x' }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-exists-notice"]')).toBe(true)
  })

  it('CM-9: error 态点重试 → 回 progress 态重新调 worktreeApi.create', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('setup script failed'), { code: 'SETUP_FAILED', exitCode: 1, stderr: 'err' }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-retry-btn"]')).toBe(true)
    worktreeApiMockHolder.create.mockResolvedValueOnce({ cwd: '/workspace/.worktrees/feat-x', branch: 'feat-x' })
    await $('[data-testid="worktree-retry-btn"]').trigger('click')
    await flushPromises()
    expect(worktreeApiMockHolder.create).toHaveBeenCalledTimes(2)
    expect(has('[data-testid="worktree-success"]')).toBe(true)
  })

  it('CM-10: exists 态点「直接开始」→ emit use-existing(cwd)', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('worktree exists'), { code: 'WORKTREE_EXISTS', cwd: '/workspace/.worktrees/feat-x' }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    await $('[data-testid="worktree-use-existing-btn"]').trigger('click')
    await flushPromises()
    expect(currentWrapper!.emitted('use-existing')).toHaveLength(1)
    expect(currentWrapper!.emitted('use-existing')![0]).toEqual(['/workspace/.worktrees/feat-x'])
  })
})

// ============================================================================
// 使用者视角（黑盒/DOM 可见断言）—— CM-11 ~ CM-14
// ============================================================================

describe('CreateWorktreeModal 使用者视角（DOM 可见）', () => {
  it('CM-11: bare-workspace form 态 DOM 含仓库选择器 + 分支名 input + base combobox + 创建位置 + 创建按钮', async () => {
    await mountModal()
    // 仓库选择器
    expect(has('[data-testid="repo-bare"]')).toBe(true)
    expect(has('[data-testid="repo-bare-badge"]')).toBe(true)
    // 分支名
    expect(has('[data-testid="worktree-branch-input"]')).toBe(true)
    // base combobox trigger
    expect(has('[data-testid="worktree-base-trigger"]')).toBe(true)
    // 创建位置（bare-workspace 只有 workspace 选项）
    expect(has('[data-testid="location-workspace"]')).toBe(true)
    expect(has('[data-testid="location-repo-dir"]')).toBe(false)
    expect(has('[data-testid="location-dedicated-dir"]')).toBe(false)
    // 按钮
    expect(has('[data-testid="worktree-create-btn"]')).toBe(true)
    expect(has('[data-testid="worktree-cancel-btn"]')).toBe(true)
  })

  it('CM-11b: plain-repo form 态 DOM 含仓库更换按钮 + 两个位置选项 + 推荐 badge', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/my-repo',
      defaultBranch: 'main',
    })
    await mountModal()
    // 仓库选择器：plain-repo 模式
    expect(has('[data-testid="repo-plain"]')).toBe(true)
    expect(has('[data-testid="repo-change-btn"]')).toBe(true)
    // 创建位置：两个选项
    expect(has('[data-testid="location-repo-dir"]')).toBe(true)
    expect(has('[data-testid="location-dedicated-dir"]')).toBe(true)
    // 推荐 badge（dedicated-dir 默认选中）
    expect(has('[data-testid="location-recommended-badge"]')).toBe(true)
  })

  it('CM-11c: not-repo 模式下分支名 input 禁用', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'not-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '',
      defaultBranch: '',
    })
    await mountModal()
    expect(has('[data-testid="repo-not-repo"]')).toBe(true)
    // not-repo 模式：input 禁用
    expect($('[data-testid="worktree-branch-input"]').attributes('disabled')).toBeDefined()
  })

  it('CM-12: progress 态 DOM 含 3 步列表 + loading bar', async () => {
    let _resolve!: (v: { cwd: string; branch: string }) => void
    worktreeApiMockHolder.create.mockImplementationOnce(
      () => new Promise((r) => { _resolve = r }),
    )
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-step-0"]')).toBe(true)
    expect(has('[data-testid="worktree-step-1"]')).toBe(true)
    expect(has('[data-testid="worktree-step-2"]')).toBe(true)
    expect(has('[data-testid="worktree-loading-bar"]')).toBe(true)
    _resolve({ cwd: '/workspace/.worktrees/feat-x', branch: 'feat-x' })
    await flushPromises()
  })

  it('CM-13: error 态 DOM 含错误输出 + 重试按钮（文案含「重试」）', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('setup script failed'), { code: 'SETUP_FAILED', exitCode: 1, stderr: 'boom' }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-error-output"]')).toBe(true)
    expect(has('[data-testid="worktree-retry-btn"]')).toBe(true)
    expect($('[data-testid="worktree-retry-btn"]').text()).toContain('重试')
    const retryCls = $('[data-testid="worktree-retry-btn"]').classes().join(' ')
    expect(/(primary|default)/i.test(retryCls)).toBe(true)
    expect(has('[data-testid="worktree-cleanup-btn"]')).toBe(true)
  })

  it('CM-14: exists 态 DOM 含「已存在」提示 + 「直接开始」按钮', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('worktree exists'), { code: 'WORKTREE_EXISTS', cwd: '/workspace/.worktrees/feat-x' }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    expect(has('[data-testid="worktree-exists-notice"]')).toBe(true)
    expect($('[data-testid="worktree-exists-notice"]').text()).toContain('已存在')
    expect(has('[data-testid="worktree-use-existing-btn"]')).toBe(true)
    expect($('[data-testid="worktree-use-existing-btn"]').text()).toContain('直接')
  })
})

// ============================================================================
// 观察者视角（首屏冒烟）—— CM-15
// ============================================================================

describe('CreateWorktreeModal 观察者视角（首屏冒烟）', () => {
  it('CM-15: 首屏渲染 form 态 DOM 含仓库选择器 + 分支名 input + base combobox + 创建位置 + 创建按钮', async () => {
    await mountModal()
    // mount 不崩 + form 关键元素齐全
    expect(has('[data-testid="repo-bare"]')).toBe(true)
    expect(has('[data-testid="worktree-branch-input"]')).toBe(true)
    expect(has('[data-testid="worktree-base-trigger"]')).toBe(true)
    expect(has('[data-testid="location-workspace"]')).toBe(true)
    expect(has('[data-testid="worktree-create-btn"]')).toBe(true)
    expect(has('[data-testid="worktree-dir-preview"]')).toBe(true)
  })
})

// ============================================================================
// base combobox 分支列表
// ============================================================================

describe('CreateWorktreeModal base combobox', () => {
  it('CM-16: 打开 combobox popover 后显示分组分支列表', async () => {
    await mountModal()
    // 点击 trigger 打开 popover
    await $('[data-testid="worktree-base-trigger"]').trigger('click')
    await flushPromises()
    // 搜索框可见
    expect(has('[data-testid="worktree-base-search"]')).toBe(true)
    // 分支项可见
    expect(has('[data-testid="worktree-base-item"]')).toBe(true)
  })

  it('CM-17: 选择分支后 base 更新 + popover 关闭', async () => {
    await mountModal()
    await $('[data-testid="worktree-base-trigger"]').trigger('click')
    await flushPromises()
    // 选择 origin/develop
    const items = document.body.querySelectorAll('[data-testid="worktree-base-item"]')
    const developItem = Array.from(items).find((el) => el.getAttribute('data-branch') === 'origin/develop')
    expect(developItem).toBeTruthy()
    await (developItem as HTMLElement).click()
    await flushPromises()
    // popover 关闭后 trigger 应显示选中值
    expect($('[data-testid="worktree-base-trigger"]').text()).toContain('origin/develop')
  })

  it('CM-18: 搜索过滤分支列表', async () => {
    await mountModal()
    await $('[data-testid="worktree-base-trigger"]').trigger('click')
    await flushPromises()
    // 搜索 'feat'
    await $('[data-testid="worktree-base-search"]').setValue('feat')
    await flushPromises()
    // 只显示 feat 相关分支
    const items = document.body.querySelectorAll('[data-testid="worktree-base-item"]')
    const names = Array.from(items).map((el) => el.getAttribute('data-branch'))
    // 应包含 feat-x 和 feat-y（可能在不同分组），不应包含 main/develop
    expect(names.some((n) => n?.includes('feat'))).toBe(true)
    expect(names.every((n) => n?.toLowerCase().includes('feat'))).toBe(true)
  })
})

// ============================================================================
// 创建位置 radio
// ============================================================================

describe('CreateWorktreeModal 创建位置 radio', () => {
  it('CM-19: bare-workspace 模式只显示 workspace 选项', async () => {
    await mountModal()
    expect(has('[data-testid="location-workspace"]')).toBe(true)
    expect(has('[data-testid="location-repo-dir"]')).toBe(false)
    expect(has('[data-testid="location-dedicated-dir"]')).toBe(false)
  })

  it('CM-20: plain-repo 模式显示两个选项，dedicated-dir 默认选中', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/my-repo',
      defaultBranch: 'main',
    })
    await mountModal()
    expect(has('[data-testid="location-repo-dir"]')).toBe(true)
    expect(has('[data-testid="location-dedicated-dir"]')).toBe(true)
    // dedicated-dir 默认选中（radio checked）
    const dedicatedRadio = $('[data-testid="location-dedicated-dir"]').find('input[type="radio"]')
    expect((dedicatedRadio.element as HTMLInputElement).checked).toBe(true)
  })

  it('CM-21: plain-repo 模式切换位置选项', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/my-repo',
      defaultBranch: 'main',
    })
    await mountModal()
    // 点击 repo-dir radio
    const repoDirRadio = $('[data-testid="location-repo-dir"]').find('input[type="radio"]')
    await repoDirRadio.trigger('change')
    await flushPromises()
    // repo-dir 现在应被选中
    expect((repoDirRadio.element as HTMLInputElement).checked).toBe(true)
  })
})

// ============================================================================
// 仓库更换目录（plain-repo 模式）
// ============================================================================

describe('CreateWorktreeModal 仓库更换', () => {
  it('CM-22: plain-repo 模式点更换按钮 → 调 pickDirectory → 重新检测', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/my-repo',
      defaultBranch: 'main',
    })
    // pickDirectory 返回新目录
    pickDirectoryMockHolder.pickDirectory.mockResolvedValueOnce({ canceled: false, path: '/new-repo' })
    // 新目录的 detect 结果
    workspaceMockHolder.detect.mockResolvedValueOnce({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/new-repo',
      defaultBranch: 'develop',
    })
    await mountModal()
    await $('[data-testid="repo-change-btn"]').trigger('click')
    await flushPromises()
    // pickDirectory 被调用
    expect(pickDirectoryMockHolder.pickDirectory).toHaveBeenCalled()
    // detect 被再次调用（初始 + 更换）
    expect(workspaceMockHolder.detect).toHaveBeenCalledTimes(2)
    expect(workspaceMockHolder.detect).toHaveBeenLastCalledWith('/new-repo')
  })

  it('CM-23: pickDirectory 取消 → 不变更', async () => {
    workspaceMockHolder.detect.mockResolvedValue({
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '/my-repo',
      defaultBranch: 'main',
    })
    pickDirectoryMockHolder.pickDirectory.mockResolvedValueOnce({ canceled: true, path: null })
    await mountModal()
    await $('[data-testid="repo-change-btn"]').trigger('click')
    await flushPromises()
    // detect 只调一次（初始），没有第二次
    expect(workspaceMockHolder.detect).toHaveBeenCalledTimes(1)
  })
})
