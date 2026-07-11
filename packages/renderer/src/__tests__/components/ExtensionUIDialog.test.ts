/**
 * ExtensionUIDialog 测试（W5）。
 *
 * 验证：
 * - select 请求 → 渲染选项下拉
 * - confirm 请求 → 渲染确认/取消按钮
 * - 用户操作后调 sendExtensionUIResponse 回传
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/components/ExtensionUIDialog.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// Mock useExtensionUI composable（直接控制队列）
const mockQueue = ref<ExtensionUIRequest[]>([])
const mockRespond = vi.fn()
const mockCancel = vi.fn()

vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentRequest: mockQueue,
    respond: mockRespond,
    cancel: mockCancel,
  }),
}))

// Mock useSidebar（避免依赖真实 session 状态）
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({
    focusedSessionId: { value: 'sess-1' },
  }),
}))

import { ref } from 'vue'
import ExtensionUIDialog from '@/components/extension/ExtensionUIDialog.vue'
import type { ExtensionUIRequest } from '@/api/domains/extension'

beforeEach(() => {
  setActivePinia(createPinia())
  mockQueue.value = []
  vi.clearAllMocks()
})

function makeRequest(over: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sess-1',
    requestId: 'req-1',
    method: 'select',
    title: '选择操作',
    message: '请选择一个选项',
    options: ['Option A', 'Option B', 'Option C'],
    ...over,
  }
}

const STUBS = {
  Dialog: {
    props: ['open'],
    template: '<div v-if="open"><slot /></div>',
  },
  DialogContent: { template: '<div data-testid="extension-ui-dialog"><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<div><slot /></div>' },
  DialogDescription: { template: '<div><slot /></div>' },
}

describe('ExtensionUIDialog', () => {
  it('E2: select 请求 → 渲染对话框（data-testid 存在）', () => {
    mockQueue.value = [makeRequest({ method: 'select' })]
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    expect(wrapper.find('[data-testid="extension-ui-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('选择操作')
    expect(wrapper.text()).toContain('请选择一个选项')
  })

  it('confirm 请求 → 渲染确认/取消按钮', () => {
    mockQueue.value = [makeRequest({ method: 'confirm', options: undefined })]
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    expect(wrapper.find('[data-testid="extension-ui-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('确认')
    expect(wrapper.text()).toContain('取消')
  })

  it('无请求时 → 对话框不渲染', () => {
    mockQueue.value = []
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    expect(wrapper.find('[data-testid="extension-ui-dialog"]').exists()).toBe(false)
  })

  it('input 请求 → 渲染输入框', () => {
    mockQueue.value = [makeRequest({ method: 'input', options: undefined, message: '请输入文件名' })]
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    expect(wrapper.find('[data-testid="extension-ui-input"]').exists()).toBe(true)
  })
})
