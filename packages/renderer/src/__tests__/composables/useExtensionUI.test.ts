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
import { effectScope, ref, nextTick } from 'vue'

// ── mock extension api domain ──
// 拦截 onUIRequest / onUITimeout / sendExtensionUIResponse，让测试能模拟 WS 事件分发。
// onUIRequest/onUITimeout 捕获 handler 到各自的列表（同 sid 多订阅共存，对齐真实 events.on 的 Set 语义），
// 测试通过 emitXxx 触发所有该 sid 的 handler（split 双 panel 同 sid 分流测试依赖此）。
const uiRequestHandlers = new Map<string, Array<(req: unknown) => void>>()
const uiTimeoutHandlers = new Map<string, Array<(requestId: string) => void>>()

vi.mock('@/api/domains/extension', () => ({
  onUIRequest: (sid: string, handler: (req: unknown) => void) => {
    const arr = uiRequestHandlers.get(sid) ?? []
    arr.push(handler)
    uiRequestHandlers.set(sid, arr)
    return () => {
      const cur = uiRequestHandlers.get(sid)
      if (!cur) return
      const idx = cur.indexOf(handler)
      if (idx !== -1) cur.splice(idx, 1)
      if (cur.length === 0) uiRequestHandlers.delete(sid)
    }
  },
  onUITimeout: (sid: string, handler: (requestId: string) => void) => {
    const arr = uiTimeoutHandlers.get(sid) ?? []
    arr.push(handler)
    uiTimeoutHandlers.set(sid, arr)
    return () => {
      const cur = uiTimeoutHandlers.get(sid)
      if (!cur) return
      const idx = cur.indexOf(handler)
      if (idx !== -1) cur.splice(idx, 1)
      if (cur.length === 0) uiTimeoutHandlers.delete(sid)
    }
  },
  sendExtensionUIResponse: vi.fn(),
  onNotify: () => () => {},
  // subscribe 切换 session 时拉取缓存的 pending 请求；测试默认返回空数组
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

import { useExtensionUI, askUserFilter, dialogFilter } from '@/composables/useExtensionUI'
import { sendExtensionUIResponse } from '@/api/domains/extension'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

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
  uiRequestHandlers.get(sid)?.forEach((h) => h(req))
}
/** 触发某 session 的 ui_timeout 事件 */
function emitUITimeout(sid: string, requestId: string): void {
  uiTimeoutHandlers.get(sid)?.forEach((h) => h(requestId))
}

beforeEach(() => {
  // 模块级 cleanup registry 跨测试可能残留（本文件用 useExtensionUI 不包 effectScope，
  // onScopeDispose 在测试环境无 scope 不触发反注册）→ 显式清空防污染下游断言
  __clearSessionCleanupRegistryForTest()
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

// ── AC-1/AC-2/AC-6：同一 composable 实例切换 sessionId 的隔离（W2 新增，TDD 红灯） ──
// 当前实现 watch(sessionId) 切换时只退订 WS、不清 queue.value → A 的 pending 残留到 B。
// W2 改 Map 分区后这些用例转绿。

/** 在独立 effectScope 内运行，模拟单 Panel 实例的完整生命周期 */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

describe('useExtensionUI AC-1/AC-2 同实例切 session 隔离', () => {
  it('AC-1: 同一实例 sessionId 从 A 切到 B 后 currentAskUserRequest 变 undefined', async () => {
    const sid = ref<string | null>('sessionA')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid))

    // A 收到 ask-user pending
    emitUIRequest('sessionA', mkAskUserReq('sessionA', 'r-a1'))
    expect(result.currentAskUserRequest.value?.requestId).toBe('r-a1')

    // 同一实例切到 B
    sid.value = 'sessionB'
    await nextTick()

    // B 没有 ask-user 请求时，currentAskUserRequest 必须是 undefined（A 的 pending 不应残留）
    expect(result.currentAskUserRequest.value).toBeUndefined()

    dispose()
  })

  it('AC-2: 切回 A 后 pending ask-user overlay 恢复显示', async () => {
    const sid = ref<string | null>('sessionA')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid))

    emitUIRequest('sessionA', mkAskUserReq('sessionA', 'r-a1'))
    sid.value = 'sessionB'
    await nextTick()
    expect(result.currentAskUserRequest.value).toBeUndefined()

    // 切回 A：A 的 pending 请求应恢复（Map 分区天然保留，不丢数据）
    sid.value = 'sessionA'
    await nextTick()
    expect(result.currentAskUserRequest.value).toBeDefined()
    expect(result.currentAskUserRequest.value?.requestId).toBe('r-a1')

    dispose()
  })

  it('AC-1 (dialog): 同一实例切 session 后 currentDialogRequest 不残留旧 session 的 confirm', async () => {
    const sid = ref<string | null>('sessionA')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid))

    emitUIRequest('sessionA', mkDialogReq('sessionA', 'r-dlg-a', 'confirm'))
    expect(result.currentDialogRequest.value?.requestId).toBe('r-dlg-a')

    sid.value = 'sessionB'
    await nextTick()
    // B 没有 dialog 时 currentDialogRequest 应 undefined
    expect(result.currentDialogRequest.value).toBeUndefined()

    // 切回 A 恢复
    sid.value = 'sessionA'
    await nextTick()
    expect(result.currentDialogRequest.value?.requestId).toBe('r-dlg-a')

    dispose()
  })
})

describe('useExtensionUI AC-6 split 双 panel 同 sid 分流', () => {
  it('askUserFilter 与 dialogFilter 在同 sid 下分流：ask-user 只入 Panel，dialog 只入 Dialog modal', () => {
    // split 模式：两个 Panel 实例订阅同一 sid，但 filter 不同（Panel 入 askUser，Dialog 入非 askUser）
    const sid = ref<string | null>('shared')
    const { result: panelInstance } = runWithScope(() =>
      useExtensionUI(sid, askUserFilter),
    )
    const { result: dialogInstance } = runWithScope(() =>
      useExtensionUI(sid, dialogFilter),
    )

    // 同 sid 推 ask-user + confirm
    emitUIRequest('shared', mkAskUserReq('shared', 'r-ask'))
    emitUIRequest('shared', mkDialogReq('shared', 'r-confirm', 'confirm'))

    // Panel（askUserFilter）只看到 ask-user
    expect(panelInstance.currentAskUserRequest.value?.requestId).toBe('r-ask')
    expect(panelInstance.currentDialogRequest.value).toBeUndefined()

    // Dialog modal（dialogFilter）只看到 confirm
    expect(dialogInstance.currentDialogRequest.value?.requestId).toBe('r-confirm')
    expect(dialogInstance.currentAskUserRequest.value).toBeUndefined()
  })

  it('split 双 panel 同 sid 切走后两边都不残留对方 filter 的请求', async () => {
    const sidA = ref<string | null>('sid-shared')
    const sidB = ref<string | null>('sid-shared')
    const { result: panelA } = runWithScope(() => useExtensionUI(sidA, askUserFilter))
    const { result: dialogA } = runWithScope(() => useExtensionUI(sidB, dialogFilter))

    emitUIRequest('sid-shared', mkAskUserReq('sid-shared', 'r-ask'))
    emitUIRequest('sid-shared', mkDialogReq('sid-shared', 'r-confirm', 'confirm'))

    // 两 panel 同时切走（模拟用户切到另一 session）
    sidA.value = 'other'
    sidB.value = 'other'
    await nextTick()

    expect(panelA.currentAskUserRequest.value).toBeUndefined()
    expect(dialogA.currentDialogRequest.value).toBeUndefined()
  })
})
