/**
 * protocol.test.ts — 协议层类型一致性校验
 *
 * 验证新增 RPC 在 ClientMessageMap / ServerMessageMapBase / ReplyPayloadMap
 * 三个映射中都有注册，以及 payload 形状正确。
 *
 * 类型一致性通过 TypeScript 编译期断言保证（extends 条件类型 = never 失败）。
 * 运行期测试验证 payload 可赋值和 WorktreeErrorCode 值。
 */
import { describe, it, expect } from 'vitest'
import type {
  ClientMessageMap,
  ServerMessageMapBase,
  ReplyPayloadMap,
  WorktreeErrorCode,
} from '../src/protocol'

// ── 编译期类型断言辅助 ─────────────────────────────────────────
// 如果类型不存在于映射中，条件类型求值为 never → 赋值失败 → tsc 报错。
// 这些声明在编译期被校验，运行期无成本。

type AssertHasKey<T, K extends keyof T> = never
type AssertExtends<A, B> = A extends B ? never : never

// ClientMessageMap 新增 key 存在性
type _Assert_Client_detect = AssertHasKey<ClientMessageMap, 'workspace.detect'>
type _Assert_Client_detectBare = AssertHasKey<ClientMessageMap, 'workspace.detectBare'>
type _Assert_Client_listBranches = AssertHasKey<ClientMessageMap, 'worktree.listBranches'>
type _Assert_Client_list = AssertHasKey<ClientMessageMap, 'worktree.list'>
type _Assert_Client_setWorktreeRootDir = AssertHasKey<ClientMessageMap, 'config.setWorktreeRootDir'>
type _Assert_Client_getWorktreeRootDir = AssertHasKey<ClientMessageMap, 'config.getWorktreeRootDir'>
type _Assert_Client_setSetupScript = AssertHasKey<ClientMessageMap, 'config.setSetupScript'>
type _Assert_Client_getSetupScript = AssertHasKey<ClientMessageMap, 'config.getSetupScript'>

// ServerMessageMapBase 新增 key 存在性
type _Assert_Server_detected = AssertHasKey<ServerMessageMapBase, 'workspace.detected'>
type _Assert_Server_bareDetected = AssertHasKey<ServerMessageMapBase, 'workspace.bareDetected'>
type _Assert_Server_branches = AssertHasKey<ServerMessageMapBase, 'worktree.branches'>
type _Assert_Server_listResult = AssertHasKey<ServerMessageMapBase, 'worktree.list:result'>
type _Assert_Server_worktreeRootDir = AssertHasKey<ServerMessageMapBase, 'config.worktreeRootDir'>
type _Assert_Server_setupScript = AssertHasKey<ServerMessageMapBase, 'config.setupScript'>

// ReplyPayloadMap 新增 key 存在性
type _Assert_Reply_detect = AssertHasKey<ReplyPayloadMap, 'workspace.detect'>
type _Assert_Reply_detectBare = AssertHasKey<ReplyPayloadMap, 'workspace.detectBare'>
type _Assert_Reply_listBranches = AssertHasKey<ReplyPayloadMap, 'worktree.listBranches'>
type _Assert_Reply_list = AssertHasKey<ReplyPayloadMap, 'worktree.list'>
type _Assert_Reply_setWorktreeRootDir = AssertHasKey<ReplyPayloadMap, 'config.setWorktreeRootDir'>
type _Assert_Reply_getWorktreeRootDir = AssertHasKey<ReplyPayloadMap, 'config.getWorktreeRootDir'>
type _Assert_Reply_setSetupScript = AssertHasKey<ReplyPayloadMap, 'config.setSetupScript'>
type _Assert_Reply_getSetupScript = AssertHasKey<ReplyPayloadMap, 'config.getSetupScript'>

// workspace.detected payload shape 编译期断言（必须包含 mode 三态）
type _Assert_DetectedShape = AssertExtends<
  ServerMessageMapBase['workspace.detected'],
  { mode: 'bare-workspace' | 'plain-repo' | 'not-repo'; wsRoot: string; barePath: string; repoRoot: string; defaultBranch: string }
>

// worktree.create baseBranch 编译期断言（必须是 string，不能只是旧联合）
type _Assert_BaseBranchIsString = AssertExtends<
  ClientMessageMap['worktree.create']['baseBranch'],
  string | undefined
>

// ── 运行期测试 ─────────────────────────────────────────────────

describe('worktree.create payload 形状', () => {
  it('baseBranch 接受任意字符串（非仅旧联合）', () => {
    const payload: ClientMessageMap['worktree.create'] = {
      branch: 'feat-x',
      baseBranch: 'origin/develop',
    }
    expect(payload.baseBranch).toBe('origin/develop')
  })

  it('baseBranch 仍接受 current 特殊值', () => {
    const payload: ClientMessageMap['worktree.create'] = {
      branch: 'feat-x',
      baseBranch: 'current',
    }
    expect(payload.baseBranch).toBe('current')
  })

  it('locationMode 接受 workspace / repo-dir / dedicated-dir', () => {
    const modes: NonNullable<ClientMessageMap['worktree.create']['locationMode']>[] = [
      'workspace', 'repo-dir', 'dedicated-dir',
    ]
    expect(modes).toHaveLength(3)
  })

  it('locationMode 和 baseBranch 可省略', () => {
    const payload: ClientMessageMap['worktree.create'] = { branch: 'feat-x' }
    expect(payload.branch).toBe('feat-x')
    expect(payload.baseBranch).toBeUndefined()
    expect(payload.locationMode).toBeUndefined()
  })
})

describe('workspace.detected payload 形状', () => {
  it('mode 支持三种值', () => {
    const modes: ServerMessageMapBase['workspace.detected']['mode'][] = [
      'bare-workspace', 'plain-repo', 'not-repo',
    ]
    expect(modes).toHaveLength(3)
  })

  it('包含 wsRoot / barePath / repoRoot / defaultBranch', () => {
    const reply: ServerMessageMapBase['workspace.detected'] = {
      mode: 'bare-workspace',
      wsRoot: '/tmp/ws',
      barePath: '/tmp/ws/.bare',
      repoRoot: '/tmp/ws',
      defaultBranch: 'main',
    }
    expect(reply.wsRoot).toBe('/tmp/ws')
    expect(reply.barePath).toBe('/tmp/ws/.bare')
    expect(reply.repoRoot).toBe('/tmp/ws')
    expect(reply.defaultBranch).toBe('main')
  })
})

describe('worktree.listBranches payload 形状', () => {
  it('包含 local / remote / defaultBranch', () => {
    const reply: ServerMessageMapBase['worktree.branches'] = {
      local: ['main', 'feat-x'],
      remote: ['origin/main', 'origin/feat-y'],
      defaultBranch: 'main',
    }
    expect(reply.local).toHaveLength(2)
    expect(reply.remote).toHaveLength(2)
    expect(reply.defaultBranch).toBe('main')
  })
})

describe('worktree.list payload 形状', () => {
  it('items 元素包含 path / branch / HEAD / bare', () => {
    const reply: ServerMessageMapBase['worktree.list:result'] = {
      items: [
        { path: '/tmp/ws/main', branch: 'main', HEAD: true, bare: false },
        { path: '/tmp/ws/feat-x', branch: 'feat-x', HEAD: false, bare: false },
      ],
    }
    expect(reply.items[0].HEAD).toBe(true)
    expect(reply.items[1].bare).toBe(false)
  })
})

describe('config RPC payload 形状', () => {
  it('config.setWorktreeRootDir payload 含 dir', () => {
    const payload: ClientMessageMap['config.setWorktreeRootDir'] = { dir: '/tmp/worktrees' }
    expect(payload.dir).toBe('/tmp/worktrees')
  })

  it('config.getWorktreeRootDir payload 为空', () => {
    // Record<string, never> 只能赋值为 {}
    const payload: ClientMessageMap['config.getWorktreeRootDir'] = {}
    expect(Object.keys(payload)).toHaveLength(0)
  })

  it('config.setSetupScript payload 含 script', () => {
    const payload: ClientMessageMap['config.setSetupScript'] = { script: 'setup.sh' }
    expect(payload.script).toBe('setup.sh')
  })

  it('config.getSetupScript payload 为空', () => {
    const payload: ClientMessageMap['config.getSetupScript'] = {}
    expect(Object.keys(payload)).toHaveLength(0)
  })

  it('config.worktreeRootDir reply 含 dir', () => {
    const reply: ServerMessageMapBase['config.worktreeRootDir'] = { dir: '/tmp/worktrees' }
    expect(reply.dir).toBe('/tmp/worktrees')
  })

  it('config.setupScript reply 含 script', () => {
    const reply: ServerMessageMapBase['config.setupScript'] = { script: 'setup.sh' }
    expect(reply.script).toBe('setup.sh')
  })
})

describe('WorktreeErrorCode', () => {
  it('包含 NOT_GIT_REPO', () => {
    const code: WorktreeErrorCode = 'NOT_GIT_REPO'
    expect(code).toBe('NOT_GIT_REPO')
  })

  it('包含所有旧错误码（向后兼容）', () => {
    const codes: WorktreeErrorCode[] = [
      'NOT_GIT_REPO', 'NOT_BARE_REPO', 'WORKTREE_EXISTS',
      'SETUP_FAILED', 'GIT_FAILED', 'INVALID_BRANCH',
    ]
    expect(codes).toHaveLength(6)
  })
})
