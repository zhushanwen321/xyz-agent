/**
 * W1: SessionLifecycle.deleteByCwd 单测 — folder 维度批量删除。
 *
 * 背景：deleteByCwd 合并 active（getActiveSummaries）+ persisted（scanSessions）按 cwd 过滤去重，
 * 串行调 delete(id)，单个失败聚合到 failed，不中断循环。返回 BatchDeleteResult。
 *
 * Mock 策略：参考 session-lifecycle-w5.test.ts，构造 5 个构造依赖（svc/pm/configStore/
 * sessionStore/workspaceService），delete 用 vi.spyOn 覆盖（不走真实文件/trash 路径）。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-deletebycwd.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// deleteByCwd 内部不调 node:fs（delete 才调 existsSync），但真实 delete 走 trash/unlink，
// 这里 spyOn delete 覆盖整段路径，node:fs 不会被触及——不需要 vi.mock。
import { SessionLifecycle } from '../src/services/session/session-lifecycle.js'
import type { ISessionServiceInternal } from '../src/services/session/session-internal.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore, ScannedSessionMeta } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { SessionSummary, BatchDeleteResult } from '@xyz-agent/shared'

/**
 * 构造 lifecycle + delete spy + 注入 mock。
 * delete spy 默认 resolve（成功）；用例可按 id 判定 reject 模拟部分失败。
 */
function makeHarness(deleteImpl?: (id: string) => Promise<void>) {
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const pm = {} as unknown as IProcessManager
  const configStore = {} as unknown as IConfigStore
  const sessionStore = {
    scanSessions: vi.fn((): ScannedSessionMeta[] => []),
    refreshAll: vi.fn(),
  } as unknown as ISessionStore
  const svc = {
    getActiveSummaries: vi.fn((): SessionSummary[] => []),
  } as unknown as ISessionServiceInternal

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspace)
  // spyOn 实例方法 delete，覆盖真实文件/trash/unlink 路径，专注 deleteByCwd 聚合逻辑。
  const deleteSpy = vi.spyOn(lifecycle, 'delete').mockImplementation(
    deleteImpl ?? (async () => {}),
  )
  return { lifecycle, svc, sessionStore, deleteSpy }
}

describe('W1: SessionLifecycle.deleteByCwd — folder 维度批量删除', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W1TC1 串行删除 + 部分失败聚合', async () => {
    // scanSessions: s1/s2（persisted）；getActiveSummaries: s3（active，未 flush 的边界场景）
    const { lifecycle, svc, sessionStore, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', cwd: '/p', filePath: '/p/s1.jsonl' } as ScannedSessionMeta,
      { id: 's2', cwd: '/p', filePath: '/p/s2.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p' } as SessionSummary,
    ])
    // Set 插入顺序：先 active 的 s3，再 scan 的 s1/s2 → 循环顺序 s3, s1, s2
    deleteSpy.mockImplementation(async (id: string) => {
      if (id === 's2') throw new Error('EPERM')
    })

    const result: BatchDeleteResult = await lifecycle.deleteByCwd('/p')

    // 失败聚合（不中断循环）
    expect(result.cwd).toBe('/p')
    expect(result.failed).toEqual([{ sessionId: 's2', error: 'EPERM' }])
    // deleted 含 s1/s3（不依赖顺序）
    expect(result.deleted).toHaveLength(2)
    expect(result.deleted).toEqual(expect.arrayContaining(['s1', 's3']))
    expect(result.deleted).not.toContain('s2')
    // delete 被调 3 次（每个 session 一次，失败的也调）
    expect(deleteSpy).toHaveBeenCalledTimes(3)
  })

  it('W1TC2 空 folder 幂等', async () => {
    const { lifecycle, sessionStore, svc, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'x', cwd: '/other', filePath: '/other/x.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])

    const result = await lifecycle.deleteByCwd('/empty')

    expect(result).toEqual({ cwd: '/empty', deleted: [], failed: [] })
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('W1TC3 active + scanned 去重', async () => {
    // s3 同时出现在 active（getActiveSummaries）和 persisted（scanSessions）→ Set 去重为 1 个
    const { lifecycle, svc, sessionStore, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p', filePath: '/p/s3.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p' } as SessionSummary,
    ])

    const result = await lifecycle.deleteByCwd('/p')

    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy).toHaveBeenCalledWith('s3')
    expect(result).toEqual({ cwd: '/p', deleted: ['s3'], failed: [] })
  })
})
