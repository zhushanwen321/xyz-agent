/**
 * useBackgroundTasks 单测 —— 后台命令状态根（u-renderer-store 验收条款）。
 *
 * 覆盖（对照 impl-plan u-renderer-store 验收 + 探针 P6）：
 * - 拉取腿（C6）：mount 即拉、refresh 手动重拉、in-flight 去重、失败不降级；
 * - 广播腿：backgroundTask:updated → updateFor(capturedSid) 写「消息所属 sid」分区；
 * - 双 session updateFor 竞态（M1）：切 sid 后退订窗口内的旧 sid 迟到广播写旧分区，
 *   不污染新分区（结构性消除竞态的行为锚）；
 * - P6 分区：双实例双 session，publish(sid=A) 后断言 B 分区无变化；
 * - refCount：同 sid 多实例共享单条物理订阅（一实例卸载余者仍收广播）；
 * - session 销毁 cleanup：分区清空 + 迟到写入抑制（不僵尸式重建）。
 *
 * mock 边界：backgroundTask.list domain mock 掉（transport 层不在本层职责）；广播走真实
 * events.dispatchSession 通道。实现内无 timer，异步链用 setTimeout(0)+nextTick 排空
 * （不涉及 timer 语义，无需 fake timers）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-background-tasks.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import * as events from '@/api/events'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import {
  useBackgroundTasks,
  __resetBackgroundTasksForTest,
  type UseBackgroundTasksReturn,
} from '@/composables/features/sidebar/useBackgroundTasks'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'

// ── mock 边界：list RPC mock 掉（composable 直接 import domain 文件，偏差 #7 形态）──
const listMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/domains/background-task', () => ({ list: listMock }))

// ── 共享测试基建 ─────────────────────────────────────────────

interface Deferred {
  sid: string
  resolve: (tasks: BackgroundTaskEntry[]) => void
  reject: (err: unknown) => void
}

let pendingLists: Deferred[] = []
const wrappers: VueWrapper[] = []

/** registry 条目构造（测试只关心 state/taskId/command，其余字段取合法默认）。 */
function task(taskId: string, state: BackgroundTaskEntry['state'], overrides: Partial<BackgroundTaskEntry> = {}): BackgroundTaskEntry {
  return {
    taskId,
    pid: 100 + taskId.length,
    command: `cmd-${taskId}`,
    outputFile: `/tmp/${taskId}.log`,
    startedAt: 1_000,
    ownerPiPid: 9,
    sessionId: 'sess-owner',
    ...overrides,
  }
}

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
  tasks: UseBackgroundTasksReturn
}

/** 测试宿主：setup 内调 useBackgroundTasks 并 expose（composable 依赖组件 scope）。 */
function mountHost(initialSid: string | null): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  const wrapper = mount(
    defineComponent({
      setup() {
        const tasks = useBackgroundTasks(sidRef)
        return { tasks }
      },
      render: () => h('div'),
    }),
  )
  wrappers.push(wrapper)
  const candidate = (wrapper.vm as { tasks?: unknown }).tasks
  if (!candidate || typeof candidate !== 'object' || !('current' in candidate)) {
    throw new Error('host 组件未暴露 tasks')
  }
  return { sidRef, tasks: candidate as UseBackgroundTasksReturn }
}

/** 排空异步链：setTimeout(0) 前所有已排队微任务（promise 链 + Vue 调度器 flush）跑完。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

/** listMock 发起时登记 deferred（手动控制 resolve/reject 时序）。 */
listMock.mockImplementation((sid: string) => {
  return new Promise<BackgroundTaskEntry[]>((resolve, reject) => {
    pendingLists.push({ sid, resolve, reject })
  })
})

/** resolve 指定 sid 的最早已登记在途 list。 */
function resolveList(sid: string, tasks: BackgroundTaskEntry[]): void {
  const idx = pendingLists.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 list`)
  const [entry] = pendingLists.splice(idx, 1)
  entry.resolve(tasks)
}

/** 广播 backgroundTask:updated（真实 session 通道分发）。 */
function dispatchUpdated(sid: string, tasks: BackgroundTaskEntry[]): void {
  events.dispatchSession(sid, {
    type: 'backgroundTask:updated',
    payload: { sessionId: sid, tasks },
  })
}

beforeEach(() => {
  pendingLists = []
  listMock.mockClear()
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  __resetBackgroundTasksForTest()
  __clearSessionCleanupRegistryForTest()
})

// ── 拉取腿（C6 唯一真相入口）──

describe('拉取腿', () => {
  it('mount 即拉：immediate 恢复腿对当前 sid 发 list，resolve 后分区填充 + loaded', async () => {
    const host = mountHost('A')
    expect(listMock).toHaveBeenCalledWith('A')
    expect(host.tasks.current.value.loaded).toBe(false)
    resolveList('A', [task('t1', 'running')])
    await settle()
    expect(host.tasks.current.value.tasks).toHaveLength(1)
    expect(host.tasks.current.value.tasks[0].taskId).toBe('t1')
    expect(host.tasks.current.value.loaded).toBe(true)
  })

  it('切 sid 触发重拉：切到 B 后拉 B（切走期间广播已退订，缓存不可信）', async () => {
    const host = mountHost('A')
    resolveList('A', [task('t1', 'running')])
    await settle()
    host.sidRef.value = 'B'
    await nextTick()
    expect(listMock).toHaveBeenCalledWith('B')
    resolveList('B', [task('t2', 'exited', { exitCode: 0, reason: 'natural', endedAt: 2_000 })])
    await settle()
    expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t2'])
  })

  it('in-flight 去重：同 sid 并发 refresh 复用同一 Promise，list 只发一次', async () => {
    const host = mountHost('A')
    await settle() // 排空 immediate 恢复腿的在途（此时 A 已有一条在途）
    expect(listMock).toHaveBeenCalledTimes(1)
    const p1 = host.tasks.refresh()
    const p2 = host.tasks.refresh('A')
    expect(listMock).toHaveBeenCalledTimes(1) // 并发去重，不重发
    resolveList('A', [task('t1', 'running')])
    await Promise.all([p1, p2])
    await settle()
    expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
    // settle 后条目已清：再次 refresh 重新发起
    void host.tasks.refresh()
    expect(listMock).toHaveBeenCalledTimes(2)
    resolveList('A', [])
  })

  it('list 失败不降级：分区缓存保留、loaded 不虚置、refresh 不 reject（无 unhandled）', async () => {
    const host = mountHost('A')
    resolveList('A', [task('t1', 'running')])
    await settle()
    host.sidRef.value = 'B'
    await nextTick()
    const idx = pendingLists.findIndex((e) => e.sid === 'B')
    const [entry] = pendingLists.splice(idx, 1)
    entry.reject(new Error('ws closed'))
    await settle() // 若实现 produce unhandled rejection，vitest 会以未处理拒绝报告
    expect(host.tasks.current.value.loaded).toBe(false) // B 从未成功拉取
    host.sidRef.value = 'A'
    await nextTick()
    await settle()
    // 切回 A：恢复腿无条件重拉（缓存过期不可信），旧缓存仍在 RPC 往返期显示
    expect(host.tasks.current.value.loaded).toBe(true)
    expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
  })
})

// ── 广播腿 + 双 session updateFor 竞态（M1）+ P6 分区 ──

describe('广播写入与双 session 竞态', () => {
  it('广播 → updateFor(capturedSid) 写「消息所属 sid」分区', async () => {
    const host = mountHost('A')
    resolveList('A', [])
    await settle()
    dispatchUpdated('A', [task('t1', 'killing')])
    await nextTick()
    expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])
    expect(host.tasks.current.value.loaded).toBe(true)
  })

  it('双 session updateFor 竞态（M1）：切 sid 后退订窗口内的旧 sid 迟到广播写旧分区，不污染新分区', async () => {
    // 双实例形态：hostA 恒绑 A；host2 从 A 切 B（复现切 session 时序）
    mountHost('A')
    const host2 = mountHost('A')
    resolveList('A', [])
    await settle()
    expect(listMock).toHaveBeenCalledTimes(1) // 同 sid 双实例拉取去重

    dispatchUpdated('A', [task('t1', 'running')])
    await nextTick()
    expect(host2.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t1'])

    // 切 B（watch flush:pre 尚未执行，物理订阅仍是 A）→ 旧 sid 迟到广播
    host2.sidRef.value = 'B'
    dispatchUpdated('A', [task('t1-late', 'killing')])
    await nextTick()
    // 迟到帧落 A 分区：hostA（仍绑 A）可见 t1-late；host2 已绑 B，视图是 B 分区（未被污染）
    const hostA = wrappers[0]
    const tasksA = (hostA.vm as { tasks?: UseBackgroundTasksReturn }).tasks
    expect(tasksA?.current.value.tasks.map((t) => t.taskId)).toEqual(['t1-late'])
    expect(host2.tasks.current.value.tasks).toEqual([]) // B 分区从未写入，无 A 残留
  })

  it('P6 分区：双实例双 session，publish(sid=A) 后 B 分区无变化', async () => {
    const hostA = mountHost('A')
    const hostB = mountHost('B')
    resolveList('A', [task('a1', 'running')])
    resolveList('B', [task('b1', 'exited', { exitCode: 0, reason: 'natural', endedAt: 2_000 })])
    await settle()
    const beforeB = [...hostB.tasks.current.value.tasks]

    dispatchUpdated('A', [task('a1', 'exited', { exitCode: 0, reason: 'natural', endedAt: 5_000 }), task('a2', 'running')])
    await nextTick()

    // A 分区已被 A 广播更新；B 分区保持拉取值原样（引用与值均未变）
    expect(hostA.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['a1', 'a2'])
    expect(hostB.tasks.current.value.tasks).toEqual(beforeB)
    expect(hostB.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['b1'])

    // 反向同样成立：B 广播不进 A 分区
    dispatchUpdated('B', [task('b2', 'running')])
    await nextTick()
    expect(hostB.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['b2'])
    expect(hostA.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['a1', 'a2'])
  })
})

// ── 模块级 refCount 单 listener ──

describe('refCount 订阅收敛', () => {
  it('同 sid 多实例共享物理订阅：一实例卸载后余者仍收广播', async () => {
    const host1 = mountHost('A')
    const host2 = mountHost('A')
    resolveList('A', [])
    await settle()

    host1.sidRef.value = null // 实例1 退订 A 分区键（watch flush 释放订阅引用，refCount 2→1）
    await nextTick()
    const w1 = wrappers[0]
    w1.unmount()
    wrappers.splice(wrappers.indexOf(w1), 1)

    // 实例2 仍持有订阅（refCount 1）：广播照常写入
    dispatchUpdated('A', [task('t9', 'running')])
    await nextTick()
    expect(host2.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['t9'])
  })

  it('实例卸载释放订阅引用：全部卸载后广播无人消费（无异常）', async () => {
    mountHost('A')
    resolveList('A', [])
    await settle()
    for (const w of [...wrappers]) {
      w.unmount()
      wrappers.splice(wrappers.indexOf(w), 1)
    }
    expect(() => dispatchUpdated('A', [task('t9', 'running')])).not.toThrow()
  })
})

// ── session 销毁 cleanup + 迟到写入抑制 ──

describe('session 销毁 cleanup', () => {
  it('triggerSessionCleanups 清分区；迟到的 RPC resolve / 广播不把分区僵尸式写回', async () => {
    const host = mountHost('A')
    // 留一条在途 list（模拟销毁时 RPC 未 resolve）
    await nextTick()
    triggerSessionCleanups('A')
    await nextTick()
    expect(host.tasks.current.value.tasks).toEqual([]) // 分区已清（null/新默认实例）

    // 迟到广播：抑制表拦截，不重建分区
    dispatchUpdated('A', [task('ghost', 'running')])
    await nextTick()
    expect(host.tasks.current.value.tasks).toEqual([])

    // 迟到 RPC resolve：同样被抑制
    resolveList('A', [task('ghost-rpc', 'running')])
    await settle()
    expect(host.tasks.current.value.tasks).toEqual([])

    // 重新进入 = 新生命周期：抑制解除，恢复腿重拉
    host.sidRef.value = 'B'
    await nextTick()
    host.sidRef.value = 'A'
    await nextTick()
    expect(listMock).toHaveBeenLastCalledWith('A')
    resolveList('A', [task('fresh', 'running')])
    await settle()
    expect(host.tasks.current.value.tasks.map((t) => t.taskId)).toEqual(['fresh'])
  })
})
