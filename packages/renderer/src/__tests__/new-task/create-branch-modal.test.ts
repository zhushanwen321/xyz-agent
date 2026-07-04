/**
 * CreateBranchModal 组件单测（#7，T6.2/T6.3modal/T6.4modal/T6.6/T6.7）。
 *
 * 组件测试解耦：不依赖 useNewTaskFlow 状态机驱动（新设计下 landing→branch-modal 不可达），
 * 直接 mount CreateBranchModal + mock useNewTaskFlow（state/isBranchCreating/submitCreateBranch/closeOverlay）。
 * 组件逻辑本身（分支名校验 / 失败留 modal / 飞行中防重复 / 孤儿 promise）与 flow 状态机无关。
 *
 * 覆盖：
 * - T6.2 分支名校验：空格/.. 特殊字符 → 提交 disabled + 错误提示；合法名 → enabled
 * - T6.3 modal createBranch reject（已存在）→ modal 不关、显错、可重试（D-7）
 * - T6.4 modal createBranch reject（超时）→ 留 modal 显错「git 操作超时」
 * - T6.6 飞行中 createBranch pending → 提交按钮 disabled，重复点击只调一次
 * - T6.7 飞行中 Esc → 后台 resolve 忽略，不崩不回灌 chip
 *
 * 注意：CreateBranchModal 用 reka-ui Dialog（DialogContent teleport 到 document.body），
 * 故 DOM 查询走 document.body（@vue/test-utils 的 wrapper.find 不穿透 teleport）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/new-task/create-branch-modal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

/**
 * useNewTaskFlow mock：组件只读 state/isBranchCreating + 调 submitCreateBranch/closeOverlay。
 * - state 默认 'branch-modal'（让 Dialog 渲染）；submitCreateBranch 成功默认→模拟 composable transition landing
 *
 * vi.mock factory 早于 import 执行，不能直接引用 vue 的 ref。用 hoisted holder 容器：
 * factory 返回 `() => holder.current`（lazy），import 后构建 reactive refs 再赋值给 holder.current。
 */
const flowMockHolder = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }))

vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => flowMockHolder.current,
  resetNewTaskFlow: vi.fn(),
}))

import { ref, readonly } from 'vue'
import type { Ref, DeepReadonly } from 'vue'
import CreateBranchModal from '@/components/new-task/CreateBranchModal.vue'

// import 后构建 reactive mock 态（组件 computed 依赖 reactivity 才能驱动 Dialog open）
const flowState: Ref<string> = ref('branch-modal')
const flowBranchCreating: Ref<boolean> = ref(false)
const flowSubmit = vi.fn<(name: string) => Promise<void>>()
const flowClose = vi.fn<() => void>()
/** 测试直接控制的 flow mock（与组件内 useNewTaskFlow() 返回同一对象） */
const flowMock = {
  state: readonly(flowState) as DeepReadonly<Ref<string>>,
  isBranchCreating: readonly(flowBranchCreating) as DeepReadonly<Ref<boolean>>,
  submitCreateBranch: flowSubmit,
  closeOverlay: flowClose,
  _state: flowState,
  _isBranchCreating: flowBranchCreating,
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
  // 重置 mock 态：回到 branch-modal 态、非飞行中
  flowMock._state.value = 'branch-modal'
  flowMock._isBranchCreating.value = false
  flowSubmit.mockReset()
  // 默认实现：模拟 composable 成功 → transition('landing')（组件依赖此副作用关 modal）
  flowSubmit.mockImplementation(async () => {
    flowMock._state.value = 'landing'
  })
  flowClose.mockReset()
  // 模拟真实 closeOverlay：branch-modal→landing
  flowClose.mockImplementation(() => {
    flowMock._state.value = 'landing'
  })
})

afterEach(() => {
  // 先 unmount 让 Vue 正常卸载 teleport，再清 body 残留（避免 parentNode null）
  currentWrapper?.unmount()
  currentWrapper = null
  document.body.innerHTML = ''
})

/** 直接 mount CreateBranchModal（state 已默认 branch-modal，Dialog 渲染） */
async function mountModal(): Promise<void> {
  currentWrapper = mount(CreateBranchModal, { attachTo: document.body })
  await flushPromises()
}

describe('CreateBranchModal 分支名校验（T6.2）', () => {
  it('含空格 → 提交 disabled + 错误提示', async () => {
    await mountModal()
    await $('input').setValue('bad name')
    await flushPromises()
    expect($('[data-testid="submit-btn"]').attributes('disabled')).toBeDefined()
    expect(has('[data-testid="branch-name-error"]')).toBe(true)
  })

  it('含 .. → 提交 disabled', async () => {
    await mountModal()
    await $('input').setValue('feat..x')
    await flushPromises()
    expect($('[data-testid="submit-btn"]').attributes('disabled')).toBeDefined()
    expect(has('[data-testid="branch-name-error"]')).toBe(true)
  })

  it('合法名 → 提交 enabled，无错误提示', async () => {
    await mountModal()
    await $('input').setValue('feature/new-branch')
    await flushPromises()
    expect($('[data-testid="submit-btn"]').attributes('disabled')).toBeUndefined()
    expect(has('[data-testid="branch-name-error"]')).toBe(false)
  })
})

describe('CreateBranchModal 失败留 modal（T6.3 D-7）', () => {
  it('createBranch reject（已存在）→ modal 不关、显错、可重试', async () => {
    await mountModal()
    await $('input').setValue('feat/dup')
    await flushPromises()
    // 首次提交 reject（留 modal 显错；reject 不触发默认实现的 transition）
    flowSubmit.mockRejectedValueOnce(new Error('branch already exists'))
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    // D-7：留 modal 可重试（state 仍 branch-modal）
    expect(flowMock._state.value).toBe('branch-modal')
    expect(has('[data-testid="error-msg"]')).toBe(true)
    expect($('[data-testid="error-msg"]').text()).toContain('exists')
    // 重试：默认实现 resolve → state=landing（composable 成功 transition）
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    expect(flowMock._state.value).toBe('landing')
  })
})

describe('CreateBranchModal 超时留 modal（T6.4）', () => {
  it('createBranch reject（超时）→ 留 modal 显错「git 操作超时」', async () => {
    await mountModal()
    await $('input').setValue('feat/slow')
    await flushPromises()
    // runtime 超时 → GitError('git_unavailable')，envelope 透传
    flowSubmit.mockRejectedValueOnce(new Error('git_unavailable: timed out'))
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    expect(flowMock._state.value).toBe('branch-modal')
    expect($('[data-testid="error-msg"]').text()).toContain('超时')
  })
})

describe('CreateBranchModal 飞行中防重复（T6.6）', () => {
  it('createBranch pending → 提交按钮 disabled，重复点击只调一次', async () => {
    await mountModal()
    await $('input').setValue('feat/x')
    await flushPromises()
    // 飞行中：submitCreateBranch 挂起 + isBranchCreating=true（模拟 composable 飞行中态）
    let resolveSubmit!: () => void
    flowSubmit.mockImplementationOnce(async () => {
      flowMock._isBranchCreating.value = true
      await new Promise<void>((r) => {
        resolveSubmit = r
      })
      flowMock._isBranchCreating.value = false
      flowMock._state.value = 'landing'
    })
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    // 飞行中：isBranchCreating=true → 提交按钮 disabled
    expect($('[data-testid="submit-btn"]').attributes('disabled')).toBeDefined()
    expect(flowSubmit).toHaveBeenCalledTimes(1)
    // 重复点击：canSubmit=false（isBranchCreating）→ onSubmit 早退，不再调 submitCreateBranch
    await $('[data-testid="submit-btn"]').trigger('click')
    expect(flowSubmit).toHaveBeenCalledTimes(1)
    resolveSubmit()
    await flushPromises()
  })
})

describe('CreateBranchModal 飞行中 Esc 孤儿 promise（T6.7）', () => {
  it('createBranch pending 时 Esc → 后台 resolve 忽略，不崩不回灌', async () => {
    await mountModal()
    await $('input').setValue('feat/orphan')
    await flushPromises()
    let resolveSubmit!: () => void
    flowSubmit.mockImplementationOnce(async () => {
      flowMock._isBranchCreating.value = true
      await new Promise<void>((r) => {
        resolveSubmit = r
      })
      flowMock._isBranchCreating.value = false
      flowMock._state.value = 'landing'
    })
    await $('[data-testid="submit-btn"]').trigger('click')
    await flushPromises()
    flowClose() // 模拟 Esc → branch-modal→landing
    expect(flowMock._state.value).toBe('landing')
    resolveSubmit() // 后台 promise resolve
    await flushPromises()
    // 孤儿 promise 忽略：state 仍 landing（未崩，未重复 transition 抛错）
    expect(flowMock._state.value).toBe('landing')
  })
})
