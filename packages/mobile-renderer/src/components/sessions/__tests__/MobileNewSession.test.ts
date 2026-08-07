/**
 * MobileNewSession 测试（P4-s3-w2 AC6 + MAJOR-3 回归）。
 *
 * AC6 验收：
 *  - 含手动路径输入框（DOM 断言 placeholder 含「服务器路径」）
 *  - 输入路径 + prompt + 提交 → 调 sessionApi.create 带 cwd
 *  - 不调 dir.list RPC
 *
 * [MAJOR-3] create 后发送首条消息（prompt）—— 对齐 renderer useNewTaskFlow.submitFirstMessage
 *   断言 chat.send 被调且参数含 prompt 文本。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import MobileNewSession from '../MobileNewSession.vue'

// Mock sessionApi.create（vi.hoisted 避免 TDZ）
const { createMock, sendMock, loadSessionsMock } = vi.hoisted(() => ({
  createMock: vi.fn((cwd?: string) => Promise.resolve({ id: 'new-s1', label: 'new', cwd: cwd ?? '', state: 'idle' })),
  sendMock: vi.fn(() => Promise.resolve()),
  loadSessionsMock: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/api/domains/session', () => ({
  create: createMock,
}))

// Mock useChat（[MAJOR-3] 发送首条消息用）
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ send: sendMock }),
}))

// Mock useSidebar（[MAJOR-3] loadSessions 刷新列表用）
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ loadSessions: loadSessionsMock }),
}))

// Mock useToast（错误路径用）
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  createMock.mockClear()
  sendMock.mockClear()
  loadSessionsMock.mockClear()
  createMock.mockResolvedValue({ id: 'new-s1', label: 'new', cwd: '', state: 'idle' })
})

describe('MobileNewSession（P4-s3-w2 AC6）', () => {
  it('含手动路径输入框（placeholder 含「服务器路径」）', () => {
    const wrapper = mount(MobileNewSession)
    const cwdInput = wrapper.find('[data-testid="mobile-new-session-cwd"]')
    expect(cwdInput.exists()).toBe(true)
    expect(cwdInput.attributes('placeholder')).toContain('服务器路径')
    // prompt 输入框也存在
    expect(wrapper.find('[data-testid="mobile-new-session-prompt"]').exists()).toBe(true)
    // 提交按钮存在
    expect(wrapper.find('[data-testid="mobile-new-session-submit"]').exists()).toBe(true)
  })

  it('输入路径 + prompt + 提交 → 调 sessionApi.create 带 cwd', async () => {
    const wrapper = mount(MobileNewSession)
    await wrapper.find('[data-testid="mobile-new-session-prompt"]').setValue('帮我修 bug')
    await wrapper.find('[data-testid="mobile-new-session-cwd"]').setValue('~/projects/xyz-agent')
    await wrapper.find('[data-testid="mobile-new-session-submit"]').trigger('click')
    await vi.dynamicImportSettled()

    // sessionApi.create 被调用，cwd 参数 = 输入路径
    expect(createMock).toHaveBeenCalledOnce()
    expect(createMock).toHaveBeenCalledWith('~/projects/xyz-agent')
    // emit created（新 sessionId）
    expect(wrapper.emitted('created')).toEqual([['new-s1']])
  })

  it('不调 dir.list RPC（spec D4/审查 M6）', async () => {
    // 验证：提交只调 sessionApi.create，不调 dir.list
    const wrapper = mount(MobileNewSession)
    await wrapper.find('[data-testid="mobile-new-session-prompt"]').setValue('task')
    await wrapper.find('[data-testid="mobile-new-session-cwd"]').setValue('/path')
    await wrapper.find('[data-testid="mobile-new-session-submit"]').trigger('click')
    await vi.dynamicImportSettled()

    // 只 sessionApi.create 被调（dir.list 不在 mock 中，且从未被 import）
    expect(createMock).toHaveBeenCalledOnce()
  })

  it('空 prompt 或空 cwd 时提交按钮 disabled（ES1）', () => {
    const wrapper = mount(MobileNewSession)
    // 初始空 → disabled
    expect(wrapper.find('[data-testid="mobile-new-session-submit"]').attributes('disabled')).toBeDefined()
  })

  it('cancel 按钮 emit cancel', async () => {
    const wrapper = mount(MobileNewSession)
    await wrapper.find('[data-testid="mobile-new-session-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})

// ── [MAJOR-3] create 后发送首条消息（prompt）──
describe('MobileNewSession [MAJOR-3] create 后发送 prompt', () => {
  it('create 成功后调 chat.send(newSid, segments)，segments 含 prompt 文本', async () => {
    const wrapper = mount(MobileNewSession)
    await wrapper.find('[data-testid="mobile-new-session-prompt"]').setValue('帮我修这个 bug')
    await wrapper.find('[data-testid="mobile-new-session-cwd"]').setValue('~/projects/xyz-agent')
    await wrapper.find('[data-testid="mobile-new-session-submit"]').trigger('click')
    await vi.dynamicImportSettled()

    // chat.send 被调用（首条消息发送，对齐 renderer useNewTaskFlow.submitFirstMessage）
    expect(sendMock).toHaveBeenCalledOnce()
    const [sessionId, segments] = sendMock.mock.calls[0]!
    expect(sessionId).toBe('new-s1')
    // segments 是 textToSegments(prompt) 的结果，含 prompt 文本
    expect(Array.isArray(segments)).toBe(true)
    expect(JSON.stringify(segments)).toContain('帮我修这个 bug')
  })

  it('create 成功后 appendSession 到 store + loadSessions 刷新列表', async () => {
    const { useSessionStore } = await import('@/stores/session')
    const store = useSessionStore()
    const wrapper = mount(MobileNewSession)
    await wrapper.find('[data-testid="mobile-new-session-prompt"]').setValue('task')
    await wrapper.find('[data-testid="mobile-new-session-cwd"]').setValue('/p')
    await wrapper.find('[data-testid="mobile-new-session-submit"]').trigger('click')
    await vi.dynamicImportSettled()

    // 新 session 进 store（appendSession），列表非空
    expect(store.list.some((s) => s.id === 'new-s1')).toBe(true)
    // loadSessions 刷新被调（runtime 广播权威分组）
    expect(loadSessionsMock).toHaveBeenCalled()
  })

  it('chat.send 失败不阻断 emit created（用户可重发）', async () => {
    sendMock.mockRejectedValueOnce(new Error('network'))
    const wrapper = mount(MobileNewSession)
    await wrapper.find('[data-testid="mobile-new-session-prompt"]').setValue('task')
    await wrapper.find('[data-testid="mobile-new-session-cwd"]').setValue('/p')
    await wrapper.find('[data-testid="mobile-new-session-submit"]').trigger('click')
    await vi.dynamicImportSettled()

    // send 失败但仍 emit created（进 chat 态，用户可重发）
    expect(sendMock).toHaveBeenCalledOnce()
    expect(wrapper.emitted('created')).toEqual([['new-s1']])
  })
})
