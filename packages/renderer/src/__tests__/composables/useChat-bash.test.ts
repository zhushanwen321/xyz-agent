/**
 * useChat.sendBash / abortBash 单测（composer-bash-execute W2）。
 *
 * 验证：
 * - T4: sendBash('s1','git status',false) → chatApi.bash 透传（sid, command, excludeFromContext）
 * - T5: chatApi.bash reject → toastError 被调 + sendBash 不 throw（resolve，与 send/abort 同策略）
 *
 * 策略：mock @/api（chatApi.bash/abortBash + streamSubscribe 等）+ 真 pinia + 真 chatStore。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useChat-bash.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage } from '@xyz-agent/shared'

// ── api mock ──
const apiMock = vi.hoisted(() => ({
  bash: vi.fn(() => Promise.resolve()),
  abortBash: vi.fn(() => Promise.resolve()),
  streamSubscribe: vi.fn((_sid: string, _handler: (msg: ServerMessage) => void) => () => {}),
}))

vi.mock('@/api', () => ({
  chat: {
    bash: apiMock.bash,
    abortBash: apiMock.abortBash,
    streamSubscribe: apiMock.streamSubscribe,
  },
}))

// ── useToast mock：捕获 error 调用 ──
const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError }),
}))

import { useChat, resetChatModuleState } from '@/composables/features/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
})

describe('useChat.sendBash / abortBash', () => {
  it('T4: sendBash 透传参数给 chatApi.bash（含 excludeFromContext）', async () => {
    const { sendBash } = useChat()
    await sendBash('s1', 'git status', false)

    expect(apiMock.bash).toHaveBeenCalledOnce()
    expect(apiMock.bash).toHaveBeenCalledWith('s1', 'git status', false)
    // 失败时才 toast，成功路径不调
    expect(toastError).not.toHaveBeenCalled()
  })

  it('T5: chatApi.bash reject → toastError 被调 + sendBash resolve（不 throw）', async () => {
    apiMock.bash.mockRejectedValueOnce(new Error('boom'))
    const { sendBash } = useChat()

    // 不应 throw（错误已通过 toast 消化，与 send/abort 同策略）
    await expect(sendBash('s1', 'ls', false)).resolves.toBeUndefined()

    expect(apiMock.bash).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledOnce()
  })

  it('T6: abortBash 透传参数给 chatApi.abortBash', async () => {
    const { abortBash } = useChat()
    await abortBash('s1')

    expect(apiMock.abortBash).toHaveBeenCalledOnce()
    expect(apiMock.abortBash).toHaveBeenCalledWith('s1')
  })
})
