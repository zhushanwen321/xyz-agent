/**
 * session.exited 事件端到端测试 —— 进程退出反馈链路。
 *
 * 锁定 R1（进程退出时前端无 streamSubscription → message.error 静默丢弃）+
 *      R7（退出的 session 仍可点击，触发 restore→再崩溃循环）。
 *
 * 验证链路：transport.onMessage 注册的 routeInbound handler 收到 session.exited →
 *   1. chat store markSessionError（聊天流追加 error 消息 + 重置活跃态）
 *   2. session store markDead（status 置 dead）
 *   3. toast 提示（首行 reason）
 *
 * mock 策略：vi.hoisted 捕获 ws-client.onMessage 注册的 routeInbound handler，
 * 测试向其注入 ServerMessage。mock ipc/ws-client 避免 init() 真实连接。
 *
 * useConnection 有模块级 dispatcherInstalled/initialised 标志，每个用例需 resetModules +
 * 动态 import 重新加载，确保 dispatcher 在 init() 时重新安装（routeHandler 被捕获）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/session-exited.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ServerMessage, SessionGroup } from '@xyz-agent/shared'

// vi.hoisted 保证 mock 工厂在模块加载前就绪；resetModules 后重新加载 useConnection 时
// 仍走同一 mock 工厂（mock 在 hoisted 层注册，不受 resetModules 影响）
const mockHolder = vi.hoisted(() => {
  return {
    // 捕获 transport.on（ws-client.onMessage）注册的 routeInbound handler
    routeHandler: null as ((msg: ServerMessage) => void) | null,
    // ws-client.getState 返回的 ref。vi.hoisted 在 import 前执行，不能调 vue 的 ref，
    // 这里放 null，在 beforeEach 中用真正的 ref 替换（见 initMockState）。
    stateRef: null as ReturnType<typeof ref<string>> | null,
  }
})

vi.mock('@/lib/ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  // getState 返回 mockHolder.stateRef（beforeEach 中用真正的 vue ref 初始化）
  getState: () => mockHolder.stateRef!,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: vi.fn((cb: (msg: ServerMessage) => void) => {
    mockHolder.routeHandler = cb
    return () => { mockHolder.routeHandler = null }
  }),
}))

vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn(async () => undefined),
  getRuntimePortOffset: vi.fn(async () => undefined),
  onRuntimePort: vi.fn(() => () => {}),
  onRuntimeRestarting: vi.fn(() => () => {}),
  onRuntimeFailed: vi.fn(() => () => {}),
  restartRuntime: vi.fn(async () => {}),
}))

// 动态 import 容器：beforeEach resetModules 后重新加载
let useConnection: typeof import('@/composables/useConnection').useConnection
let useChatStore: typeof import('@/stores/chat').useChatStore
let useSessionStore: typeof import('@/stores/session').useSessionStore
let useToast: typeof import('@/composables/useToast').useToast

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 重置 mock holder + useConnection 模块级状态
  mockHolder.routeHandler = null
  // 用真正的 vue ref 初始化（vi.hoisted 时 vue 未加载，只能在此创建）
  mockHolder.stateRef = ref('disconnected')
  vi.resetModules()

  // 重新加载模块（useConnection 的 dispatcherInstalled/initialised 归零）
  const conn = await import('@/composables/useConnection')
  useConnection = conn.useConnection
  useChatStore = (await import('@/stores/chat')).useChatStore
  useSessionStore = (await import('@/stores/session')).useSessionStore
  useToast = (await import('@/composables/useToast')).useToast

  // 初始化 session store 含一个 idle session
  const sessionStore = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's-exit', label: 'test', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
    ],
  }
  sessionStore.setGroups([group])
})

async function initAndConnect(): Promise<void> {
  mockHolder.stateRef.value = 'connecting'
  const { init } = useConnection()
  await init()
  mockHolder.stateRef.value = 'connected'
}

describe('session.exited 事件端到端反馈链路', () => {
  it('routeInbound 收到 session.exited → markSessionError + markDead + toast', async () => {
    await initAndConnect()
    expect(mockHolder.routeHandler).not.toBeNull()

    const chatStore = useChatStore()
    const sessionStore = useSessionStore()
    const { toasts } = useToast()

    // 注入 session.exited 消息
    const exitedMsg: ServerMessage = {
      type: 'session.exited',
      payload: { sessionId: 's-exit', code: 1, reason: 'Session process exited (code: 1)\n\nError: extension load failed' },
    }
    mockHolder.routeHandler!(exitedMsg)

    // 1. chat store：追加了 error 消息
    const msgs = chatStore.getMessages('s-exit')
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs.some((m) => m.role === 'assistant' && m.status === 'error')).toBe(true)
    const errMsg = msgs.find((m) => m.status === 'error')!
    expect(errMsg.content).toContain('extension load failed')

    // 2. session store：status 置 dead
    expect(sessionStore.list.find((s) => s.id === 's-exit')?.status).toBe('dead')

    // 3. toast：首行 reason
    expect(toasts.value.length).toBeGreaterThanOrEqual(1)
    const lastToast = toasts.value[toasts.value.length - 1]
    expect(lastToast.type).toBe('error')
    expect(lastToast.message).toContain('会话进程已退出')
    expect(lastToast.message).toContain('Session process exited') // 首行
  })

  it('session.exited 含多行 stderr 时 toast 只取首行', async () => {
    await initAndConnect()

    const { toasts } = useToast()
    const multiLineReason = `Session process exited (code: 1)\n\nError: node:sqlite not found\n    at loadExtension\n    at main`

    mockHolder.routeHandler!({
      type: 'session.exited',
      payload: { sessionId: 's-exit', code: 1, reason: multiLineReason },
    })

    const lastToast = toasts.value[toasts.value.length - 1]
    // toast 只含首行，不含 stack trace
    expect(lastToast.message).toContain('Session process exited')
    expect(lastToast.message).not.toContain('node:sqlite')
    expect(lastToast.message).not.toContain('at loadExtension')
  })

  it('session.exited 重置 chat 活跃态（流式中崩溃不复位 → UI 卡死）', async () => {
    await initAndConnect()

    const chatStore = useChatStore()
    // 模拟流式中：先设 streaming
    chatStore.setStreaming(true, 's-exit')
    expect(chatStore.isStreaming).toBe(true)

    mockHolder.routeHandler!({
      type: 'session.exited',
      payload: { sessionId: 's-exit', code: 1, reason: 'crashed' },
    })

    // 关键：isStreaming 复位（规则 #3）
    expect(chatStore.isStreaming).toBe(false)
    expect(chatStore.streamingSessionId).toBe(null)
  })

  it('session.exited 对未知 sessionId 仍 toast（兜底，防静默丢弃）', async () => {
    await initAndConnect()

    const { toasts } = useToast()
    const sessionStore = useSessionStore()
    const beforeCount = sessionStore.list.length

    mockHolder.routeHandler!({
      type: 'session.exited',
      payload: { sessionId: 'unknown-ghost', code: 0, reason: 'orphan exit' },
    })

    // markDead 对未知 session 是 no-op（列表不变）
    expect(sessionStore.list.length).toBe(beforeCount)
    // 但 toast 仍触发（不静默丢弃）
    expect(toasts.value.some((t) => t.message.includes('orphan exit'))).toBe(true)
  })
})
