/**
 * ExtensionUIDialog 测试（W5 + W3 U9）。
 *
 * 验证：
 * - select 请求 → 渲染选项下拉
 * - confirm 请求 → 渲染确认/取消按钮
 * - input 请求 → 渲染输入框
 * - 用户操作后调 sendExtensionUIResponse 回传
 * - U9（W3）：ask-user 请求不在 Dialog 渲染（已搬到 Panel inline），Dialog 只处理非 ask-user 原语
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/components/ExtensionUIDialog.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// Mock useExtensionUI composable（W1 新 API：currentAskUserRequest + currentDialogRequest 分流）
const mockAskUserReq = ref<ExtensionUIRequest | undefined>(undefined)
const mockDialogReq = ref<ExtensionUIRequest | undefined>(undefined)
const mockRespond = vi.fn()
const mockCancel = vi.fn()

vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentAskUserRequest: mockAskUserReq,
    currentDialogRequest: mockDialogReq,
    respond: mockRespond,
    cancel: mockCancel,
  }),
  dialogFilter: (req: ExtensionUIRequest) => req.askUser !== true,
  askUserFilter: (req: ExtensionUIRequest) => req.askUser === true,
}))

// Mock useSidebar（避免依赖真实 session 状态）
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({
    focusedSessionId: { value: 'sess-1' },
  }),
}))

import ExtensionUIDialog from '@/components/extension/ExtensionUIDialog.vue'
import type { ExtensionUIRequest } from '@/api/domains/extension'

beforeEach(() => {
  setActivePinia(createPinia())
  mockAskUserReq.value = undefined
  mockDialogReq.value = undefined
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

function makeAskUserRequest(): ExtensionUIRequest {
  return {
    sessionId: 'sess-1',
    requestId: 'req-ask',
    method: 'select',
    askUser: true,
    askUserQuestions: [{ header: 'q', question: '选哪个?', options: [{ label: 'A', value: 'a' }] }],
    allowCancel: true,
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
    mockDialogReq.value = makeRequest({ method: 'select' })
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    expect(wrapper.find('[data-testid="extension-ui-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('选择操作')
    expect(wrapper.text()).toContain('请选择一个选项')
  })

  it('confirm 请求 → 渲染确认/取消按钮', () => {
    mockDialogReq.value = makeRequest({ method: 'confirm', options: undefined })
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    expect(wrapper.find('[data-testid="extension-ui-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('确认')
    expect(wrapper.text()).toContain('取消')
  })

  it('无请求时 → 对话框不渲染', () => {
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    expect(wrapper.find('[data-testid="extension-ui-dialog"]').exists()).toBe(false)
  })

  it('input 请求 → 渲染输入框', () => {
    mockDialogReq.value = makeRequest({ method: 'input', options: undefined, message: '请输入文件名' })
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    expect(wrapper.find('[data-testid="extension-ui-input"]').exists()).toBe(true)
  })

  it('U9: ask-user 请求不在 Dialog 渲染（已搬到 Panel inline）', () => {
    mockAskUserReq.value = makeAskUserRequest()
    const wrapper = mount(ExtensionUIDialog, { global: { stubs: STUBS } })

    // ask-user 请求不应触发 Dialog 渲染
    expect(wrapper.find('[data-testid="extension-ui-dialog"]').exists()).toBe(false)
    // 更不应渲染 ask-user overlay
    expect(wrapper.find('[data-testid="ask-user-overlay"]').exists()).toBe(false)
  })
})
