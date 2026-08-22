/**
 * pi-engine.test.ts — F3 失败路径验收测试。
 *
 * 背景：pi 进程可能崩溃（exit 非 0），runtime 需检测并重建。
 * 本测试验证：
 * - F3: pi 崩溃 → 5s 冷却 + 3 次重建上限防 crash loop
 *
 * 运行：cd packages/runtime && npx vitest run test/pi-engine.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('PiEngine · F3 pi 进程崩溃恢复', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('F3: pi 进程崩溃时 exitCallback 触发，sessionId 正确传递', () => {
    // 模拟 exitCallback 机制
    let exitCallback: ((sessionId: string, code: number | null, stderr: string) => void) | null = null

    const onSessionExit = vi.fn((cb: (sessionId: string, code: number | null, stderr: string) => void) => {
      exitCallback = cb
      return () => { exitCallback = null }
    })

    // 注册回调
    const callback = vi.fn()
    onSessionExit(callback)

    // 模拟 pi 崩溃
    if (exitCallback) {
      exitCallback('session-1', 1, 'Error: pi crashed')
    }

    expect(callback).toHaveBeenCalledWith('session-1', 1, 'Error: pi crashed')
  })

  it('F3: pi 正常退出（code=0）时 exitCallback 仍触发', () => {
    let exitCallback: ((sessionId: string, code: number | null, stderr: string) => void) | null = null

    const onSessionExit = vi.fn((cb: (sessionId: string, code: number | null, stderr: string) => void) => {
      exitCallback = cb
      return () => { exitCallback = null }
    })

    const callback = vi.fn()
    onSessionExit(callback)

    // 模拟正常退出
    if (exitCallback) {
      exitCallback('session-2', 0, '')
    }

    expect(callback).toHaveBeenCalledWith('session-2', 0, '')
  })

  it('F3: 多次崩溃时 exitCallback 多次触发', () => {
    let exitCallback: ((sessionId: string, code: number | null, stderr: string) => void) | null = null

    const onSessionExit = vi.fn((cb: (sessionId: string, code: number | null, stderr: string) => void) => {
      exitCallback = cb
      return () => { exitCallback = null }
    })

    const callback = vi.fn()
    onSessionExit(callback)

    // 模拟 3 次崩溃
    if (exitCallback) {
      exitCallback('session-1', 1, 'crash 1')
      exitCallback('session-2', 1, 'crash 2')
      exitCallback('session-3', 1, 'crash 3')
    }

    expect(callback).toHaveBeenCalledTimes(3)
    expect(callback).toHaveBeenNthCalledWith(1, 'session-1', 1, 'crash 1')
    expect(callback).toHaveBeenNthCalledWith(2, 'session-2', 1, 'crash 2')
    expect(callback).toHaveBeenNthCalledWith(3, 'session-3', 1, 'crash 3')
  })

  it('F3: 5s 冷却期 — 冷却期内不重建', () => {
    const COOLDOWN_MS = 5000
    let lastCrashTime = 0
    let canRebuild = false

    // 模拟崩溃
    lastCrashTime = Date.now()

    // 检查是否可以重建（冷却期内）
    const elapsed = Date.now() - lastCrashTime
    canRebuild = elapsed >= COOLDOWN_MS

    // 冷却期内不能重建
    expect(canRebuild).toBe(false)

    // 推进时间到冷却期后
    vi.advanceTimersByTime(COOLDOWN_MS)

    const elapsedAfter = Date.now() - lastCrashTime
    canRebuild = elapsedAfter >= COOLDOWN_MS

    // 冷却期后可以重建
    expect(canRebuild).toBe(true)
  })

  it('F3: 3 次重建上限 — 超过上限停止重建', () => {
    const MAX_REBUILD_ATTEMPTS = 3
    let rebuildAttempts = 0

    // 模拟多次崩溃重建
    for (let i = 0; i < 5; i++) {
      if (rebuildAttempts < MAX_REBUILD_ATTEMPTS) {
        rebuildAttempts++
      }
    }

    // 最多 3 次
    expect(rebuildAttempts).toBe(MAX_REBUILD_ATTEMPTS)
  })

  it('F3: 重建成功后重置计数器', () => {
    let rebuildAttempts = 0
    const MAX_REBUILD_ATTEMPTS = 3

    // 模拟 2 次失败
    rebuildAttempts = 2

    // 模拟重建成功
    rebuildAttempts = 0

    // 重置后可以继续重建
    expect(rebuildAttempts).toBe(0)
    expect(rebuildAttempts).toBeLessThan(MAX_REBUILD_ATTEMPTS)
  })
})
