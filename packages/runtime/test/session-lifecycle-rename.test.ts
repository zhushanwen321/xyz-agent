/**
 * session-lifecycle-rename.test.ts — W1（数据源治理 P0）label 链路切 pi RPC 验收测试。
 *
 * 背景：活跃 session 的 label 曾由 xyz runtime 直写 pi session JSONL（persistSessionName），
 * 与 pi 进程内 rename-session 扩展的 auto-rename 互不知情，last-write-wins 导致
 * 「用户手动命名的 session 被 auto-rename 静默覆盖」。W1 后活跃 label 的唯一写入口 =
 * pi set_session_name RPC；turn_end/agent_end 的 label 兜底直写机制（含字段标记）整体删除。
 *
 * 四断言组（w1-acceptance「单测验收」）：
 *   1. 活跃 rename 走 RPC：setSessionName 被调 + 不再直写 persistSessionName；
 *      client 不可用（pi 崩溃窗口）/ RPC 失败必须 throw（禁静默丢写）
 *   2. create / forkSession 显式 label 走 RPC（失败不阻断创建）
 *   3. 派生 label（basename(cwd)）不触发 RPC（退役为显示派生，auto-rename 守卫照常通过）
 *   4. 非活跃 rename 仍走 persistSessionName 直写（legacy 例外，W2 登记 W11 移除）
 *
 * Mock 边界与 contract-hardening.test.ts 同款：svc/pm/configStore/sessionStore 注入 mock，
 * session-fork 模块 mock（返回受控产物指向真实 tmp 文件）；fs 相关 fixture 用真实 tmp。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-rename.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

// fork 用例 mock 截断函数（真实 createForkedSessionFile 操作 sessions 数据目录，
// 单测无该基建；返回受控 filePath 指向真实 tmp 文件供后续 strip/switch 流程使用）
vi.mock('../src/services/session/session-fork.js', () => ({
  createForkedSessionFile: vi.fn(async () => ({ filePath: '', sessionId: 'fork-1' })),
}))

import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import { sessionMetaCache } from '../src/services/session/session-meta-cache.js'
import type { ISessionServiceInternal } from '../src/services/session/session-internal.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { SessionSummary } from '@xyz-agent/shared'

// ── Mock 协作者 ────────────────────────────────────────────────────

/** lifecycle 实际消费的最小 client 形状（create 用 getState / fork 用 switchSession / 共用 setSessionName）。 */
interface MockClient {
  getState: MockInstance<() => Promise<Record<string, unknown> | undefined>>
  switchSession: MockInstance<(sessionPath: string) => Promise<void>>
  setSessionName: MockInstance<(name: string) => Promise<unknown>>
}

function makeClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({}),
    switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockResolvedValue(undefined),
    setSessionName: vi.fn<(name: string) => Promise<unknown>>().mockResolvedValue(undefined),
    ...overrides,
  }
}

/** 完整 IManagedSessionView 字面量（renameSession 会原地改 label，需真实对象）。 */
function makeSessionView(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 'sid-1',
    cwd: '/repo',
    label: '旧名',
    modelId: 'p/m',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    ...overrides,
  }
}

/** 测试装置：lifecycle + 各 mock 依赖 + 可手动挂载的 session/client Map。 */
function makeEnv() {
  // pm.getClient 的数据源（renameSession 活跃分支经 pm.getClient 查 client）
  const clientMap = new Map<string, MockClient>()
  // svc.getSession 的数据源（活跃 session 视图）
  const sessionMap = new Map<string, IManagedSessionView>()

  const svc = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    initializeManagedSession: vi.fn(async (id: string, _client: IPiEngine, _cwd: string, label: string) =>
      makeSessionView({ id, label })),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1, modelId: 'p/m', tokenCount: 0,
    })),
    findScannedSession: vi.fn(() => undefined),
    getSession: vi.fn((id: string) => sessionMap.get(id)),
    fetchAndBroadcastContext: vi.fn(async () => {}),
    notifySessionCreated: vi.fn(),
  } as unknown as ISessionServiceInternal

  const pm = {
    createSession: vi.fn(async (id: string) => {
      const client = makeClient()
      clientMap.set(id, client)
      return client
    }),
    destroySession: vi.fn(async () => {}),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn(() => undefined),
    hasClient: vi.fn(() => false),
    rekey: vi.fn((oldId: string, newId: string) => {
      const c = clientMap.get(oldId)
      if (c) { clientMap.delete(oldId); clientMap.set(newId, c) }
    }),
    onSessionExit: vi.fn(() => {}),
    destroyAll: vi.fn(async () => {}),
  } as unknown as IProcessManager

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistSessionName: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
  } as unknown as ISessionStore

  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService)

  return {
    lifecycle, svc, pm, sessionStore, clientMap, sessionMap,
    /** 手动挂载活跃 session + client（rename 用例直入活跃分支）。 */
    mountActive: (id: string, client: MockClient, session?: IManagedSessionView) => {
      clientMap.set(id, client)
      sessionMap.set(id, session ?? makeSessionView({ id }))
    },
  }
}

type Env = ReturnType<typeof makeEnv>

// ── Tests ─────────────────────────────────────────────────────────

describe('SessionLifecycle · W1 label 链路切 pi set_session_name RPC', () => {
  let env: Env
  let tmpDir: string
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    sessionMetaCache.clear()
    env = makeEnv()
    tmpDir = mkdtempSync(join(tmpdir(), 'w1-rename-'))
    // RPC 降级路径的 console.error 静音（防噪 + 可断言）
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    setMigrationGate(Promise.resolve())
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── 断言组 1：活跃 rename 走 RPC ─────────────────────────────────
  describe('断言组 1：活跃 session rename → set_session_name RPC（不直写）', () => {
    it('活跃 rename 调 client.setSessionName(newName)，不再调 persistSessionName', async () => {
      const session = makeSessionView({ id: 'sid-1', label: '旧名' })
      const client = makeClient()
      env.mountActive('sid-1', client, session)

      await env.lifecycle.renameSession('sid-1', '重构计划')

      expect(client.setSessionName).toHaveBeenCalledTimes(1)
      expect(client.setSessionName).toHaveBeenCalledWith('重构计划')
      // 直写路径必须消失（last-write-wins bug 根源）
      expect(env.sessionStore.persistSessionName).not.toHaveBeenCalled()
      // 内存 label + metaCache 更新保留（P0 阶段 metaCache 未删）
      expect(session.label).toBe('重构计划')
      expect(sessionMetaCache.getLabel('sid-1')).toBe('重构计划')
      // 列表缓存失效仍触发（侧栏立即显示新名）
      expect(env.sessionStore.invalidateScanCache).toHaveBeenCalled()
      expect(env.sessionStore.refreshAll).toHaveBeenCalled()
    })

    it('pi client 不可用（崩溃窗口）→ throw，不静默丢写、内存保留旧名', async () => {
      const session = makeSessionView({ id: 'sid-2', label: '旧名' })
      env.sessionMap.set('sid-2', session)
      // 不挂 client：pm.getClient 返回 undefined

      await expect(env.lifecycle.renameSession('sid-2', '新名')).rejects.toThrow('pi process is not available')

      expect(env.sessionStore.persistSessionName).not.toHaveBeenCalled()
      // 先 RPC 后改内存：失败时旧名保留可重试
      expect(session.label).toBe('旧名')
    })

    it('RPC 失败（success:false / 超时 reject）→ throw 给上层 toast，内存保留旧名', async () => {
      const session = makeSessionView({ id: 'sid-3', label: '旧名' })
      const client = makeClient({
        setSessionName: vi.fn<(name: string) => Promise<unknown>>()
          .mockRejectedValue(new Error('RPC command "set_session_name" failed')),
      })
      env.mountActive('sid-3', client, session)

      await expect(env.lifecycle.renameSession('sid-3', '新名')).rejects.toThrow('set_session_name')

      expect(env.sessionStore.persistSessionName).not.toHaveBeenCalled()
      expect(session.label).toBe('旧名')
    })
  })

  // ── 断言组 2：create / fork 显式 label 走 RPC ────────────────────
  describe('断言组 2：create / forkSession 显式 label → set_session_name RPC', () => {
    it('create(显式 label) → client 就绪后调 setSessionName(label)', async () => {
      const client = makeClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>()
          .mockResolvedValue({ sessionId: 'pi-1', sessionFile: join(tmpDir, 'pi-1.jsonl') }),
      })
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.create(tmpDir, '显式名')

      expect(client.setSessionName).toHaveBeenCalledTimes(1)
      expect(client.setSessionName).toHaveBeenCalledWith('显式名')
      expect(env.sessionStore.persistSessionName).not.toHaveBeenCalled()
    })

    it('create 显式 label 的 RPC 失败不阻断 create（summary 正常返回 + console.error 上报）', async () => {
      const client = makeClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>()
          .mockResolvedValue({ sessionId: 'pi-2', sessionFile: join(tmpDir, 'pi-2.jsonl') }),
        setSessionName: vi.fn<(name: string) => Promise<unknown>>()
          .mockRejectedValue(new Error('RPC command "set_session_name" timed out')),
      })
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      const summary = await env.lifecycle.create(tmpDir, '显式名')

      // 不阻断：session 正常创建，label 留内存显示
      expect(summary.id).toBe('pi-2')
      expect(summary.label).toBe('显式名')
      // 上报失败（恢复动作 = 手动 rename 重试）
      expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('forkSession(显式 label) → switchSession 成功后调 setSessionName(label)', async () => {
      const sourceFile = join(tmpDir, 'src.jsonl')
      writeFileSync(sourceFile, '{"type":"session","id":"src-1"}\n')
      const forkedFile = join(tmpDir, 'fork-1.jsonl')
      writeFileSync(forkedFile, '{"type":"session","id":"fork-1"}\n')

      vi.mocked(env.svc.findScannedSession).mockReturnValue({
        id: 'src-1', filePath: sourceFile, cwd: tmpDir, name: 'src',
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      const { createForkedSessionFile } = await import('../src/services/session/session-fork.js')
      vi.mocked(createForkedSessionFile).mockResolvedValue({ filePath: forkedFile, sessionId: 'fork-1', sourceFilePath: sourceFile })

      const client = makeClient()
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.forkSession('src-1', 'e1', true, 'fork 显式名')

      expect(client.setSessionName).toHaveBeenCalledTimes(1)
      expect(client.setSessionName).toHaveBeenCalledWith('fork 显式名')
      expect(env.sessionStore.persistSessionName).not.toHaveBeenCalled()
    })
  })

  // ── 断言组 3：派生 label 不触发 RPC ──────────────────────────────
  describe('断言组 3：派生 label（basename(cwd)）不触发 RPC、不持久化', () => {
    it('create 不传 label → 显示用 basename(cwd)，不调 setSessionName、不直写', async () => {
      const client = makeClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>()
          .mockResolvedValue({ sessionId: 'pi-3', sessionFile: join(tmpDir, 'pi-3.jsonl') }),
      })
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.create(tmpDir)

      // 派生值仅作显示（initializeManagedSession 收到 basename），不进任何持久化路径
      expect(env.svc.initializeManagedSession).toHaveBeenCalledWith(
        'pi-3', client, tmpDir, basename(tmpDir), join(tmpDir, 'pi-3.jsonl'), undefined,
        undefined, undefined, undefined,
      )
      expect(client.setSessionName).not.toHaveBeenCalled()
      expect(env.sessionStore.persistSessionName).not.toHaveBeenCalled()
    })

    it('forkSession 不传 label → 同样不调 setSessionName', async () => {
      const sourceFile = join(tmpDir, 'src2.jsonl')
      writeFileSync(sourceFile, '{"type":"session","id":"src-2"}\n')
      const forkedFile = join(tmpDir, 'fork-2.jsonl')
      writeFileSync(forkedFile, '{"type":"session","id":"fork-2"}\n')

      vi.mocked(env.svc.findScannedSession).mockReturnValue({
        id: 'src-2', filePath: sourceFile, cwd: tmpDir, name: 'src',
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      const { createForkedSessionFile } = await import('../src/services/session/session-fork.js')
      vi.mocked(createForkedSessionFile).mockResolvedValue({ filePath: forkedFile, sessionId: 'fork-2', sourceFilePath: sourceFile })

      const client = makeClient()
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.forkSession('src-2', 'e1', true)

      expect(client.setSessionName).not.toHaveBeenCalled()
      expect(env.sessionStore.persistSessionName).not.toHaveBeenCalled()
    })
  })

  // ── 断言组 4：非活跃分支不变（legacy 直写例外）───────────────────
  describe('断言组 4：非活跃 rename 仍走 persistSessionName 直写（W11 前登记例外）', () => {
    it('非活跃 rename → persistSessionName(filePath, name, id, cwd)，不调 setSessionName', async () => {
      const file = join(tmpDir, 'inactive.jsonl')
      writeFileSync(file, '{"type":"session","id":"scan-1"}\n')
      vi.mocked(env.svc.findScannedSession).mockReturnValue({
        id: 'scan-1', filePath: file, cwd: tmpDir, name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })

      await env.lifecycle.renameSession('scan-1', 'legacy 直写')

      expect(env.sessionStore.persistSessionName).toHaveBeenCalledTimes(1)
      expect(env.sessionStore.persistSessionName).toHaveBeenCalledWith(file, 'legacy 直写', 'scan-1', tmpDir)
      // 非活跃分支无 pi 进程，不经 RPC
      for (const client of env.clientMap.values()) {
        expect(client.setSessionName).not.toHaveBeenCalled()
      }
      expect(env.sessionStore.invalidateScanCache).toHaveBeenCalled()
      expect(env.sessionStore.refreshAll).toHaveBeenCalled()
    })
  })
})
