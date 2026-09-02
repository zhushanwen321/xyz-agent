/**
 * RuntimeSupervisor 崩溃自动重启回归测试（Gate B 观测②修复）。
 *
 * 背景（2026-08 Gate B AC-3b 实测）：kill -9 runtime 后 respawn 耗时 68-91s。
 * 日志时间线定位根因：exit 137 后紧跟 "during graceful stop — no restart"——
 * start() 内部 `await this.stop()`（清旧进程）markStopping 后，成功路径从不复位，
 * stopping 恒为 true → 运行期崩溃的 exit 全被 onRuntimeExit 误判「主动停止」短路
 * 自动重启，只能等 liveness 探针 30s×3（60-90s）兜底。
 *
 * 修复：start() 成功落定处（recordSuccess 后）复位 stopping。
 * 本测试用 stub 全链（spawn/stop/health/port/liveness）钉住该编排行为。
 *
 * 运行：cd apps/electron/main && npx vitest run test/runtime-supervisor-crash-restart.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock 必须在 import 之前（vitest hoist）
vi.mock('electron', () => {
  const getAllWindows = vi.fn(() => [])
  return {
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows }),
    app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
  }
})

vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(async () => 43110),
  getPortOffset: vi.fn(() => 0),
}))

// spawnRuntimeProcess：返回恒活 fake child；onExit 回调经 mock.calls 捕获供测试触发
vi.mock('../supervisor/process-control.js', () => ({
  spawnRuntimeProcess: vi.fn(() => ({
    child: { exitCode: null, pid: 12345, on: vi.fn(), kill: vi.fn() },
    token: 'test-token',
  })),
  stopRuntimeProcess: vi.fn(async () => undefined),
}))

vi.mock('../supervisor/health-checker.js', () => ({
  waitForHealth: vi.fn(async () => undefined),
}))

vi.mock('../supervisor/port-file.js', () => ({
  writePortFile: vi.fn(),
}))

// LivenessMonitor stub：真实类会 setInterval(30s)，fake timers 推进时会误触探针路径
vi.mock('../supervisor/liveness-probe.js', () => ({
  LivenessMonitor: class {
    start(): void {}
    stop(): void {}
  },
}))

import { RuntimeSupervisor } from '../supervisor/runtime-supervisor.js'
import { spawnRuntimeProcess } from '../supervisor/process-control.js'

const spawnMock = vi.mocked(spawnRuntimeProcess)

/** 取第 n 次 spawn 时传入的 onExit 回调（模拟子进程退出事件） */
function onExitOf(callIndex: number): (code: number | null) => void {
  const call = spawnMock.mock.calls[callIndex]
  if (!call?.[1]) throw new Error(`spawn call ${callIndex} has no onExit callback`)
  return call[1]
}

describe('RuntimeSupervisor 崩溃自动重启（stopping 残留修复）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() 成功后 stopping 复位为 false（此前残留 true 致崩溃重启被短路）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    // 修复前：start() 内部 stop() 的 markStopping 残留 → stopping=true
    expect((sup as unknown as { policy: { stopping: boolean } }).policy.stopping).toBe(false)
  })

  it('运行期崩溃（kill -9 → exit 137）→ 退避 1s 后自动重启（不依赖 liveness 兜底）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    // 模拟 kill -9：子进程退出码 137
    onExitOf(0)(137)

    // 修复前：stopping=true 短路 → 无 restartTimer，60s 后仍只有 1 次 spawn（liveness
    // 被本测试 stub，兜底路径不可达）——本断言即回归钉
    await vi.advanceTimersByTimeAsync(1_000)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('主动 stop() 后 exit 不触发自动重启（既有语义不回归）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    const exit = onExitOf(0)
    await sup.stop()

    vi.useFakeTimers()
    exit(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})
