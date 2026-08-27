/**
 * W3 验收测试 - useAppUpdate errorSuggestion 状态
 *
 * 覆盖验收场景：
 * - W3-A2-error-suggestion-state-vitest: errorSuggestion 字段在 onUpdateError 时正确填充
 * - W3-A3-toast-trigger-vitest: onUpdateError 触发 toast 通知
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.w3-acceptance.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reactive } from 'vue'
import type { UpdateState } from '@xyz-agent/shared'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// Mock useToast
const toastErrorMock = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    error: toastErrorMock,
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}))

// Mock ipc
const onUpdateErrorMock = vi.fn()
vi.mock('@/lib/ipc', () => ({
  checkForUpdate: vi.fn(() => Promise.resolve(null)),
  performUpdate: vi.fn(() => Promise.resolve({ triggerRestart: false })),
  updateDownload: vi.fn(() => Promise.resolve({ downloaded: false })),
  updateInstall: vi.fn(() => Promise.resolve({ triggerRestart: false })),
  getPreloaded: vi.fn(() => Promise.resolve(null)),
  getPendingUpdate: vi.fn(() => Promise.resolve(null)),
  onUpdateProgress: vi.fn(() => () => {}),
  onUpdateError: onUpdateErrorMock,
  openUpdateFallbackUrl: vi.fn(() => Promise.resolve()),
}))

// Mock markdown renderer
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: vi.fn(() => Promise.resolve('<p>test</p>')),
}))

// Mock i18n（default 形态供 useAppUpdate 模块级 const t = i18n.global.t 消费；
// 本文件用例不走 launch toast 路径，回退返回 key 即可）
vi.mock('@/i18n', () => ({
  getLocale: vi.fn(() => 'zh-CN'),
  default: { global: { t: (key: string) => key } },
}))

describe('W3-A2-error-suggestion-state-vitest', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // 重置 useAppUpdate 单例状态
    const { _resetForTest } = await import('@/composables/features/settings/useAppUpdate')
    _resetForTest()
  })

  it('W3-A2-error-suggestion-state-vitest: onUpdateError 设置 errorSuggestion', async () => {
    // 捕获 onUpdateError 的回调
    let errorCallback: ((e: { stage: string; message: string; errorCode?: string; suggestion?: string }) => void) | null = null
    onUpdateErrorMock.mockImplementation((cb: typeof errorCallback) => {
      errorCallback = cb
      return () => {}
    })

    const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
    const { state } = useAppUpdate()

    // 模拟 main 进程推送错误事件（带 suggestion）
    expect(errorCallback).not.toBeNull()
    errorCallback!({
      stage: 'downloading',
      message: '无法连接代理 (EHOSTUNREACH)',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      suggestion: 'macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络 → 允许「太极」，重启应用后重试',
    })

    // 验证 state.errorSuggestion 被正确设置
    expect(state.state).toBe('error')
    expect(state.errorMessage).toBe('无法连接代理 (EHOSTUNREACH)')
    expect(state.errorSuggestion).toBe('macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络 → 允许「太极」，重启应用后重试')
  })

  it('W3-A2-error-suggestion-state-vitest: 无 suggestion 时 errorSuggestion 为空', async () => {
    let errorCallback: ((e: { stage: string; message: string; errorCode?: string; suggestion?: string }) => void) | null = null
    onUpdateErrorMock.mockImplementation((cb: typeof errorCallback) => {
      errorCallback = cb
      return () => {}
    })

    const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
    const { state } = useAppUpdate()

    // 模拟 main 进程推送错误事件（无 suggestion）
    errorCallback!({
      stage: 'downloading',
      message: '网络连接失败',
      errorCode: 'UPDATE_NETWORK_FAILED',
    })

    // 验证 state.errorSuggestion 为空
    expect(state.state).toBe('error')
    expect(state.errorMessage).toBe('网络连接失败')
    expect(state.errorSuggestion).toBe('')
  })
})

describe('W3-A3-toast-trigger-vitest', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { _resetForTest } = await import('@/composables/features/settings/useAppUpdate')
    _resetForTest()
  })

  it('W3-A3-toast-trigger-vitest: onUpdateError 触发 toast 通知', async () => {
    let errorCallback: ((e: { stage: string; message: string; errorCode?: string; suggestion?: string }) => void) | null = null
    onUpdateErrorMock.mockImplementation((cb: typeof errorCallback) => {
      errorCallback = cb
      return () => {}
    })

    const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
    useAppUpdate() // 注册回调

    // 模拟 main 进程推送错误事件
    errorCallback!({
      stage: 'downloading',
      message: '无法连接代理 (EHOSTUNREACH)',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      suggestion: 'macOS 未授予「本地网络」权限',
    })

    // 验证 toast 被调用（D4: singleton trigger）
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('无法连接代理 (EHOSTUNREACH)')
  })

  it('W3-A3-toast-trigger-vitest: toast 只弹摘要不弹 suggestion', async () => {
    let errorCallback: ((e: { stage: string; message: string; errorCode?: string; suggestion?: string }) => void) | null = null
    onUpdateErrorMock.mockImplementation((cb: typeof errorCallback) => {
      errorCallback = cb
      return () => {}
    })

    const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
    useAppUpdate()

    errorCallback!({
      stage: 'downloading',
      message: '无法连接代理 (EHOSTUNREACH)',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      suggestion: '很长的恢复指引文案...',
    })

    // toast 只传 message，不传 suggestion
    expect(toastErrorMock).toHaveBeenCalledWith('无法连接代理 (EHOSTUNREACH)')
    // 确保 suggestion 不在 toast 参数中
    const callArgs = toastErrorMock.mock.calls[0]
    expect(callArgs.length).toBe(1) // 只有一个参数
  })
})
