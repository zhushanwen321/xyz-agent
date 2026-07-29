/**
 * WorktreePage auto-rename Switch mount 测试。
 *
 * 覆盖：
 *  - TC2: mount 后 DOM 含 auto-rename Switch（data-testid=setting-auto-rename-session）。
 *  - TC3: onMounted 调 getAutoRenameEnabled，Switch checked（aria-checked/data-state）反映返回值 true。
 *  - TC4 成功: 切换 Switch 触发 setAutoRenameEnabled，并反馈成功 toast。
 *  - TC4 失败: setAutoRenameEnabled reject 时 Switch 状态回滚到原值，并反馈 error toast。
 *
 * mock 策略：
 *  - vi.mock('@/api/domains/settings')：WorktreePage onMounted 会 Promise.allSettled 全部 6 个 getter，
 *    需全部 resolve；setAutoRenameEnabled 默认 resolve（成功），失败用例临时 reject 一次。
 *  - i18n 经 vitest-i18n-setup 全局 mock useI18n，t() 从 zh-CN locale 解析（无需本文件 mock）。
 *  - useToast 用真实实现（createPinia + setActivePinia 后 ref 可用，断言 toasts.value）。
 *  - reka-ui Switch 在 happy-dom 下渲染为 button[role=switch][aria-checked][data-state]，
 *    click 触发 toggleCheck → emit('update:modelValue') → WorktreePage.onSaveAutoRename。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/worktree-page-auto-rename.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useToast } from '@/composables/useToast'

const settingsMock = vi.hoisted(() => ({
  getWorktreeRootDir: vi.fn(() => Promise.resolve({ dir: '~/worktrees' })),
  setWorktreeRootDir: vi.fn(() => Promise.resolve()),
  getSetupScript: vi.fn(() => Promise.resolve({ script: 'x.sh' })),
  setSetupScript: vi.fn(() => Promise.resolve()),
  getBareSetupScript: vi.fn(() => Promise.resolve({ script: 'bare.sh' })),
  setBareSetupScript: vi.fn(() => Promise.resolve()),
  getWorktreeTimeout: vi.fn(() => Promise.resolve({ timeout: 60 })),
  setWorktreeTimeout: vi.fn(() => Promise.resolve()),
  getDefaultBaseBranch: vi.fn(() => Promise.resolve({ baseBranch: 'origin/main' })),
  setDefaultBaseBranch: vi.fn(() => Promise.resolve()),
  // TC3：初始值=true，断言 Switch 反映 checked
  getAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  // 默认 resolve（成功场景）；失败用例用 mockRejectedValueOnce 临时覆盖
  setAutoRenameEnabled: vi.fn((enabled: boolean) => Promise.resolve({ enabled })),
}))

vi.mock('@/api/domains/settings', () => settingsMock)

import WorktreePage from '@/components/settings/WorktreePage.vue'

let wrapper: ReturnType<typeof mount> | null = null

/** 在 attach 目标中查找元素并包装成 DOMWrapper（断言存在）。 */
function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  expect(node).toBeTruthy()
  return new DOMWrapper(node!)
}

beforeEach(() => {
  setActivePinia(createPinia())
  const { toasts } = useToast()
  toasts.value = []
  settingsMock.getAutoRenameEnabled.mockClear()
  settingsMock.setAutoRenameEnabled.mockClear()
  // 重置默认实现（失败用例可能 mockRejectedValueOnce，余下调用恢复 resolve）
  settingsMock.setAutoRenameEnabled.mockImplementation((enabled: boolean) =>
    Promise.resolve({ enabled }),
  )
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

async function mountPage(): Promise<void> {
  wrapper = mount(WorktreePage, { attachTo: document.body })
  // 等 onMounted 里的 Promise.allSettled 全部 settle + 响应式更新
  await flushPromises()
}

describe('WorktreePage auto-rename Switch', () => {
  // TC2: 渲染含 Switch
  it('渲染含 auto-rename Switch（data-testid=setting-auto-rename-session）', async () => {
    await mountPage()
    expect(document.body.querySelector('[data-testid="setting-auto-rename-session"]')).toBeTruthy()
  })

  // TC3: onMounted 拉初始值 → Switch checked 反映返回值（true）
  it('onMounted 后 Switch checked 反映 getAutoRenameEnabled 返回值（aria-checked / data-state = true）', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValueOnce({ enabled: true })
    await mountPage()

    // 确认 onMounted 确实调用了 getAutoRenameEnabled
    expect(settingsMock.getAutoRenameEnabled).toHaveBeenCalledTimes(1)

    // data-testid 绑在 SwitchRoot 上，reka 渲染它为 button[role=switch]，
    // aria-checked 与 data-state 均应反映 checked=true
    expect($('[data-testid="setting-auto-rename-session"]').attributes('aria-checked')).toBe('true')
    expect($('[data-testid="setting-auto-rename-session"]').attributes('data-state')).toBe('checked')
  })

  // TC3 补充：getAutoRenameEnabled=false 时 Switch unchecked
  it('getAutoRenameEnabled 返回 false 时 Switch 反映 unchecked', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValueOnce({ enabled: false })
    await mountPage()

    expect($('[data-testid="setting-auto-rename-session"]').attributes('aria-checked')).toBe('false')
    expect($('[data-testid="setting-auto-rename-session"]').attributes('data-state')).toBe('unchecked')
  })

  // TC4 成功: 切换 Switch 触发 setAutoRenameEnabled + 成功 toast
  it('切换 Switch 触发 setAutoRenameEnabled(false) 并反馈成功 toast', async () => {
    await mountPage()

    // 初始 checked=true，click → toggle 为 false → onSaveAutoRename(false)
    await $('[data-testid="setting-auto-rename-session"]').trigger('click')
    await flushPromises()

    expect(settingsMock.setAutoRenameEnabled).toHaveBeenCalledTimes(1)
    expect(settingsMock.setAutoRenameEnabled).toHaveBeenCalledWith(false)

    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'info')).toBe(true)
  })

  // TC4 失败回滚: setAutoRenameEnabled reject → Switch 回到原值（true）+ error toast
  it('setAutoRenameEnabled 失败时 Switch 状态回滚到原值（true）并反馈 error toast', async () => {
    settingsMock.setAutoRenameEnabled.mockRejectedValueOnce(new Error('保存失败'))
    await mountPage()

    // 初始 checked=true；click → 乐观切到 false → 失败回滚到 true
    await $('[data-testid="setting-auto-rename-session"]').trigger('click')
    await flushPromises()

    expect(settingsMock.setAutoRenameEnabled).toHaveBeenCalledTimes(1)
    expect(settingsMock.setAutoRenameEnabled).toHaveBeenCalledWith(false)

    // 回滚后 Switch 应恢复 checked=true
    expect($('[data-testid="setting-auto-rename-session"]').attributes('aria-checked')).toBe('true')
    expect($('[data-testid="setting-auto-rename-session"]').attributes('data-state')).toBe('checked')

    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'error')).toBe(true)
  })
})
