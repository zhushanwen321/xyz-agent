/**
 * CreateBranchModal 组件单测（#7，T6.2/T6.3modal/T6.4modal/T6.6/T6.7）。
 *
 * 覆盖：
 * - T6.2 分支名校验：空格/.. 特殊字符 → 提交 disabled + 错误提示；合法名 → enabled
 * - T6.3 modal createBranch reject（已存在）→ modal 不关、显错、可重试（D-7）
 * - T6.4 modal createBranch reject（超时）→ 留 modal 显错「git 操作超时」
 * - T6.6 飞行中 createBranch pending → 提交按钮 disabled，重复点击只调一次
 * - T6.7 飞行中 Esc → 后台 resolve 忽略，不崩不回灌 chip
 *
 * mock 策略：vi.mock('@/api')（git.createBranch + session.create/remove），
 * 真用 useNewTaskFlow（模块级单例 state）。beforeEach 重建 pinia + resetNewTaskFlow。
 * 驱动 flow 到 branch-modal 态后 mount 组件（Dialog 按 state===branch-modal 渲染）。
 *
 * 注意：CreateBranchModal 用 reka-ui Dialog（DialogContent teleport 到 document.body），
 * 故 DOM 查询走 document.body（@vue/test-utils 的 wrapper.find 不穿透 teleport）。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/create-branch-modal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary } from '@xyz-agent/shared'
import CreateBranchModal from '@/components/new-task/CreateBranchModal.vue'
import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

const createCtrl = vi.hoisted(() => ({
  create: vi.fn<(cwd?: string) => Promise<SessionSummary>>(),
  remove: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const gitCtrl = vi.hoisted(() => ({
  createBranch: vi
    .fn<(sessionId: string, name: string) => Promise<void>>()
    .mockResolvedValue(undefined),
}))

vi.mock('@/api', () => ({
  session: { create: createCtrl.create, remove: createCtrl.remove },
  git: { createBranch: gitCtrl.createBranch },
}))

/** 在 Dialog teleport 目标（document.body）中查找元素；teleport 内容 wrapper.find 不穿透 */
function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  if (!node) throw new Error(`选择器未匹配: ${selector}`)
  return new DOMWrapper(node)
}
function has(selector: string): boolean {
  return document.body.querySelector(selector) !== null
}

function gitSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: over.id ?? 'cur',
    label: 'repo',
    cwd: '/repo',
    gitBranch: 'main',
    status: 'idle',
    lastActiveAt: 1,
    modelId: 'm',
    tokenCount: 0,
    ...over,
  }
}

let currentWrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
  gitCtrl.createBranch.mockResolvedValue(undefined)
  createCtrl.remove.mockResolvedValue(undefined)
})

afterEach(() => {
  // 先 unmount 让 Vue 正常卸载 teleport，再清 body 残留（避免 parentNode null）
  currentWrapper?.unmount()
  currentWrapper = null
  document.body.innerHTML = ''
})

/** 驱动 flow 到 branch-modal 态并 mount CreateBranchModal */
async function mountAtBranchModal(): Promise<ReturnType<typeof useNewTaskFlow>> {
  const store = useSessionStore()
  store.setGroups([{ cwd: '/repo', sessions: [gitSession()] }])
  createCtrl.create.mockResolvedValue(gitSession({ id: 'cur' }))
  const flow = useNewTaskFlow()
  await flow.startFlow()
  store.activeId = 'cur' // store.active.gitBranch=main → gitInfo 非 null
  flow.openBranchPopover() // landing→branch-popover
  flow.openBranchModal() // branch-popover→branch-modal
  expect(flow.state.value).toBe('branch-modal')
  currentWrapper = mount(CreateBranchModal, { attachTo: document.body })
  await flushPromises()
  return flow
}

describe('CreateBranchModal 分支名校验（T6.2）', () => {
  it('含空格 → 提交 disabled + 错误提示', async () => {
    await mountAtBranchModal()
    await $('input').setValue('bad name')
    await flushPromises()
    expect($('[data-testid="submit-btn"]').attributes('disabled')).toBeDefined()
    expect(has('[data-testid="branch-name-error"]')).toBe(true)
  })

  it('含 .. → 提交 disabled', async () => {
    await mountAtBranchModal()
    await $('input').setValue('feat..x')
    await flushPromises()
    expect($('[data-testid="submit-btn"]').attributes('disabled')).toBeDefined()
    expect(has('[data-testid="branch-name-error"]')).toBe(true)
  })

  it('合法名 → 提交 enabled，无错误提示', async () => {
    await mountAtBranchModal()
    await $('input').setValue('feature/new-branch')
    await flushPromises()
    expect($('[data-testid="submit-btn"]').attributes('disabled')).toBeUndefined()
    expect(has('[data-testid="branch-name-error"]')).toBe(false)
  })
})

describe('CreateBranchModal 失败留 modal（T6.3 D-7）', () => {
  it('createBranch reject（已存在）→ modal 不关、显错、可重试', async () => {
    const flow = await mountAtBranchModal()
    await $('input').setValue('feat/dup')
    await flushPromises()
    gitCtrl.createBranch.mockRejectedValue(new Error('branch already exists'))
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    // D-7：留 modal 可重试
    expect(flow.state.value).toBe('branch-modal')
    expect(has('[data-testid="error-msg"]')).toBe(true)
    expect($('[data-testid="error-msg"]').text()).toContain('exists')
    // 重试：createBranch 改 resolve，再提交 → 成功落回 landing
    gitCtrl.createBranch.mockResolvedValue(undefined)
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    expect(flow.state.value).toBe('landing')
  })
})

describe('CreateBranchModal 超时留 modal（T6.4）', () => {
  it('createBranch reject（超时）→ 留 modal 显错「git 操作超时」', async () => {
    const flow = await mountAtBranchModal()
    await $('input').setValue('feat/slow')
    await flushPromises()
    // runtime 超时 → GitError('git_unavailable')，envelope 透传
    gitCtrl.createBranch.mockRejectedValue(new Error('git_unavailable: timed out'))
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    expect(flow.state.value).toBe('branch-modal')
    expect($('[data-testid="error-msg"]').text()).toContain('超时')
  })
})

describe('CreateBranchModal 飞行中防重复（T6.6）', () => {
  it('createBranch pending → 提交按钮 disabled，重复点击只调一次', async () => {
    await mountAtBranchModal()
    await $('input').setValue('feat/x')
    await flushPromises()
    let resolveCreate!: () => void
    gitCtrl.createBranch.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveCreate = r
      }),
    )
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    // 飞行中提交按钮 disabled
    expect($('[data-testid="submit-btn"]').attributes('disabled')).toBeDefined()
    // 重复点击（trigger 绕过 disabled 派发，验证守卫）—— disabled button 不再 submit，createBranch 仍只 1 次
    await $('[data-testid="submit-btn"]').trigger('click')
    expect(gitCtrl.createBranch).toHaveBeenCalledTimes(1)
    resolveCreate()
    await flushPromises()
  })
})

describe('CreateBranchModal 飞行中 Esc 孤儿 promise（T6.7）', () => {
  it('createBranch pending 时 Esc → 后台 resolve 忽略，不崩不回灌', async () => {
    const flow = await mountAtBranchModal()
    await $('input').setValue('feat/orphan')
    await flushPromises()
    let resolveCreate!: () => void
    gitCtrl.createBranch.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveCreate = r
      }),
    )
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    flow.closeOverlay() // 模拟 Esc → branch-modal→landing
    expect(flow.state.value).toBe('landing')
    resolveCreate() // 后台 promise resolve
    await flushPromises()
    // 孤儿 promise 忽略：state 仍 landing（未重复 transition 抛错），组件未崩
    expect(flow.state.value).toBe('landing')
  })
})
