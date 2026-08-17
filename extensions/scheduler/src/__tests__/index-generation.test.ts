// src/__tests__/index-generation.test.ts
//
// G1（S9 review 修复）集成单测：index.ts 装配点为每代 SchedulerRuntime 注入代际检测回调
// （闭包 sessionGeneration 比对），使 stale 分诊不依赖 pi 错误文案。
//
// 本文件用 InstrumentedRuntime（继承真实 SchedulerRuntime，仅记录构造第三参 isCtxStale）
// 捕获注入回调，跨三次 session_start 验证代数接线：任意前代回调返回 true（session 已被
// 替换），当前代返回 false。InstrumentedRuntime 全部行为继承父类，不影响装配链本身
// （F1 停旧 timer 等行为由 index-session-start.test.ts U4 锚定，此处不重复）。

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 与 index-session-start.test.ts 同款（MF-3）：mock 掉 importer，装配路径仍被调用、FS 副作用为零。
vi.mock('../importer.js', () => ({ importLegacyStore: vi.fn(() => vi.fn()) }))

// vi.mock factory 会被提升，跨模块共享状态必须经 vi.hoisted。
const { isCtxStaleCaptures, runtimeInstances } = vi.hoisted(() => ({
  isCtxStaleCaptures: [] as Array<(() => boolean) | undefined>,
  runtimeInstances: [] as Array<{ stopScheduler(): void }>,
}))

// InstrumentedRuntime 继承真实实现（loadTasks/onAfterTick/startScheduler 均真实执行），
// 仅捕获构造第三参并登记实例（afterEach 统一停 timer，避免真实 setInterval 残留）。
vi.mock('../runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime.js')>()
  const RealSchedulerRuntime = actual.SchedulerRuntime
  class InstrumentedRuntime extends RealSchedulerRuntime {
    constructor(
      backend: ConstructorParameters<typeof RealSchedulerRuntime>[0],
      ctx: ConstructorParameters<typeof RealSchedulerRuntime>[1],
      isCtxStale?: () => boolean,
    ) {
      super(backend, ctx, isCtxStale)
      isCtxStaleCaptures.push(isCtxStale)
      runtimeInstances.push(this)
    }
  }
  return { ...actual, SchedulerRuntime: InstrumentedRuntime }
})

import schedulerExtension from '../index.js'

/**
 * 最小 fake pi：与 index-session-start.test.ts 同款，覆盖 factory 消费的 API 面
 * （on 捕获事件 handler 供手动触发；registerTool/registerCommand/sendMessage/appendEntry 兜底）。
 */
function createMockPi(): {
  pi: ExtensionAPI
  events: Map<string, (...args: unknown[]) => void>
} {
  const events = new Map<string, (...args: unknown[]) => void>()
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI
  return { pi, events }
}

/** 最小 fake ctx：覆盖 session_start 装配链读到的全部字段（backend 构造 / runtime 构造 / refreshWidget）。 */
function createFakeCtx(sessionFile: string): ExtensionContext {
  return {
    cwd: '/test-index-generation',
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setWidget: vi.fn() },
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext
}

describe('G1: index.ts 代际接线（S9）', () => {
  beforeEach(() => {
    isCtxStaleCaptures.length = 0
    runtimeInstances.length = 0
  })

  afterEach(() => {
    for (const rt of runtimeInstances) {
      rt.stopScheduler()
    }
  })

  it('每次 session_start 注入 isCtxStale：当前代 false、任意前代 true（跨三代）', () => {
    const { pi, events } = createMockPi()
    schedulerExtension(pi)
    const sessionStart = events.get('session_start')
    expect(sessionStart).toBeDefined()

    // 第 1 代
    sessionStart!({ type: 'session_start', reason: 'startup' }, createFakeCtx('/test/gen-1.json'))
    expect(isCtxStaleCaptures[0]).toBeTypeOf('function')
    expect(isCtxStaleCaptures[0]!()).toBe(false) // 当前代未替换

    // 第 2 代（session 替换）：第 1 代自此 stale，第 2 代为当前代
    sessionStart!({ type: 'session_start', reason: 'new_session' }, createFakeCtx('/test/gen-2.json'))
    expect(isCtxStaleCaptures[0]!()).toBe(true)
    expect(isCtxStaleCaptures[1]!()).toBe(false)

    // 第 3 代（resume 重入）：前两代均 stale
    sessionStart!({ type: 'session_start', reason: 'resume' }, createFakeCtx('/test/gen-3.json'))
    expect(isCtxStaleCaptures[0]!()).toBe(true)
    expect(isCtxStaleCaptures[1]!()).toBe(true)
    expect(isCtxStaleCaptures[2]!()).toBe(false)
  })
})
