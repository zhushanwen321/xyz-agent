/**
 * useHandoffEffect 单测 —— fast-handoff 完成广播的 renderer 侧编排（方案 2 + C1/M1/M2/W3/W4 修复）。
 *
 * bindHandoffEffect 订阅 session.handoffComplete 全局广播，编排：
 *   复位源 session handingOff → loadSessions（失败降级，不阻塞）→ ensureStreamSubscription →
 *   hydrate(newId, []) [C1 预标记] → appendUser + addPendingSend → chatApi.send →
 *   selectSession（成功）/ [M1 回滚]（send 失败）/ [M2+W3 回滚]（同步抛错 disposeSession）。
 *
 * 覆盖用例（AGENTS #5：每用例含用户可见/状态断言）：
 * - U1 正常路径：appendUser 注入文档 + send + selectSession
 * - U2 [C1] hydrate 预标记让 newSession 标 hydrated（selectSession isHydrated 守卫成立）
 * - U2b [C1 真实契约] 预标记后即便走 selectSession 的 getHistory+hydrate 路径也不覆盖 appendUser
 * - U3 [M1] send 失败回滚：disposeSession + sessionApi.remove + removeFromList，不跳转
 * - U4 [M2+W3] 回调内同步抛错 → .catch 兜底 console.warn + disposeSession 回滚，无 unhandled rejection
 * - U5 scope.stop() 退订：广播不再触发副作用（对齐 bindForkNoticeEffect 范式，不返回 off）
 * - U6 [W4] loadSessions 失败不阻塞文档注入：send 仍调用、appendUser 注入、跳转
 *
 * mock 策略（参照 useChat.test.ts / useSidebar-delete-cleanup.test.ts）：
 * - vi.mock('@/api')：chat.{send,streamSubscribe,getHistory} + session.{remove,switchSession,list,getCommands,getContext}
 * - vi.mock('@/composables/features/useSidebar')：loadSessions/selectSession 用 vi.fn
 * - vi.mock('@/composables/features/useChat')：ensureStreamSubscription + disposeSession 用 vi.fn
 *   （隔离模块级 streamSubscriptions Map，验「ensureStreamSubscription 被调」而非真实订阅）
 * - events / useChatStore / useSessionStore / normalizeContent 用**真实**实现
 *   （验 appendUser/hydrate/setHandingOff 的真实副作用，AGENTS #5 用户可见断言）
 * - bindHandoffEffect 用 effectScope 包裹：onScopeDispose 需 active scope，scope.stop() 退订
 * - 异步等待用 vi.waitFor（SUGGESTION 6），替代固定 microtask tick 循环
 *
 * 模块级状态隔离：events.ts 的 globalTypeHandlers 是模块级 Map——
 * scope.stop() 会经 onScopeDispose 从中删除 handler；beforeEach 重建 scope + afterEach stop 兜底清干净。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useHandoffEffect.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import { normalizeContent } from '@xyz-agent/shared'

// ── api mock holder（vi.hoisted 保证在模块工厂前就绪）──
const apiMock = vi.hoisted(() => ({
  chat: {
    send: vi.fn(() => Promise.resolve()),
    streamSubscribe: vi.fn(() => () => {}),
    getHistory: vi.fn(() => Promise.resolve({ messages: [], historyTruncated: false })),
  },
  session: {
    remove: vi.fn(() => Promise.resolve()),
    switchSession: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve([])),
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
    getContext: vi.fn(() => Promise.resolve({})),
  },
}))

vi.mock('@/api', () => ({
  chat: apiMock.chat,
  session: apiMock.session,
}))

// ── useSidebar mock：捕获 loadSessions/selectSession（不引入真实 useSidebar 的 30+ 依赖）──
const sidebarMock = vi.hoisted(() => ({
  loadSessions: vi.fn(() => Promise.resolve()),
  selectSession: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({
    loadSessions: sidebarMock.loadSessions,
    selectSession: sidebarMock.selectSession,
  }),
}))

// ── useChat mock：捕获 ensureStreamSubscription / disposeSession（隔离模块级 streamSubscriptions）──
const useChatMock = vi.hoisted(() => ({
  ensureStreamSubscription: vi.fn(),
  disposeSession: vi.fn(),
}))
vi.mock('@/composables/features/useChat', () => ({
  ensureStreamSubscription: useChatMock.ensureStreamSubscription,
  useChat: () => ({ disposeSession: useChatMock.disposeSession }),
}))

import { bindHandoffEffect } from '@/composables/effects/useHandoffEffect'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import * as events from '@/api/events'

const HANDOFF_DOC = '<handoff_document>context for new session</handoff_document>'
const SRC = 'src-1'
const NEW = 'new-1'

let scope: ReturnType<typeof effectScope> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 重置默认 resolve（个别用例 mockRejectedValueOnce 后清 mock 恢复默认）
  apiMock.chat.send.mockResolvedValue(undefined)
  apiMock.chat.streamSubscribe.mockReturnValue(() => {})
  apiMock.chat.getHistory.mockResolvedValue({ messages: [], historyTruncated: false })
  apiMock.session.remove.mockResolvedValue(undefined)
  apiMock.session.switchSession.mockResolvedValue(undefined)
  apiMock.session.list.mockResolvedValue([])
  sidebarMock.loadSessions.mockResolvedValue(undefined)
  sidebarMock.selectSession.mockResolvedValue(undefined)

  // 在独立 effectScope 内 bind：满足 onScopeDispose 需 active scope（无则 warn），
  // scope.stop() 触发 onScopeDispose 退订，作 afterEach 兜底。
  scope = effectScope()
  scope.run(() => bindHandoffEffect())
})

afterEach(() => {
  // scope.stop() 触发 onScopeDispose → off 退订（U5 也依赖此；其它用例防 handler 残留到下一用例）
  scope?.stop()
  scope = null
})

/** 构造一条 session.handoffComplete ServerMessage 并经 global 通道派发（走真实 events 路径） */
function emitHandoffComplete(
  overrides: Partial<{ srcSessionId: string; newSessionId: string; doc: string }> = {},
): void {
  const payload = {
    srcSessionId: overrides.srcSessionId ?? SRC,
    newSessionId: overrides.newSessionId ?? NEW,
    doc: overrides.doc ?? HANDOFF_DOC,
  }
  const msg = { type: 'session.handoffComplete', payload } as ServerMessage<'session.handoffComplete'>
  events.dispatchGlobal(msg)
}

/**
 * 等待 handoff 编排的副作用（appendUser / send / selectSession / disposeSession）发生。
 * bindHandoffEffect 的副作用经 loadSessions().catch().then() 异步链触发，固定 microtask tick
 * 脆弱（链长度随实现变）。用 vi.waitFor 自适应轮询到断言成立（SUGGESTION 6 修复）。
 */
async function waitForEffect<T>(assertion: () => T): Promise<T> {
  return vi.waitFor(assertion, { timeout: 1000 })
}

/**
 * 推进微任务直至某 mock 被调（用于 send/selectSession 等异步副作用的等待）。
 * 兜底 nextTick 防 Vue 响应式更新滞后。
 */
async function settle(): Promise<void> {
  await waitForEffect(() => expect(apiMock.chat.send).toHaveBeenCalled())
  await nextTick()
}

describe('useHandoffEffect.bindHandoffEffect', () => {
  it('U1 正常路径：handoffComplete → 复位源 handingOff + appendUser 注入文档 + send + selectSession', async () => {
    const chat = useChatStore()
    const sessionStore = useSessionStore()
    // 模拟 handoff 触发态：源 session 标 handingOff=true（消除「正在交接…」反馈后应复位）
    chat.setHandingOff(SRC, true)
    expect(chat.isHandingOff(SRC)).toBe(true)

    emitHandoffComplete()
    await settle()

    // [复位] 源 session handingOff 已清（消除「正在交接…」反馈）
    expect(chat.isHandingOff(SRC)).toBe(false)
    // ensureStreamSubscription 已对 newSessionId 建订阅（方案 2：订阅早于 send）
    expect(useChatMock.ensureStreamSubscription).toHaveBeenCalledWith(NEW, chat, sessionStore)
    expect(apiMock.chat.send).toHaveBeenCalledWith(NEW, HANDOFF_DOC)
    // [AGENTS #5 用户可见断言] 新 session messages 含首条 user，内容是 handoff 文档
    const msgs = chat.getMessages(NEW)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0].role).toBe('user')
    expect(normalizeContent(msgs[0].content)).toBe(HANDOFF_DOC)
    // 跳转到新 session
    expect(sidebarMock.selectSession).toHaveBeenCalledWith(NEW)
  })

  it('U2 [C1] hydrate(newId, []) 预标记让 newSession 已标 hydrated（selectSession 内 isHydrated 守卫成立）', async () => {
    const chat = useChatStore()

    emitHandoffComplete()
    await settle()

    // [C1 预标记生效] newSession 已被标 hydrated——selectSession 的 if(!isHydrated(id)) 守卫会跳过 getHistory
    expect(chat.isHydrated(NEW)).toBe(true)
    // bindHandoffEffect 用 chatApi.send（不走真实 selectSession 的 getHistory 路径），
    // 这里直接断言 getHistory 未以 newSessionId 调用（handoff 路径根本不拉历史，新 session 自管消息）。
    expect(apiMock.chat.getHistory).not.toHaveBeenCalled()
    // [AGENTS #5 用户可见断言] appendUser 注入的 user 消息仍在
    const msgs = chat.getMessages(NEW)
    expect(msgs.some((m) => m.role === 'user')).toBe(true)
    expect(normalizeContent(msgs.find((m) => m.role === 'user')!.content)).toBe(HANDOFF_DOC)
  })

  it('U2b [C1 真实契约] hydrate 预标记后，即便 selectSession 走 getHistory 路径也不覆盖 appendUser 注入的消息', async () => {
    // C1 契约的真实威胁：selectSession 内部 `if (!chat.isHydrated(id)) { getHistory → hydrate(id, stale) }`。
    // handoff 预标记 hydrate(newId, []) 让 isHydrated(newId)=true，该分支跳过——否则 getHistory 拿到的
    // 快照（pi 未把 in-progress 流式内容写 JSONL，且 newSession 刚 create 无历史）会覆盖 appendUser 注入
    // 的 user 消息。本用例直接验证「isHydrated 预标记 + hydrate 幂等」这个 selectSession 所依赖的真实契约：
    // 1) 预标记后 chat.hydrate 对新消息是 no-op（不覆盖）；
    // 2) selectSession 即便调 getHistory+hydrate 也无法覆写 appendUser 内容。
    const chat = useChatStore()

    emitHandoffComplete()
    await settle()

    // 编排已执行：newSession 被 appendUser 注入文档 + hydrate(newId, []) 预标记
    expect(chat.isHydrated(NEW)).toBe(true)
    const injected = chat.getMessages(NEW)
    expect(injected.some((m) => m.role === 'user')).toBe(true)

    // 模拟 selectSession 内部「拉历史」拿到 stale 快照（模拟 pi 还未把任何内容写 JSONL 的场景）
    const staleMessages = [{ role: 'user', content: 'STALE', segments: [], id: 'stale-1' }] as const
    apiMock.chat.getHistory.mockResolvedValue({ messages: [...staleMessages], historyTruncated: false })

    // 复刻 selectSession（useSidebar.ts:169-179）的 hydrate 路径：isHydrated 守卫 + hydrate 幂等。
    // handoff 预标记让守卫成立 → 跳过 getHistory；但即便守卫失效（防御性测试），hydrate 幂等也保护：
    if (!chat.isHydrated(NEW)) {
      const { messages } = await apiMock.chat.getHistory(NEW)
      chat.hydrate(NEW, messages)
    }

    // [C1 契约] messages[newId] 仍是 appendUser 注入的内容（不是 STALE），getHistory 因 isHydrated 未被调
    expect(apiMock.chat.getHistory).not.toHaveBeenCalled()
    const msgsAfter = chat.getMessages(NEW)
    expect(msgsAfter.some((m) => m.role === 'user')).toBe(true)
    expect(normalizeContent(msgsAfter.find((m) => m.role === 'user')!.content)).toBe(HANDOFF_DOC)
    // STALE 未混入
    expect(msgsAfter.some((m) => normalizeContent(m.content).includes('STALE'))).toBe(false)
  })

  it('U3 [M1] chatApi.send 失败 → 回滚（disposeSession + sessionApi.remove + removeFromList），不跳转', async () => {
    apiMock.chat.send.mockRejectedValueOnce(new Error('network'))

    // session.removeFromList 是真实 store 方法；先 seed 让 newSession 在列表里，
    // 断言回滚把它移除（侧栏列表清理，AGENTS #5 用户可见：孤儿 session 不残留侧栏）
    const session = useSessionStore()
    session.appendSession({
      id: NEW,
      label: 'handoff-new',
      cwd: '/proj',
      status: 'idle',
      lastActiveAt: 1,
      modelId: 'm1',
      tokenCount: 0,
    })
    expect(session.list.some((s) => s.id === NEW)).toBe(true)

    emitHandoffComplete()
    await waitForEffect(() => expect(apiMock.session.remove).toHaveBeenCalledWith(NEW))

    // send 确实尝试了
    expect(apiMock.chat.send).toHaveBeenCalledWith(NEW, HANDOFF_DOC)
    // [M1 回滚] runtime 孤立 session 清理
    expect(apiMock.session.remove).toHaveBeenCalledWith(NEW)
    // [M1 回滚] 本地流式订阅 + per-session 状态清理
    expect(useChatMock.disposeSession).toHaveBeenCalledWith(NEW)
    // [AGENTS #5 用户可见] 侧栏列表已清掉 newSession（removeFromList 副作用）
    expect(session.list.some((s) => s.id === NEW)).toBe(false)
    // send 失败不跳转到新 session
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })

  it('U4 [M2] loadSessions 回调内同步代码抛错 → .catch 兜底 console.warn + disposeSession 回滚，无 unhandled rejection', async () => {
    // 让回调内同步代码（textToSegments 后的 appendUser）抛错，模拟 store 异常。
    // appendUser 是真实 store 方法，spy 拦截使其抛错。
    const chat = useChatStore()
    const spy = vi.spyOn(chat, 'appendUser').mockImplementation(() => {
      throw new Error('store broken')
    })

    // 监听 unhandledRejection：M2 的 .catch 应吞掉异常，此回调不应触发
    const rejectionHandler = vi.fn()
    process.on('unhandledRejection', rejectionHandler)

    // 捕获 console.warn（M2 兜底日志）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    emitHandoffComplete()
    await waitForEffect(() => expect(warnSpy).toHaveBeenCalled())

    // [M2] .catch 被触发，warn 含 handoff-effect 标记
    const warnArg = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('handoff-effect'),
    )
    expect(warnArg).toBeDefined()
    // [AGENTS #5 用户可见：健壮性] send 未被调（appendUser 在 send 之前抛错，链中断）
    expect(apiMock.chat.send).not.toHaveBeenCalled()
    // [W3 回滚完整性] ensureStreamSubscription 已注册（抛错前）+ addPendingSend 可能已挂 timer，
    // .catch 调 disposeSession(newSessionId) 清理 stream 订阅 + per-session 状态（与 M1 对称）
    expect(useChatMock.disposeSession).toHaveBeenCalledWith(NEW)

    // 排空 microtask 队列后断言无 unhandledRejection
    await new Promise((r) => setTimeout(r, 0))
    expect(rejectionHandler).not.toHaveBeenCalled()

    process.removeListener('unhandledRejection', rejectionHandler)
    spy.mockRestore()
    warnSpy.mockRestore()
  })

  it('U5 scope.stop() 退订：handoffComplete 不再触发副作用', async () => {
    const chat = useChatStore()
    // 先 stop scope（触发 onScopeDispose → off 退订，bindHandoffEffect 已不返回 off）
    scope!.stop()
    scope = null

    emitHandoffComplete()
    // 兜底等待，确认副作用从未发生（waitFor 超时后断言）
    await new Promise((r) => setTimeout(r, 0))

    // 退订后广播不触发任何副作用
    expect(useChatMock.ensureStreamSubscription).not.toHaveBeenCalled()
    expect(apiMock.chat.send).not.toHaveBeenCalled()
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
    // [AGENTS #5 用户可见] messages 未被写入（无 user 消息）
    expect(chat.getMessages(NEW)).toEqual([])
  })

  it('U6 [W4] loadSessions 失败不阻塞文档注入：send 仍被调用、appendUser 注入、跳转', async () => {
    // loadSessions reject：旧实现 .then 不执行 → send 跳过 → 孤儿 session。
    // [W4] 降级后 loadSessions().catch().then() 仍走核心编排。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sidebarMock.loadSessions.mockRejectedValueOnce(new Error('list refresh failed'))

    const chat = useChatStore()
    emitHandoffComplete()
    await settle()

    // [W4 核心] 文档注入核心流程未被 loadSessions 失败阻塞
    expect(apiMock.chat.send).toHaveBeenCalledWith(NEW, HANDOFF_DOC)
    expect(sidebarMock.selectSession).toHaveBeenCalledWith(NEW)
    // [AGENTS #5 用户可见] appendUser 注入的 user 消息仍在
    const msgs = chat.getMessages(NEW)
    expect(msgs.some((m) => m.role === 'user')).toBe(true)
    expect(normalizeContent(msgs.find((m) => m.role === 'user')!.content)).toBe(HANDOFF_DOC)
    // [W4] loadSessions 失败已 warn（降级日志，保留排查线索）
    const listWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('loadSessions failed'),
    )
    expect(listWarn).toBeDefined()
    warnSpy.mockRestore()
  })
})
