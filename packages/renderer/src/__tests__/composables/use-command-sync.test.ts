/**
 * useCommandSync 单测 —— slash 命令补拉闭环。
 *
 * 覆盖（三视角）：
 * 1. 构建者（白盒）：watch(sessionIdRef, immediate) 拉取 → commandStore.applyCommands(reply.sessionId, reply.commands)
 * 2. 使用者（黑盒）：onOpenPull 触发拉取；in-flight 去重（同 sid 并发只 1 次 RPC）
 * 3. 观察者（形态）：失败 → store 保留旧值、不抛、console.warn；sid null 不拉
 * 4. FM4 回归：props.sessionId 变为 B 后，A 的迟到 session.commands 帧写 A 分区、B 分区不受污染
 *
 * mock 边界：session.getCommands mock 掉（transport 层不在本层职责）；commandStore 真实例。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-command-sync.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as events from '@xyz-agent/core/transport/api'
import { __resetCommandStoreForTesting, useCommandStore } from '@/composables/features/command/useCommandStore'
import {
  useCommandSync,
  __clearInFlightCommandsFetchForTest,
} from '@/composables/panel/useCommandSync'
import type { ServerMessage } from '@xyz-agent/shared'

// ── mock 边界：getCommands RPC mock 掉；门面 session 重指回 mock 的 domain ──
const getCommandsMock = vi.hoisted(() => vi.fn())
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({ getCommands: getCommandsMock }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  return { ...actual, session }
})

// ── 共享测试基建 ─────────────────────────────────────────────

const SIDS = ['A', 'B'] as const

/** getCommands reply 形状。 */
interface CmdReply {
  sessionId: string
  commands: Array<{ name: string; description?: string; source: string }>
}

/** 在途 RPC 的受控 deferred。 */
interface PendingRpc {
  sid: string
  resolve: (v: CmdReply) => void
  reject: (e: unknown) => void
}

let pendingRpcs: PendingRpc[] = []
const mountedWrappers: VueWrapper[] = []

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
  /** 手动触发 onOpenPull（模拟浮层打开） */
  openPull: () => void
}

/**
 * 测试宿主组件：在 setup 内调 useCommandSync（useSessionEvents 的 getCurrentInstance
 * 守卫要求组件 setup 上下文），expose 返回值。
 */
function mountHost(initialSid: string | null): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  let capturedOpenPull: () => void = () => {}
  const wrapper = mount(
    defineComponent({
      setup() {
        const { onOpenPull } = useCommandSync(sidRef as ReturnType<typeof ref<string | null | undefined>>)
        capturedOpenPull = onOpenPull
      },
      render: () => h('div'),
    }),
  )
  mountedWrappers.push(wrapper)
  return { sidRef, openPull: capturedOpenPull }
}

/** 排空在途异步链。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

/** resolve 指定 sid 的最早已登记在途 RPC。 */
function resolveForSid(sid: string, reply: CmdReply): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.resolve(reply)
}

/** reject 指定 sid 的最早已登记在途 RPC。 */
function rejectForSid(sid: string, err: unknown): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.reject(err)
}

beforeEach(() => {
  pendingRpcs = []
  setActivePinia(createPinia())
  __resetCommandStoreForTesting()
  __clearInFlightCommandsFetchForTest()

  getCommandsMock.mockReset()
  getCommandsMock.mockImplementation(
    (sid: string) =>
      new Promise<CmdReply>((resolve, reject) => {
        pendingRpcs.push({ sid, resolve, reject })
      }),
  )
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
  document.body.innerHTML = ''
})

// ── 定向用例 ─────────────────────────────────────────────────

describe('挂载/sid 变化触发拉取', () => {
  it('挂载时立即拉取当前 sid（immediate watch）→ applyCommands 写 reply.sessionId 分区', async () => {
    const store = useCommandStore()
    mountHost('A')
    await settle()
    expect(getCommandsMock).toHaveBeenCalledTimes(1)
    expect(getCommandsMock).toHaveBeenCalledWith('A')

    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'goal', source: 'extension' }, { name: 'todo', source: 'skill' }],
    })
    await settle()

    const cmds = store.getCommands('A')
    expect(cmds.map((c) => c.name)).toEqual(['goal', 'todo'])
  })

  it('sid 变化时拉取新 sid → 新分区写入，旧分区保留', async () => {
    const store = useCommandStore()
    const host = mountHost('A')
    await settle()
    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'goal', source: 'extension' }],
    })
    await settle()
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['goal'])

    // 切到 B
    host.sidRef.value = 'B'
    await settle()
    expect(getCommandsMock).toHaveBeenCalledTimes(2) // A 首拉 + B 首拉

    resolveForSid('B', {
      sessionId: 'B',
      commands: [{ name: 'review', source: 'skill' }],
    })
    await settle()

    // B 分区写入
    expect(store.getCommands('B').map((c) => c.name)).toEqual(['review'])
    // A 分区保留
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['goal'])
  })

  it('sid 为 null 不拉取', async () => {
    mountHost(null)
    await settle()
    expect(getCommandsMock).not.toHaveBeenCalled()
  })
})

describe('onOpenPull 触发拉取 + in-flight 去重', () => {
  it('onOpenPull 触发拉取（同 sid 在途时复用 Promise，不重复 RPC）', async () => {
    const store = useCommandStore()
    const host = mountHost('A')
    await settle() // 挂载拉取在途

    // 连续调用 onOpenPull 两次（模拟快速开关浮层）
    host.openPull()
    host.openPull()
    await settle()

    // 仍然只有 1 次 RPC（挂载的 + onOpenPull 的合并，因为同 sid 在途）
    expect(getCommandsMock).toHaveBeenCalledTimes(1)

    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'compact', source: 'builtin' }],
    })
    await settle()

    expect(store.getCommands('A').map((c) => c.name)).toEqual(['compact'])
  })

  it('两次并发同 sid 只发 1 次 RPC（模块级 in-flight 去重）', async () => {
    // 双实例模拟 split panel
    const host1 = mountHost('A')
    await settle()
    const host2 = mountHost('A')
    await settle()

    // 两个实例都挂载了 A，但模块级去重 → 只 1 次 RPC
    expect(getCommandsMock).toHaveBeenCalledTimes(1)

    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'goal', source: 'extension' }],
    })
    await settle()

    const store = useCommandStore()
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['goal'])
  })

  it('完成后清 in-flight 条目 → 下次同 sid 触发重新拉取', async () => {
    const host = mountHost('A')
    await settle()
    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'old', source: 'extension' }],
    })
    await settle()

    // 第一次拉取完成
    expect(getCommandsMock).toHaveBeenCalledTimes(1)

    // onOpenPull 触发第二次拉取（条目已清）
    host.openPull()
    await settle()
    expect(getCommandsMock).toHaveBeenCalledTimes(2)

    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'new', source: 'skill' }],
    })
    await settle()

    const store = useCommandStore()
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['new'])
  })
})

describe('失败降级（D3）', () => {
  it('RPC 失败 → store 保留旧值、不抛、console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useCommandStore()

    // 先写入旧值
    store.applyCommands('A', [{ name: 'existing', source: 'extension' }])

    mountHost('A')
    await settle()

    // RPC 失败
    rejectForSid('A', new Error('network timeout'))
    await settle()

    // store 保留旧值
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['existing'])
    // console.warn 被调用
    expect(warnSpy).toHaveBeenCalledWith(
      '[useCommandSync] fetch commands failed:',
      'network timeout',
    )

    warnSpy.mockRestore()
  })

  it('RPC 失败不抛异常（catch 兜底）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    mountHost('A')
    await settle()

    // reject 不应导致 unhandled rejection
    rejectForSid('A', new Error('fail'))
    await settle()

    // 如果到这里没抛，测试通过
    expect(true).toBe(true)

    vi.restoreAllMocks()
  })
})

describe('FM4 回归：跨分区污染防护（useSessionEvents handler 契约）', () => {
  it('切 sid 后旧 sid 的迟到 session.commands 帧写旧 sid 分区、新 sid 分区不受污染', async () => {
    const store = useCommandStore()

    // 模拟 useSessionEvents 的 handler 契约：捕获 sid 写分区（CommandPopover.vue 的 FM4 修复）
    // 当组件订阅 A 时，handler 闭包捕获 sid=A
    const handlerA = (msg: ServerMessage, sid: string) => {
      store.applyCommands(sid, msg.payload.commands as Array<{ name: string; source: string }> )
    }

    // 订阅 A
    events.on('A', (msg) => handlerA(msg, 'A'))

    // 推 A 的命令
    events.dispatchSession('A', {
      type: 'session.commands',
      payload: { sessionId: 'A', commands: [{ name: 'cmd-a', source: 'extension' }] },
    } as ServerMessage<'session.commands'>)
    await settle()
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['cmd-a'])

    // 切到 B（useCommandSync 拉取写入 B 分区）
    mountHost('B')
    await settle()
    resolveForSid('B', {
      sessionId: 'B',
      commands: [{ name: 'cmd-b', source: 'extension' }],
    })
    await settle()
    expect(store.getCommands('B').map((c) => c.name)).toEqual(['cmd-b'])

    // A 的迟到帧通过旧订阅到达（handler 闭包捕获 sid=A → applyCommands('A', ...)）
    events.dispatchSession('A', {
      type: 'session.commands',
      payload: { sessionId: 'A', commands: [{ name: 'late-skill', source: 'skill' }] },
    } as ServerMessage<'session.commands'>)
    await settle()

    // A 分区被迟到帧更新（captured sid 正确）
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['late-skill'])
    // B 分区不受污染
    expect(store.getCommands('B').map((c) => c.name)).toEqual(['cmd-b'])
  })
})
