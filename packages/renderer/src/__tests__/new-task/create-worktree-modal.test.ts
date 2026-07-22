/**
 * CreateWorktreeModal 组件单测（W2 wave，TDD 红灯阶段）。
 *
 * 组件实现尚未编写：本文件 import `@/components/new-task/CreateWorktreeModal.vue` 会失败，
 * 所有用例因组件不存在而 fail —— 这是 TDD 正常红灯。待实现补齐后转绿。
 *
 * 组件契约（spec FR-2~FR-5 + SR1-SR5）：
 * - 五态：form / progress / success / error / exists（内部状态机管理）
 * - props：可选 initialBranch
 * - emits：close / success(cwd) / retry / use-existing(cwd)
 * - 依赖：useNewTaskFlow（flow state、gitInfo）、worktreeApi（worktree.create RPC）
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
 * worktreeApi mock：create 返回可控 Promise，用 rejectedError 驱动 error/exists 态。
 * hoisted 让 factory 引用稳定 holder，mockReset 后可重新 set 实现。
 */
const worktreeApiMockHolder = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock('@/api/domains/worktree', () => ({
  worktreeApi: {
    create: worktreeApiMockHolder.create,
  },
}))

/**
 * useNewTaskFlow mock：组件读 flow.gitInfo（分支名回灌），不依赖状态机驱动 modal 显隐
 * （CreateWorktreeModal 由父级按需挂载，内部自管五态）。
 * hoisted holder 容纳 reactive refs，import 后构建。
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
const flowBranch: Ref<string> = ref('main')
/** 测试直接控制的 flow mock（与组件内 useNewTaskFlow() 返回同一对象） */
const flowMock = {
  gitInfo: readonly(ref({ branch: 'main', dirty: false })) as unknown as DeepReadonly<
    Ref<{ branch: string; dirty: boolean } | null>
  >,
  _branch: flowBranch,
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

let currentWrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  worktreeApiMockHolder.create.mockReset()
  // 默认实现：create 成功返回新 cwd
  worktreeApiMockHolder.create.mockResolvedValue({ cwd: '/repo/.worktrees/feat-x', branch: 'feat-x' })
  flowMock._branch.value = 'main'
})

afterEach(() => {
  // 先 unmount 让 Vue 正常卸载 teleport，再清 body 残留（避免 parentNode null）
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
  it('CM-1: 默认进 form 态，base 默认选中 origin/main', async () => {
    await mountModal()
    // form 态：分支名 input 可见
    expect(has('[data-testid="worktree-branch-input"]')).toBe(true)
    // base 默认 origin/main：worktree-base-main 选中态（class 含选中标记）
    const mainSeg = $('[data-testid="worktree-base-main"]')
    expect(mainSeg.exists()).toBe(true)
    // 选中态：通过 aria-checked 或 class 表达（实现可选其一；断言 class 含 active/checked）
    const cls = mainSeg.classes().join(' ')
    expect(/\b(active|checked|selected)\b/i.test(cls) || mainSeg.attributes('aria-checked') === 'true').toBe(true)
  })

  it('CM-2: 输入分支名后目录名预览实时更新（feat/oauth → feat-oauth）', async () => {
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('feat/oauth')
    await flushPromises()
    expect($('[data-testid="worktree-dir-preview"]').text()).toContain('feat-oauth')
  })

  it('CM-3: 分支名空 → 创建 disabled', async () => {
    await mountModal()
    // 默认空输入
    await flushPromises()
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
  })

  it('CM-4: 分支名非法 → input danger + error 提示 + 创建 disabled', async () => {
    await mountModal()
    // a..b（禁 .. ）
    await $('[data-testid="worktree-branch-input"]').setValue('a..b')
    await flushPromises()
    expect(has('[data-testid="worktree-branch-error"]')).toBe(true)
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
    // input 边框 danger（class 含 border-destructive / border-danger）
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

  it('CM-4e: 分支名含反斜杠 → error + disabled（与 runtime 一致，防 Windows 路径遍历）', async () => {
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('a\\b')
    await flushPromises()
    expect(has('[data-testid="worktree-branch-error"]')).toBe(true)
    expect($('[data-testid="worktree-create-btn"]').attributes('disabled')).toBeDefined()
  })

  it('CM-5: 点创建 → 进 progress 态 → 调 worktreeApi.create', async () => {
    // create 挂起 → 停留 progress 态（验证创建中 DOM + create 已被调）
    let _resolve!: (v: { cwd: string; branch: string }) => void
    worktreeApiMockHolder.create.mockImplementationOnce(
      () => new Promise((r) => { _resolve = r }),
    )
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    // progress 态：loading bar 可见
    expect(has('[data-testid="worktree-loading-bar"]')).toBe(true)
    expect(worktreeApiMockHolder.create).toHaveBeenCalledTimes(1)
    // 释放挂起 promise 避免 unhandled rejection
    _resolve({ cwd: '/repo/.worktrees/feat-x', branch: 'feat-x' })
    await flushPromises()
  })

  it('CM-6: worktreeApi.create 成功 → 进 success 态 → 2s 后 emit success(cwd)', async () => {
    vi.useFakeTimers()
    try {
      worktreeApiMockHolder.create.mockResolvedValueOnce({ cwd: '/repo/.worktrees/feat-x', branch: 'feat-x' })
      await mountModal()
      await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
      await flushPromises()
      await $('[data-testid="worktree-create-btn"]').trigger('click')
      await flushPromises()
      // success 态：成功图标/提示可见
      expect(has('[data-testid="worktree-success"]')).toBe(true)
      // 2s 前未 emit
      vi.advanceTimersByTime(1999)
      expect(currentWrapper!.emitted('success')).toBeFalsy()
      // 2s 后 emit success(cwd)
      vi.advanceTimersByTime(1)
      expect(currentWrapper!.emitted('success')).toHaveLength(1)
      expect(currentWrapper!.emitted('success')![0]).toEqual(['/repo/.worktrees/feat-x'])
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
    // error 态：失败步骤 + 错误输出可见
    expect(has('[data-testid="worktree-step-failed"]')).toBe(true)
    expect(has('[data-testid="worktree-error-output"]')).toBe(true)
    expect($('[data-testid="worktree-error-output"]').text()).toContain('npm: command not found')
  })

  it('CM-7b: worktreeApi.create 失败(GIT_FAILED) → 进 error 态 → 显示 exitCode+stderr（与 SETUP_FAILED 同形 detail）', async () => {
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
    // 无 stderr → 走 message fallback（pre 标签显 message）
    expect($('[data-testid="worktree-error-output"]').text()).toContain('当前目录不在 .bare workspace 下')
  })

  it('CM-8: worktreeApi.create 失败(WORKTREE_EXISTS) → 进 exists 态', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('worktree exists'), { code: 'WORKTREE_EXISTS', cwd: '/repo/.worktrees/feat-x' }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    // exists 态：已存在提示可见
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
    // 重试：create 第二次调用成功 → 回 progress 后转 success
    worktreeApiMockHolder.create.mockResolvedValueOnce({ cwd: '/repo/.worktrees/feat-x', branch: 'feat-x' })
    await $('[data-testid="worktree-retry-btn"]').trigger('click')
    await flushPromises()
    // 第二次调用 create
    expect(worktreeApiMockHolder.create).toHaveBeenCalledTimes(2)
    // 进 success（重试成功）
    expect(has('[data-testid="worktree-success"]')).toBe(true)
  })

  it('CM-10: exists 态点「直接开始」→ emit use-existing(cwd)', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('worktree exists'), { code: 'WORKTREE_EXISTS', cwd: '/repo/.worktrees/feat-x' }),
    )
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    await $('[data-testid="worktree-use-existing-btn"]').trigger('click')
    await flushPromises()
    expect(currentWrapper!.emitted('use-existing')).toHaveLength(1)
    expect(currentWrapper!.emitted('use-existing')![0]).toEqual(['/repo/.worktrees/feat-x'])
  })
})

// ============================================================================
// 使用者视角（黑盒/DOM 可见断言）—— CM-11 ~ CM-14
// ============================================================================

describe('CreateWorktreeModal 使用者视角（DOM 可见）', () => {
  it('CM-11: form 态 DOM 含分支名 input + base 选择器 + 创建按钮', async () => {
    await mountModal()
    expect(has('[data-testid="worktree-branch-input"]')).toBe(true)
    expect(has('[data-testid="worktree-base-current"]')).toBe(true)
    expect(has('[data-testid="worktree-base-main"]')).toBe(true)
    expect(has('[data-testid="worktree-create-btn"]')).toBe(true)
    expect(has('[data-testid="worktree-cancel-btn"]')).toBe(true)
  })

  it('CM-12: progress 态 DOM 含 3 步列表 + loading bar，无关闭 X', async () => {
    // create 挂起 → 停留 progress 态
    let _resolve!: (v: { cwd: string; branch: string }) => void
    worktreeApiMockHolder.create.mockImplementationOnce(
      () => new Promise((r) => { _resolve = r }),
    )
    await mountModal()
    await $('[data-testid="worktree-branch-input"]').setValue('feat/x')
    await flushPromises()
    await $('[data-testid="worktree-create-btn"]').trigger('click')
    await flushPromises()
    // 3 步列表
    expect(has('[data-testid="worktree-step-0"]')).toBe(true)
    expect(has('[data-testid="worktree-step-1"]')).toBe(true)
    expect(has('[data-testid="worktree-step-2"]')).toBe(true)
    // loading bar
    expect(has('[data-testid="worktree-loading-bar"]')).toBe(true)
    // 无关闭 X（progress 创建中不可关闭）
    expect(has('[data-testid="worktree-close-x"]')).toBe(false)
    // 释放挂起 promise 避免 unhandled rejection
    _resolve({ cwd: '/repo/.worktrees/feat-x', branch: 'feat-x' })
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
    // primary 样式（重试为主按钮）
    const retryCls = $('[data-testid="worktree-retry-btn"]').classes().join(' ')
    expect(/(primary|default)/i.test(retryCls)).toBe(true)
    // 清理按钮（ghost）
    expect(has('[data-testid="worktree-cleanup-btn"]')).toBe(true)
  })

  it('CM-14: exists 态 DOM 含「已存在」提示 + 「直接开始」按钮', async () => {
    await mountModal()
    worktreeApiMockHolder.create.mockRejectedValueOnce(
      Object.assign(new Error('worktree exists'), { code: 'WORKTREE_EXISTS', cwd: '/repo/.worktrees/feat-x' }),
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
  it('CM-15: 首屏渲染 form 态 DOM 含分支名 input + base segmented + 创建按钮', async () => {
    await mountModal()
    // mount 不崩 + form 关键元素齐全
    expect(has('[data-testid="worktree-branch-input"]')).toBe(true)
    expect(has('[data-testid="worktree-base-main"]')).toBe(true)
    expect(has('[data-testid="worktree-base-current"]')).toBe(true)
    expect(has('[data-testid="worktree-create-btn"]')).toBe(true)
    // 目录名预览区可见
    expect(has('[data-testid="worktree-dir-preview"]')).toBe(true)
  })
})
