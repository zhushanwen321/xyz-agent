/**
 * ExtensionTimeoutManager 单测 —— 纯逻辑状态机。
 *
 * 覆盖：
 * - registerTimeout 三分支（notify 早退 / bridge: 仅登记 / 交互式 method 仅 session 跟踪不建 timer）
 * - clearTimeout 单条清理
 * - clearForSession（含 bridgeRequestIds 清理 + 跨 session 隔离）
 * - [2026-07-16] 交互式 method（select/confirm/input/editor/ask-user）不再触发 onTimeout
 * - 重复 register 不再产生定时器
 * - isBridgeRequest / removeBridgeRequest
 *
 * 用 vi.useFakeTimers() 控制 setTimeout（manager 内部用真实 setTimeout + 300s 超时）。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/extension-timeout-manager.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ExtensionTimeoutManager } from '../src/services/extension-timeout-manager.js'

describe('ExtensionTimeoutManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('registerTimeout(method="notify") 不建 timer（早退）', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'notify', onTimeout)
    // 远超 5min 超时
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('registerTimeout(method="bridge:*") 仅登记 bridgeRequestIds + session，不建 timer', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'bridge:something', onTimeout)
    expect(mgr.isBridgeRequest('r1')).toBe(true)
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    // bridge 请求靠跨进程序列驱动，不建本地 timer
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('registerTimeout(交互式 method) 仅 session 跟踪，不再建 timer/触发 onTimeout', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout)
    // [2026-07-16] 交互式 method 统一不超时，block 等待用户决策
    vi.advanceTimersByTime(mgr.TIMEOUT_MS + 1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('clearTimeout 对交互式 method 是 no-op（无 timer 可清，仍不触发回调）', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout)
    mgr.clearTimeout('r1')
    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('clearForSession 清掉该 session 的 bridge 请求，不影响其他 session 的 session 跟踪', () => {
    const mgr = new ExtensionTimeoutManager()
    const onTimeout1 = vi.fn()
    const onTimeout2 = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', onTimeout1)
    mgr.registerTimeout('s1', 'r2', 'bridge:cmd', vi.fn())
    mgr.registerTimeout('s2', 'r3', 'select', onTimeout2)

    mgr.clearForSession('s1')

    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(onTimeout1).not.toHaveBeenCalled() // 交互式 method 本就不触发
    expect(mgr.isBridgeRequest('r2')).toBe(false) // s1 bridge 请求已清
    expect(onTimeout2).not.toHaveBeenCalled() // 交互式 method 本就不触发
  })

  it('clearForSession 对无请求的 session 是 no-op', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(() => mgr.clearForSession('no-such-session')).not.toThrow()
  })

  it('重复 registerTimeout(相同 requestId) 不再产生定时器，回调均不触发', () => {
    const mgr = new ExtensionTimeoutManager()
    const oldCb = vi.fn()
    const newCb = vi.fn()
    mgr.registerTimeout('s1', 'r1', 'select', oldCb)
    mgr.registerTimeout('s1', 'r1', 'select', newCb) // 覆盖

    vi.advanceTimersByTime(mgr.TIMEOUT_MS)
    expect(oldCb).not.toHaveBeenCalled()
    expect(newCb).not.toHaveBeenCalled()
  })

  it('removeBridgeRequest 从 bridge 跟踪表移除', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerTimeout('s1', 'r1', 'bridge:cmd', vi.fn())
    expect(mgr.isBridgeRequest('r1')).toBe(true)
    mgr.removeBridgeRequest('r1')
    expect(mgr.isBridgeRequest('r1')).toBe(false)
  })

  it('isBridgeRequest 对未登记 id 返回 false', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(mgr.isBridgeRequest('never-registered')).toBe(false)
  })

  it('getPendingRequests 非破坏性：多次 peek 不清缓存，payload 解包到顶层', () => {
    const mgr = new ExtensionTimeoutManager()
    // cachePendingRequest 签名：(sessionId, requestId, method, payload)
    mgr.cachePendingRequest('s1', 'r1', 'select', { title: 'ask', askUser: true, askUserQuestions: [] })
    mgr.cachePendingRequest('s1', 'r2', 'confirm', { title: 'cf', message: 'sure?' })

    const first = mgr.getPendingRequests('s1')
    const second = mgr.getPendingRequests('s1')

    // 两次都拿到完整列表（非破坏）
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // requestId 集合一致
    const ids = (arr: { requestId: string }[]) => arr.map(r => r.requestId).sort()
    expect(ids(first)).toEqual(ids(second))

    // payload 解包到顶层
    const askReq = first.find(r => r.requestId === 'r1')
    expect(askReq?.title).toBe('ask') // payload.title 解包到顶层
    expect(askReq?.askUser).toBe(true) // payload.askUser 解包到顶层
    expect(askReq?.method).toBe('select')
    expect(typeof askReq?.receivedAt).toBe('number')
  })

  it('getPendingRequests 对未激活/无 pending 的 session 返回空数组（非抛错）', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(mgr.getPendingRequests('never-active')).toEqual([])
  })

  it('removePendingRequest 后 getPendingRequests 快照收缩（respond 生命周期）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.cachePendingRequest('s1', 'r1', 'select', { askUser: true })
    mgr.cachePendingRequest('s1', 'r2', 'confirm', {})

    mgr.removePendingRequest('s1', 'r1') // 模拟 extension.ui_response 到达，r1 已 respond

    const pending = mgr.getPendingRequests('s1')
    expect(pending).toHaveLength(1)
    expect(pending[0].requestId).toBe('r2')
  })

  it('clearForSession 后 getPendingRequests 返回空数组（session 销毁清理）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.cachePendingRequest('s1', 'r1', 'select', { askUser: true })
    mgr.clearForSession('s1')
    expect(mgr.getPendingRequests('s1')).toEqual([])
  })

  // ── getAllPendingRequests（P3 D3：sendInitialState 第 14 段跨 session 聚合）──

  it('getAllPendingRequests 聚合多 session 的 pending（含 5 字段原始结构，payload 未解包）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.cachePendingRequest('s1', 'r1', 'select', { title: 'A' })
    mgr.cachePendingRequest('s1', 'r2', 'confirm', { message: 'B' })
    mgr.cachePendingRequest('s2', 'r3', 'input', { prefill: 'C' })

    const all = mgr.getAllPendingRequests()

    expect(all).toHaveLength(3)
    // 按 sessionId 升序 + requestId 入序排列断言（确定序）
    const sorted = [...all].sort((a, b) =>
      a.sessionId === b.sessionId ? a.requestId.localeCompare(b.requestId) : a.sessionId.localeCompare(b.sessionId))
    expect(sorted.map((r) => r.sessionId)).toEqual(['s1', 's1', 's2'])
    expect(sorted.map((r) => r.requestId)).toEqual(['r1', 'r2', 'r3'])
    // 每条含 5 字段原始结构（payload 未解包，仍是 Record<string,unknown>）
    for (const r of sorted) {
      expect(typeof r.requestId).toBe('string')
      expect(typeof r.sessionId).toBe('string')
      expect(typeof r.method).toBe('string')
      expect(typeof r.payload).toBe('object')
      expect(typeof r.receivedAt).toBe('number')
    }
    // payload 未解包（顶层无 title/message/prefill，仍在 payload 内）
    expect(sorted[0].payload).toEqual({ title: 'A' })
    expect('title' in sorted[0]).toBe(false)
  })

  it('getAllPendingRequests 无 pending 返回空数组（非 undefined）', () => {
    const mgr = new ExtensionTimeoutManager()
    const all = mgr.getAllPendingRequests()
    expect(Array.isArray(all)).toBe(true)
    expect(all).toEqual([])
  })

  it('getAllPendingRequests 是只读快照（不破坏 pendingRequests，多次调用幂等）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.cachePendingRequest('s1', 'r1', 'select', { title: 'A' })
    mgr.cachePendingRequest('s1', 'r2', 'confirm', { message: 'B' })

    const first = mgr.getAllPendingRequests()
    const second = mgr.getAllPendingRequests()
    // 两次调用都返回 2 条
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // getPendingRequests 同 session 仍工作（解包形态不受影响）
    const resolved = mgr.getPendingRequests('s1')
    expect(resolved).toHaveLength(2)
    // 解包形态：payload 拍平到顶层（title/message 字段在顶层）
    expect(resolved.some((r) => r.title === 'A')).toBe(true)
  })

  it('getAllPendingRequests 单条结构异常时跳过不中断聚合（ES1 错误规格）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.cachePendingRequest('s1', 'r1', 'select', { title: 'A' })
    // 人为塞入结构异常条目（模拟并发 race）：直接操作内部 pendingRequests Map
    const internal = (mgr as unknown as { pendingRequests: Map<string, Map<string, unknown>> }).pendingRequests
    const s1Map = internal.get('s1')
    if (s1Map) s1Map.set('bad', undefined)

    const all = mgr.getAllPendingRequests()
    // 仅返回 r1（正常条目），异常条目跳过，不抛错
    expect(all).toHaveLength(1)
    expect(all[0].requestId).toBe('r1')
  })

  it('clearForSession 后 getAllPendingRequests 不再含该 session 的 pending（P3 SC4 孤儿清理）', () => {
    // 模拟 onSessionExit/session.delete 路径：经 setOnSessionDelete 钩子触发 clearForSession，
    // 后续 getAllPendingRequests（sendInitialState 第 14 段数据源）不再返回已死 session 的孤儿请求。
    const mgr = new ExtensionTimeoutManager()
    mgr.cachePendingRequest('s1', 'r1', 'select', { title: 'A' })
    mgr.cachePendingRequest('s2', 'r2', 'confirm', { message: 'B' })
    expect(mgr.getAllPendingRequests()).toHaveLength(2)

    // s1 进程崩溃 → onSessionExit → clearForSession('s1')
    mgr.clearForSession('s1')

    const all = mgr.getAllPendingRequests()
    expect(all).toHaveLength(1)
    expect(all[0].sessionId).toBe('s2') // 仅存活 session 的 pending
    expect(all.some((r) => r.sessionId === 's1')).toBe(false) // 无孤儿
  })
})
