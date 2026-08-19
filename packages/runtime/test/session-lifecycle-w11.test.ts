/**
 * SessionLifecycle.restoreSession 的 cwd fallback 迁 tmp 管线测试（W11，数据源治理）。
 *
 * [HISTORICAL] 原 patchSessionCwd（session-file-utils，atomicWrite 整文件重写源 JSONL
 * 的 header.cwd）已随 W11 删除；cwd 降级改在「读源文件 → stripSessionEndEntries →
 * 对 tmp 首行 header 应用 fallback → 写 tmpdir → switchSession(tmp)」管线内完成，
 * 源文件零写。
 *
 * 锁定（plan W11 步骤 5 / 验收 4）：
 * - 死路径 cwd：spawn cwd 与 tmp 首行 header.cwd 降级 homedir；**源文件字节不变**
 *   （header 永久保持死路径——扫描侧消费差异已声明接受，见 deleteByCwd/label 用例）
 * - 活路径 cwd：tmp 首行 header.cwd 保持原值，源文件不变（行为与迁移前一致）
 * - stripSessionEndEntries 与 cwd fallback 组合：session_end 行剔除后首行仍正确改写
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-w11.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import type { ISessionServiceInternal } from '../src/services/session/session-internal.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IManagedSessionView, ScannedSession } from '../src/services/session/types.js'
import type { SessionSummary } from '@xyz-agent/shared'

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

/** switchSession mock：捕获 pi 实际收到的 tmp 文件内容（restore 内部写后即删）。 */
function makeEnv() {
  const capturedTmp: Array<{ path: string; content: string }> = []
  const client = {
    getState: vi.fn(async () => ({ sessionId: 's-1' })),
    switchSession: vi.fn(async (sessionPath: string) => {
      capturedTmp.push({ path: sessionPath, content: readFileSync(sessionPath, 'utf-8') })
    }),
  }
  const svc = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    initializeManagedSession: vi.fn(async (id: string) => ({ id } as unknown as IManagedSessionView)),
    toSummary: vi.fn(() => makeSummary('s-restore')),
    findScannedSession: vi.fn(() => undefined),
    getSession: vi.fn(() => undefined),
    detachSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(() => undefined),
    notifySessionCreated: vi.fn(),
  } as unknown as ISessionServiceInternal
  const pm = {
    createSession: vi.fn(async () => client),
    destroySession: vi.fn(async () => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService)
  return { lifecycle, svc, pm, sessionStore, client, capturedTmp }
}

/** 构造一个含 session header + 消息 entry 的 JSONL 文本。 */
function makeJsonl(cwd: string, opts: { sessionEnd?: boolean } = {}): string {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 's-restore', timestamp: '2026-08-16T01:00:00.000Z', cwd }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ]
  if (opts.sessionEnd) {
    lines.push(JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: '2026-08-16T01:00:02.000Z' }))
  }
  return lines.join('\n') + '\n'
}

describe('restoreSession cwd fallback 迁 tmp 管线（W11）', () => {
  let dir: string
  let env: ReturnType<typeof makeEnv>
  let filePath: string

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    env = makeEnv()
    dir = mkdtempSync(join(tmpdir(), 'w11-restore-'))
    filePath = join(dir, 'session.jsonl')
  })

  afterEach(() => {
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true })
  })

  function mountTarget(cwd: string): void {
    const target: ScannedSession = {
      id: 's-restore', cwd, filePath, name: 'restored', launchPresetId: undefined,
    } as ScannedSession
    ;(env.svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(target)
  }

  it('死路径 cwd：tmp 首行 header.cwd 降级 homedir，源文件字节不变（零写）', async () => {
    const deadCwd = join(dir, 'deleted-worktree')
    const original = makeJsonl(deadCwd)
    writeFileSync(filePath, original)
    mountTarget(deadCwd)

    await env.lifecycle.restoreSession('s-restore')

    // spawn cwd 降级 homedir
    expect(env.pm.createSession).toHaveBeenCalledWith('s-restore', homedir(), expect.anything())
    // pi 收到的 tmp 拷贝首行 header.cwd = homedir（读改写同处完成）
    expect(env.capturedTmp).toHaveLength(1)
    const header = JSON.parse(env.capturedTmp[0].content.split('\n')[0])
    expect(header.cwd).toBe(homedir())
    // 源文件零写：header 永久保持死路径（已声明接受的行为差异）
    expect(readFileSync(filePath, 'utf-8')).toBe(original)
  })

  it('活路径 cwd：tmp 首行 header.cwd 保持原值，源文件不变（与迁移前一致）', async () => {
    const liveCwd = dir
    const original = makeJsonl(liveCwd)
    writeFileSync(filePath, original)
    mountTarget(liveCwd)

    await env.lifecycle.restoreSession('s-restore')

    expect(env.pm.createSession).toHaveBeenCalledWith('s-restore', liveCwd, expect.anything())
    expect(env.capturedTmp).toHaveLength(1)
    const header = JSON.parse(env.capturedTmp[0].content.split('\n')[0])
    expect(header.cwd).toBe(liveCwd)
    expect(readFileSync(filePath, 'utf-8')).toBe(original)
  })

  it('死路径 cwd + 历史含 session_end 行：strip 与 cwd fallback 组合生效', async () => {
    const deadCwd = join(dir, 'another-deleted')
    writeFileSync(filePath, makeJsonl(deadCwd, { sessionEnd: true }))
    mountTarget(deadCwd)

    await env.lifecycle.restoreSession('s-restore')

    const tmpContent = env.capturedTmp[0].content
    // session_end 行被 strip（W9 行为不回归）
    expect(tmpContent).not.toContain('session_end')
    // 首行 header cwd 已降级
    const header = JSON.parse(tmpContent.split('\n')[0])
    expect(header.cwd).toBe(homedir())
    // 消息 entry 保留
    expect(tmpContent).toContain('"u1"')
  })
})
