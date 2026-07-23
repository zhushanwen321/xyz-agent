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
import { createPinia, setActivePinia } from 'pinia'

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
import { sendExtensionUIResponse, getPendingRequests } from '@/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'

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
  // T2 后 pending 状态归属 extensionUIStore（pinia store）→ 每个测试用新 pinia 实例隔离，
  // 避免 store 单例跨测试残留污染（对齐 W2 前用 useSessionScopedState 时清 registry 的作用）。
  setActivePinia(createPinia())
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

// ── TC4：requestId 去重（T3 直接验证）──
// 两条入队通路（实时帧 onUIRequest + 切回拉取 getPendingRequests）可能对同一 requestId 各投一次。
// T2 后 runtime 返回完整快照，切回拉取会重复包含已通过实时帧入队的请求 → 需按 requestId 去重。
// 验证策略：useExtensionUI 不直接暴露 queue，用用户可见行为（currentAskUserRequest 指向 + respond 后状态）
// 间接验证。去重失败的关键信号：respond(r1) 后若存在第二个 r1，currentAskUserRequest 仍指向 r1（而非 r2）。

describe('useExtensionUI requestId 去重（实时帧 + 切回拉取）', () => {
  beforeEach(() => {
    // 每个测试前重置 getPendingRequests mock（默认空）
    vi.mocked(getPendingRequests).mockResolvedValue([])
  })

  it('TC4-a: 实时帧先入队，切回拉取同 requestId 不重复入队', async () => {
    // 场景：用户在 sessionA 时实时帧已把 r1 入队；切走再切回，拉取返回 [r1, r2]
    // 期望：queue 最终只有 [r1, r2]（r1 不重复）
    const sid = ref<string | null>('sessionA')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid, askUserFilter))

    // 1. 实时帧入 r1
    emitUIRequest('sessionA', mkAskUserReq('sessionA', 'r1'))
    expect(result.currentAskUserRequest.value?.requestId).toBe('r1')

    // 2. 切到 B（此时不再有 pending），mock 切回时拉取返回 [r1, r2]
    sid.value = 'sessionB'
    await nextTick()

    // 3. 切回 A：拉取会返回 [r1, r2]，但 r1 已在队列（实时帧入的），去重后只入 r2
    vi.mocked(getPendingRequests).mockResolvedValue([
      mkAskUserReq('sessionA', 'r1'),
      mkAskUserReq('sessionA', 'r2'),
    ])
    sid.value = 'sessionA'
    await nextTick()
    // 等待 getPendingRequests 的 Promise resolve + queueState 更新
    await nextTick()
    await nextTick()

    // 4. 关键去重断言：currentAskUserRequest 仍指向 r1（队首未变，没有重复 r1 把状态搞乱）
    expect(result.currentAskUserRequest.value?.requestId).toBe('r1')

    // 5. respond(r1) 后 currentAskUserRequest 应晋升为 r2 —— 若有重复 r1 入队，
    //    respond 只 splice 第一个 r1，currentAskUserRequest 仍会命中第二个 r1（去重失败信号）
    result.respond('r1', true)
    expect(result.currentAskUserRequest.value?.requestId).toBe('r2')

    // 6. respond(r1) 只发送一次（去重不会触发重复响应）
    const r1Calls = vi.mocked(sendExtensionUIResponse).mock.calls.filter(
      (c) => c[1] === 'r1',
    )
    expect(r1Calls).toHaveLength(1)

    dispose()
  })

  it('TC4-b: 拉取先入队，后续实时帧同 requestId 不重复入队', async () => {
    // 反向场景：切回时拉取入 r1，之后实时帧又推 r1（runtime 重放 / 重复推送）
    // 期望：queue 只有 1 个 r1，respond(r1) 后 currentAskUserRequest 变 undefined
    const sid = ref<string | null>('sessionA')
    // 切回 A 时拉取返回 [r1]
    vi.mocked(getPendingRequests).mockResolvedValue([mkAskUserReq('sessionA', 'r1')])
    const { result, dispose } = runWithScope(() => useExtensionUI(sid, askUserFilter))

    // 等待拉取 Promise resolve（初始 subscribe 即触发一次 getPendingRequests）
    await nextTick()
    await nextTick()

    // 拉取入队后 currentAskUserRequest 指向 r1
    expect(result.currentAskUserRequest.value?.requestId).toBe('r1')

    // 模拟实时帧又推一次 r1（同 requestId）—— 去重应跳过，不入第二份
    emitUIRequest('sessionA', mkAskUserReq('sessionA', 'r1'))

    // 关键去重断言：respond(r1) 后 currentAskUserRequest 应为 undefined（队列里只有 1 个 r1）。
    // 若去重失败入了两个 r1，respond splice 第一个后 currentAskUserRequest 仍命中第二个 r1。
    result.respond('r1', true)
    expect(result.currentAskUserRequest.value).toBeUndefined()

    // respond(r1) 只发一次
    const r1Calls = vi.mocked(sendExtensionUIResponse).mock.calls.filter(
      (c) => c[1] === 'r1',
    )
    expect(r1Calls).toHaveLength(1)

    dispose()
  })
})
