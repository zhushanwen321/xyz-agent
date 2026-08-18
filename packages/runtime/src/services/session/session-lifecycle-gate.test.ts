/**
 * SessionLifecycle × 迁移 gate（D8-3，perf W29，06 §3.3）时序测试。
 *
 * 锁定三条 gate 语义：
 * - create / restoreSession / forkSession 三处 spawn pi 前必须 await migrationGate
 *   （06 审查修正：fork 是第三处 spawn 点，初稿漏列）。
 * - gate pending 时三处都挂起（pm.createSession 不被调用）；resolve 后放行。
 * - gate 未注入（默认 resolved）时行为与旧版一致（无等待）。
 *
 * gate 是 session-lifecycle 模块级 holder（组合根经 setMigrationGate 注入）——
 * 测试直接 setMigrationGate(deferred) 控制时序；afterEach 重置为 resolved 防串扰。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/session-lifecycle-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionLifecycle, setMigrationGate, getMigrationGate } from './session-lifecycle.js'
import { getSessionsDir } from '../../infra/pi/pi-paths.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { IManagedSessionView, ScannedSession } from './types.js'
import type { SessionSummary } from '@xyz-agent/shared'

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

function makeSessionView(id: string): IManagedSessionView {
  return { id } as unknown as IManagedSessionView
}

/**
 * 构造最小 lifecycle 环境：svc/pm/configStore/sessionStore/workspaceService 全 mock。
 * 只 mock 被测路径用到的成员，其余 cast 通过。
 */
function makeEnv() {
  const svc = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    initializeManagedSession: vi.fn(async (_id: string, _c: unknown, _cwd: string, _label: string) => makeSessionView(_id)),
    toSummary: vi.fn((s: IManagedSessionView) => makeSummary(s.id)),
    // S3-W2：创建入口收敛点（lifecycle 三处 return 前调用）
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    getSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(() => undefined),
  } as unknown as ISessionServiceInternal
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'sess-1', sessionFile: undefined })),
    switchSession: vi.fn(async () => undefined),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    patchSessionCwd: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService)
  return { svc, pm, configStore, sessionStore, workspaceService, client, lifecycle }
}

/** 让当前微任务/宏任务队列排空（gate pending 断言前用）。 */
async function flushTicks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  // 重置模块级 gate——防测试间串扰（默认 resolved = 无 gate 语义）。
  setMigrationGate(Promise.resolve())
})

describe('SessionLifecycle × migration gate（D8-3）', () => {
  describe('create', () => {
    it('gate pending 时 create 挂起（pm.createSession 不被调用），resolve 后放行', async () => {
      const { lifecycle, pm, configStore } = makeEnv()
      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const cwd = mkdtempSync(join(tmpdir(), 'w29-gate-create-'))
      const pending = lifecycle.create(cwd, 't')
      await flushTicks()
      // gate 未 resolve：spawn 未发生，create 仍在挂起
      expect(pm.createSession).not.toHaveBeenCalled()
      expect(configStore.getDefaultModel).toHaveBeenCalledTimes(1)

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('sess-1')
      rmSync(cwd, { recursive: true, force: true })
    })

    it('gate 未注入（默认 resolved）时 create 不等待（与旧版一致）', async () => {
      const { lifecycle, pm } = makeEnv()
      // afterEach 已重置 gate；此处显式再设默认
      setMigrationGate(Promise.resolve())
      const cwd = mkdtempSync(join(tmpdir(), 'w29-gate-create-nogate-'))
      const summary = await lifecycle.create(cwd, 't')
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('sess-1')
      rmSync(cwd, { recursive: true, force: true })
    })
  })

  describe('restoreSession', () => {
    it('gate pending 时 restore 挂起，resolve 后放行', async () => {
      const { lifecycle, pm, svc } = makeEnv()
      const dir = mkdtempSync(join(tmpdir(), 'w29-gate-restore-'))
      const filePath = join(dir, 'session.jsonl')
      writeFileSync(filePath, [
        { type: 'session', version: 3, id: 's-restore', timestamp: '2026-08-16T01:00:00.000Z', cwd: dir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const target: ScannedSession = { id: 's-restore', cwd: dir, filePath, name: 'restored', launchPresetId: undefined } as ScannedSession
      svc.findScannedSession = vi.fn(() => target) as never
      svc.initializeManagedSession = vi.fn(async (_id: string) => makeSessionView('s-restore')) as never
      svc.toSummary = vi.fn(() => makeSummary('s-restore')) as never

      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const pending = lifecycle.restoreSession('s-restore')
      await flushTicks()
      expect(pm.createSession).not.toHaveBeenCalled()

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('s-restore')
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe('forkSession', () => {
    it('gate pending 时 fork 挂起，resolve 后放行', async () => {
      const { lifecycle, pm, svc } = makeEnv()
      // createForkedSessionFile 写入 getSessionsDir()（测试数据目录 sessions 子目录需先建）
      mkdirSync(getSessionsDir(), { recursive: true })
      const dir = mkdtempSync(join(tmpdir(), 'w29-gate-fork-'))
      const sourceFile = join(dir, 'source.jsonl')
      writeFileSync(sourceFile, [
        { type: 'session', version: 3, id: 's-fork-src', timestamp: '2026-08-16T01:00:00.000Z', cwd: dir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-16T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const source: ScannedSession = { id: 's-fork-src', cwd: dir, filePath: sourceFile, launchPresetId: undefined } as ScannedSession
      svc.findScannedSession = vi.fn(() => source) as never
      svc.initializeManagedSession = vi.fn(async (_id: string) => makeSessionView('s-fork-new')) as never
      svc.toSummary = vi.fn(() => makeSummary('s-fork-new')) as never

      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const pending = lifecycle.forkSession('s-fork-src', 'a1', true, 'forked')
      await flushTicks()
      expect(pm.createSession).not.toHaveBeenCalled()

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('s-fork-new')
      rmSync(dir, { recursive: true, force: true })
    })
  })

  it('getMigrationGate 可读当前 gate（组合根注入后非默认）', () => {
    setMigrationGate(Promise.resolve())
    expect(getMigrationGate()).toBeInstanceOf(Promise)
    const deferred = new Promise(() => undefined)
    setMigrationGate(deferred)
    expect(getMigrationGate()).toBe(deferred)
  })
})
