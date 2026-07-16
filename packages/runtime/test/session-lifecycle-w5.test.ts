/**
 * W5: session-lifecycle create cwd 降级到 homedir 时不污染最近工作区列表。
 *
 * 背景：用户选失效 cwd → create 内部 existsSync 降级 homedir（D-008）→
 * 旧代码无条件 record(sessionCwd)，把 homedir 写入「最近工作区」列表。
 * homedir 不是真实工作区，不该出现在列表里。
 *
 * 修复：当 requestedCwd !== sessionCwd（降级发生）时跳过 record。
 *
 * Mock 策略：vi.mock('node:fs') 控制 existsSync 降级；其余依赖全注入 mock。
 *
 * 运行：npx vitest run test/session-lifecycle-w5.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'

// existsSync 由本测试控制，决定是否触发 homedir 降级
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))
vi.mock('node:fs', () => ({
  existsSync: fsMock.existsSync,
  // createForkedSessionFile / getSessionsDir 可能间接用到，给空实现
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { SessionLifecycle } from '../src/services/session/session-lifecycle.js'
import type { ISessionServiceInternal } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { SessionSummary } from '@xyz-agent/shared'

function makeMocks() {
  const recordFn = vi.fn()
  const workspace = { record: recordFn } as unknown as WorkspaceService

  const client = {
    getState: vi.fn(async () => ({ sessionId: 'pi-s1', sessionFile: '/tmp/pi.jsonl' })),
    prompt: vi.fn(async () => ({})),
  } as unknown as IPiEngine

  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => {}),
  } as unknown as IProcessManager

  // initializeManagedSession 接收 lifecycle 传入的 sessionCwd（可能已降级），原样存入 session.cwd
  // 与 toSummary 一并透传，保证 summary.cwd 反映真实降级结果
  const session = { id: 'pi-s1', cwd: '/repo' } as IManagedSessionView

  const svc = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    initializeManagedSession: vi.fn(async (_id: string, _client: unknown, cwd: string) => {
      session.cwd = cwd
      return session
    }),
    toSummary: vi.fn((): SessionSummary => ({
      id: session.id, cwd: session.cwd, label: 'repo', status: 'idle', lastActiveAt: 1,
      modelId: 'test-model', tokenCount: 0,
    })),
  } as unknown as ISessionServiceInternal

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = { refreshAll: vi.fn() } as unknown as ISessionStore

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspace)
  return { lifecycle, recordFn, pm, session }
}

describe('W5: session-lifecycle create record 调用（homedir 过滤归位 service 层）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('cwd 未降级（existsSync=true）→ workspaceService.record 被调用，参数为 cwd', async () => {
    fsMock.existsSync.mockReturnValue(true)
    const { lifecycle, recordFn } = makeMocks()
    await lifecycle.create('/my/repo', 'repo')
    expect(recordFn).toHaveBeenCalledTimes(1)
    expect(recordFn).toHaveBeenCalledWith('/my/repo')
  })

  it('cwd 降级到 homedir（existsSync=false）→ workspaceService.record 仍被调用，参数为 homedir（过滤由 service 层负责）', async () => {
    fsMock.existsSync.mockReturnValue(false)
    const { lifecycle, recordFn } = makeMocks()
    await lifecycle.create('/deleted/path', 'deleted')
    // [方案A] lifecycle 无条件 record（传降级后的 homedir），service 层的 homedir 守卫负责过滤
    expect(recordFn).toHaveBeenCalledTimes(1)
    expect(recordFn).toHaveBeenCalledWith(homedir())
  })

  it('cwd 降级到 homedir → session.cwd 仍是 homedir（降级逻辑本身不变）', async () => {
    fsMock.existsSync.mockReturnValue(false)
    const { lifecycle } = makeMocks()
    const summary = await lifecycle.create('/deleted/path', 'deleted')
    expect(summary.cwd).toBe(homedir())
  })

  it('hidden session → record 不被调用（既有不变式，回归防护）', async () => {
    fsMock.existsSync.mockReturnValue(true)
    const { lifecycle, recordFn } = makeMocks()
    await lifecycle.create('/repo', 'repo', { hidden: true })
    expect(recordFn).not.toHaveBeenCalled()
  })
})
