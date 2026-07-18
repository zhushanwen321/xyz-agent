/**
 * useExtensionUI per-sessionId 队列隔离单测（W1: U1/U2/U3）。
 *
 * 验证从模块级单例 queue 重构为 per-sessionId 分区后：
 * - U1: 两个 session 各有 ui_request，互不串扰（ask-user 与 dialog 分离）
 * - U2: 按 requestId 精确 respond/cancel（不假设队首）
 * - U3: ui_timeout 按 requestId 精确出队
 *
 * 运行：npx vitest run src/__tests__/composables/useExtensionUI.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

// ── mock extension api domain ──
// 拦截 onUIRequest / onUITimeout / sendExtensionUIResponse，让测试能模拟 WS 事件分发。
// onUIRequest/onUITimeout 捕获 handler 到各自的 map，测试通过 emitXxx 触发。
const uiRequestHandlers = new Map<string, (req: unknown) => void>()
const uiTimeoutHandlers = new Map<string, (requestId: string) => void>()

vi.mock('@/api/domains/extension', () => ({
  onUIRequest: (sid: string, handler: (req: unknown) => void) => {
    uiRequestHandlers.set(sid, handler)
    return () => uiRequestHandlers.delete(sid)
  },
  onUITimeout: (sid: string, handler: (requestId: string) => void) => {
    uiTimeoutHandlers.set(sid, handler)
    return () => uiTimeoutHandlers.delete(sid)
  },
  sendExtensionUIResponse: vi.fn(),
  onNotify: () => () => {},
  // subscribe 切换 session 时拉取缓存的 pending 请求；测试默认返回空数组
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

import { useExtensionUI } from '@/composables/useExtensionUI'
import { sendExtensionUIResponse } from '@/api/domains/extension'

// ── 测试数据构造 helper ──
function mkAskUserReq(sid: string, requestId: string) {
  return {
    sessionId: sid,
    requestId,
    method: 'select' as const,
    askUser: true,
    askUserQuestions: [{ header: 'q', question: 'q?', options: [] }],
    allowCancel: true,
  }
}
function mkDialogReq(sid: string, requestId: string, method: 'confirm' | 'select' | 'input' = 'confirm') {
  return { sessionId: sid, requestId, method, title: 't' }
}

/** 触发某 session 的 ui_request 事件 */
function emitUIRequest(sid: string, req: unknown): void {
  uiRequestHandlers.get(sid)?.(req)
}
/** 触发某 session 的 ui_timeout 事件 */
function emitUITimeout(sid: string, requestId: string): void {
  uiTimeoutHandlers.get(sid)?.(requestId)
}

beforeEach(() => {
  uiRequestHandlers.clear()
  uiTimeoutHandlers.clear()
  vi.mocked(sendExtensionUIResponse).mockClear()
})

describe('useExtensionUI U1 per-sessionId 队列隔离', () => {
  it('sessionA 的 ask-user 与 sessionB 的 confirm 互不串扰', () => {
    const { currentAskUserRequest: aAsk, currentDialogRequest: aDlg } = useExtensionUI(ref('sessionA'))
    const { currentAskUserRequest: bAsk, currentDialogRequest: bDlg } = useExtensionUI(ref('sessionB'))

    // sessionA 收到 ask-user，sessionB 收到 confirm
    emitUIRequest('sessionA', mkAskUserReq('sessionA', 'r-a1'))
    emitUIRequest('sessionB', mkDialogReq('sessionB', 'r-b1', 'confirm'))

    // sessionA：ask-user 有值，dialog 无
    expect(aAsk.value).toBeDefined()
    expect(aAsk.value?.sessionId).toBe('sessionA')
    expect(aAsk.value?.requestId).toBe('r-a1')
    expect(aDlg.value).toBeUndefined()

    // sessionB：dialog 有值，ask-user 无
    expect(bDlg.value).toBeDefined()
    expect(bDlg.value?.method).toBe('confirm')
    expect(bAsk.value).toBeUndefined()
  })
})

describe('useExtensionUI U2 按 requestId 精确 respond', () => {
  it('队列含 3 个请求（混杂），respond 指定 requestId → 仅该请求出队 + 发送正确响应', () => {
    const { respond, currentAskUserRequest, currentDialogRequest } = useExtensionUI(ref('sessionA'))
    // 入队顺序：ask-user, confirm, select
    emitUIRequest('sessionA', mkAskUserReq('sessionA', 'r-ask'))
    emitUIRequest('sessionA', mkDialogReq('sessionA', 'r-confirm', 'confirm'))
    emitUIRequest('sessionA', mkDialogReq('sessionA', 'r-select', 'select'))

    // respond 中间的 confirm（不是队首）
    respond('r-confirm', true)

    // sendExtensionUIResponse 参数正确
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-confirm', 'confirm', true)
    // r-confirm 从队列消失（不再被 currentDialogRequest 命中）
    // 剩余：r-ask（ask-user 队首）、r-select（dialog 队首）
    expect(currentAskUserRequest.value?.requestId).toBe('r-ask')
    expect(currentDialogRequest.value?.requestId).toBe('r-select')
  })

  it('cancel 传入 requestId 等价于 respond(null)', () => {
    const { cancel } = useExtensionUI(ref('sessionA'))
    emitUIRequest('sessionA', mkAskUserReq('sessionA', 'r-x'))

    cancel('r-x')
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-x', 'select', null)
  })

  it('W5: 队列两个 confirm，respond 首个后第二个晋升为 currentDialogRequest', () => {
    const { respond, currentDialogRequest } = useExtensionUI(ref('sessionA'))
    emitUIRequest('sessionA', mkDialogReq('sessionA', 'r-confirm-a', 'confirm'))
    emitUIRequest('sessionA', mkDialogReq('sessionA', 'r-confirm-b', 'confirm'))

    // respond 第一个
    expect(currentDialogRequest.value?.requestId).toBe('r-confirm-a')
    respond('r-confirm-a', true)

    // 第二个晋升为 currentDialogRequest
    expect(currentDialogRequest.value?.requestId).toBe('r-confirm-b')
  })
})

describe('useExtensionUI U3 ui_timeout 按 requestId 精确出队', () => {
  it('队列含 2 个请求，超时其一 → 仅该请求出队，另一个保留', () => {
    const { currentAskUserRequest, currentDialogRequest } = useExtensionUI(ref('sessionA'))
    emitUIRequest('sessionA', mkAskUserReq('sessionA', 'r-keep'))
    emitUIRequest('sessionA', mkDialogReq('sessionA', 'r-timeout', 'confirm'))

    // r-timeout 超时
    emitUITimeout('sessionA', 'r-timeout')

    // r-timeout 消失，r-keep 保留
    expect(currentDialogRequest.value).toBeUndefined()
    expect(currentAskUserRequest.value?.requestId).toBe('r-keep')
  })
})
