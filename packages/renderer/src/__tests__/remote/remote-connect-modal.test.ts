/**
 * W1 TC1-TC3: RemoteConnectModal 壳单测（Dialog + Tabs 切换 + close emit）。
 *
 * 覆盖：
 * - TC1 渲染三 tab + 默认选中 paste（RemotePasteTab 渲染，manual/saved 不可见）
 * - TC2 点 tab 切换 active 内容
 * - TC3 close emit（cancel 按钮）
 *
 * mock 策略：stub 3 个 tab 子组件（带 testid），避免渲染真实子组件触发 probe/listProfiles 副作用。
 *
 * 注意：RemoteConnectModal 用 reka-ui Dialog（DialogContent teleport 到 document.body），
 * 故 DOM 查询走 document.body（与 create-branch-modal.test.ts 同模式）。
 *
 * 运行：npx vitest run src/__tests__/remote/remote-connect-modal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import type { DOMWrapper as DOMWrapperType } from '@vue/test-utils'
import RemoteConnectModal from '@/components/remote/RemoteConnectModal.vue'

/** stub 3 个 tab 子组件（带 testid，验随 tab 切换显隐） */
const stubs = {
  RemotePasteTab: { name: 'RemotePasteTab', template: '<div data-testid="paste-stub" />' },
  RemoteManualTab: { name: 'RemoteManualTab', template: '<div data-testid="manual-stub" />' },
  RemoteSavedTab: { name: 'RemoteSavedTab', template: '<div data-testid="saved-stub" />' },
}

/** 在 Dialog teleport 目标（document.body）中查找元素 */
function $(selector: string): DOMWrapperType<Element | null> {
  return new DOMWrapper(document.body.querySelector(selector))
}

function $$count(selector: string): number {
  return document.body.querySelectorAll(selector).length
}

describe('W1 TC1: 渲染三 tab + 默认选中 paste', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    wrapper = mount(RemoteConnectModal, { props: { standalone: true }, global: { stubs }, attachTo: document.body })
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('standalone=true → Dialog 渲染 + 3 个 TabsTrigger 可见 + 默认 paste 内容', async () => {
    await flushPromises()
    expect($('[data-testid="tab-trigger-paste"]').exists()).toBe(true)
    expect($('[data-testid="tab-trigger-manual"]').exists()).toBe(true)
    expect($('[data-testid="tab-trigger-saved"]').exists()).toBe(true)
    // 默认 active=paste → paste stub 渲染
    expect($('[data-testid="paste-stub"]').exists()).toBe(true)
  })
})

describe('W1 TC2: 点 tab 切换 active 内容', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    wrapper = mount(RemoteConnectModal, { props: { standalone: true }, global: { stubs }, attachTo: document.body })
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('点 manual tab → manual-stub 渲染、paste-stub 不可见', async () => {
    await flushPromises()
    expect($('[data-testid="paste-stub"]').exists()).toBe(true)
    // reka-ui TabsTrigger 用 mousedown 切换（不是 click）
    await $('[data-testid="tab-trigger-manual"]').trigger('mousedown')
    await flushPromises()
    expect($('[data-testid="manual-stub"]').exists()).toBe(true)
    expect($('[data-testid="paste-stub"]').exists()).toBe(false)
  })

  it('点 saved tab → saved-stub 渲染', async () => {
    await flushPromises()
    await $('[data-testid="tab-trigger-saved"]').trigger('mousedown')
    await flushPromises()
    expect($('[data-testid="saved-stub"]').exists()).toBe(true)
    expect($('[data-testid="paste-stub"]').exists()).toBe(false)
  })
})

describe('W1 TC3: close emit', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    wrapper = mount(RemoteConnectModal, { props: { standalone: true }, global: { stubs }, attachTo: document.body })
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('点 cancel 按钮 → emit close 1 次', async () => {
    await flushPromises()
    const cancelBtn = $('[data-testid="modal-cancel-btn"]')
    expect(cancelBtn.exists()).toBe(true)
    await cancelBtn.trigger('click')
    expect(wrapper!.emitted('close')).toBeTruthy()
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })
})
