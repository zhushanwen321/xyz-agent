/**
 * WorkspaceService.record homedir 守卫单测（方案 A）。
 *
 * homedir 是失效 cwd 的兜底目标，作为「最近工作区」无记录价值（用户不需要从列表点回 homedir）。
 * service 层加 `if (cwd === homedir()) return` 守卫，一处堵死全部调用路径。
 *
 * Mock 策略：注入 mock RecentWorkspacesStore，断言 store.record 的调用次数与参数。
 *
 * 运行：npx vitest run test/workspace-service-homedir.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { RecentWorkspacesStore } from '../src/services/workspace/recent-workspaces-store.js'

function makeMockStore() {
  return {
    record: vi.fn(),
    list: vi.fn(() => []),
  } as unknown as RecentWorkspacesStore
}

/** detectBare 测试无关，给个最小 stub（record/list 不触发 detect）。 */
function makeStubDetector() {
  return { detect: () => ({ isBareMode: false, wsRoot: '', barePath: '' }) } as never
}

describe('WorkspaceService.record homedir 守卫（方案A）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('record(homedir) → store.record 不被调用', () => {
    const store = makeMockStore()
    const svc = new WorkspaceService(store, makeStubDetector())
    svc.record(homedir())
    expect(store.record).not.toHaveBeenCalled()
  })

  it('record(普通路径) → store.record 被调用，参数透传', () => {
    const store = makeMockStore()
    const svc = new WorkspaceService(store, makeStubDetector())
    svc.record('/my/repo')
    expect(store.record).toHaveBeenCalledTimes(1)
    expect(store.record).toHaveBeenCalledWith('/my/repo')
  })

  it('record(空串) → store.record 不被调用（INV-1 既有不变式回归）', () => {
    const store = makeMockStore()
    const svc = new WorkspaceService(store, makeStubDetector())
    svc.record('')
    svc.record('   ')
    expect(store.record).not.toHaveBeenCalled()
  })
})
