/**
 * useHandoffEffect 单测 —— fast-handoff 完成广播的 renderer 侧编排（方案 2 + C1/M1/M2 修复）。
 *
 * bindHandoffEffect 订阅 session.handoffComplete 全局广播，编排：
 *   复位源 session handingOff → loadSessions → ensureStreamSubscription →
 *   hydrate(newId, []) [C1 预标记] → appendUser + addPendingSend → chatApi.send →
 *   selectSession（成功）/ [M1 回滚]（send 失败）。
 *
 * 覆盖用例（AGENTS #5：每用例含用户可见/状态断言）：
 * - U1 正常路径：appendUser 注入文档 + send + selectSession
 * - U2 [C1] hydrate 预标记让 selectSession 跳过 getHistory（不覆盖 messages）
 * - U3 [M1] send 失败回滚：disposeSession + sessionApi.remove + removeFromList，不跳转
 * - U4 [M2] 回调内同步抛错 → .catch 兜底 console.warn，不产生 unhandled rejection
 * - U5 off() 退订：广播不再触发副作用
 *
 * mock 策略（参照 useChat.test.ts / useSidebar-delete-cleanup.test.ts）：
 * - vi.mock('@/api')：chat.{send,streamSubscribe,getHistory} + session.{remove,switchSession,list,getCommands,getContext}
 * - vi.mock('@/composables/features/useSidebar')：loadSessions/selectSession 用 vi.fn
 * - vi.mock('@/composables/features/useChat')：ensureStreamSubscription + disposeSession 用 vi.fn
 *   （隔离模块级 streamSubscriptions Map，验「ensureStreamSubscription 被调」而非真实订阅）
 * - events / useChatStore / useSessionStore / textToSegments 用**真实**实现
 *   （验 appendUser/hydrate/setHandingOff 的真实副作用，AGENTS #5 用户可见断言）
 * - bindHandoffEffect 用 effectScope 包裹：onScopeDispose 需 active scope，scope.stop() 退订
 *
 * 模块级状态隔离：events.ts 的 globalTypeHandlers 是模块级 Map——
 * off()/scope.stop() 会从中删除 handler；beforeEach 重建 scope + afterEach stop 兜底清干净。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useHandoffEffect.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import { textToSegments, normalizeContent } from '@xyz-agent/shared'

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
let off: (() => void) | null = null

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
  // scope.stop() 也会触发 onScopeDispose 退订，作 afterEach 兜底。
  scope = effectScope()
  off = scope.run(() => bindHandoffEffect())!
})

afterEach(() => {
  // 显式退订（U5 也依赖 off；其它用例防 handler 残留到下一用例）
  off?.()
  scope?.stop()
  scope = null
  off = null
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

/** 推进微任务直到 loadSessions().then(...) 回调内的 await chatApi.send + selectSession 全部 settle */
async function flushMicrotasks(): Promise<void> {
  // void loadSessions().then(async () => { ... await chatApi.send ... selectSession })
  // 需足够多的 microtask tick 让 Promise chain 完整推进
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
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
    await flushMicrotasks()

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

  it('U2 [C1] hydrate(newId, []) 预标记让 selectSession 跳过 getHistory（不覆盖 appendUser 的 user 消息）', async () => {
    const chat = useChatStore()

    emitHandoffComplete()
    await flushMicrotasks()

    // [C1 预标记生效] newSession 已被标 hydrated
    expect(chat.isHydrated(NEW)).toBe(true)
    // bindHandoffEffect 用 chatApi.send（不走真实 selectSession 的 getHistory 路径），
    // 但语义上预标记的作用是：即便 selectSession 内部走 getHistory 也会因 isHydrated 跳过。
    // 这里直接断言 getHistory 未以 newSessionId 调用（handoff 路径根本不拉历史，新 session 自管消息）。
    expect(apiMock.chat.getHistory).not.toHaveBeenCalled()
    // [AGENTS #5 用户可见断言] appendUser 注入的 user 消息仍在（未被任何 hydrate 覆盖）
    const msgs = chat.getMessages(NEW)
    expect(msgs.some((m) => m.role === 'user')).toBe(true)
    expect(normalizeContent(msgs.find((m) => m.role === 'user')!.content)).toBe(HANDOFF_DOC)
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
    await flushMicrotasks()

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

  it('U4 [M2] loadSessions 回调内同步代码抛错 → .catch 兜底 console.warn，不产生 unhandled rejection', async () => {
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
    await flushMicrotasks()

    // [M2] .catch 被触发，warn 含 handoff-effect 标记
    expect(warnSpy).toHaveBeenCalled()
    const warnArg = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('handoff-effect'),
    )
    expect(warnArg).toBeDefined()
    // [AGENTS #5 用户可见：健壮性] send 未被调（appendUser 在 send 之前抛错，链中断）
    expect(apiMock.chat.send).not.toHaveBeenCalled()

    // 排空 microtask 队列后断言无 unhandledRejection
    await new Promise((r) => setTimeout(r, 0))
    expect(rejectionHandler).not.toHaveBeenCalled()

    process.removeListener('unhandledRejection', rejectionHandler)
    spy.mockRestore()
    warnSpy.mockRestore()
  })

  it('U5 off() 退订：handoffComplete 不再触发副作用', async () => {
    const chat = useChatStore()
    // 先退订（afterEach 会再 stop scope，off 幂等安全）
    off!()
    off = null

    emitHandoffComplete()
    await flushMicrotasks()

    // 退订后广播不触发任何副作用
    expect(useChatMock.ensureStreamSubscription).not.toHaveBeenCalled()
    expect(apiMock.chat.send).not.toHaveBeenCalled()
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
    // [AGENTS #5 用户可见] messages 未被写入（无 user 消息）
    expect(chat.getMessages(NEW)).toEqual([])
  })
})
