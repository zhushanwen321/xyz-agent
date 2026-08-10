import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { buildFamilyFromFs } from '../discovery/subagents.js'

// ---- fixture 常量（uuid 特征，满足 extractSessionIdFromFilename + 互不为子串）----
const ROOT = '0aaaaaaa-bbbb-7ccc-dddd-000000000001'
const FORK = '0aaaaaaa-bbbb-7ccc-dddd-000000000002'
const SUB_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000003'

/** 真实 pi agent 目录（本机），用于集成测试。 */
const REAL_AGENT_DIR = '/Users/zhushanwen/.pi/agent'

// 同步探测真实 session 是否存在（不存在则 skip，避免在无该数据的机器上硬失败）
function hasRealSession(sid: string): boolean {
  try {
    return (
      execSync(
        `find ${REAL_AGENT_DIR}/sessions -name '*${sid}*' -name '*.jsonl' ! -name '*.finalized' 2>/dev/null | head -1`,
        { encoding: 'utf8' },
      ).trim().length > 0
    )
  } catch {
    return false
  }
}
const HAS_REAL_ROOT = hasRealSession('019fe620-8ae1-78a7-b76a-43a1ba4cc3c7')
const HAS_REAL_WF = hasRealSession('019fdcda-75c7-74b7-a160-f67f6bf88384')

// ---- fixture helpers ----

async function makeAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'subagents-test-'))
}

/** 写主 session 文件（首行 header）。返回绝对路径（供 fork 的 parentSession 指向）。 */
async function writeMainSession(
  dir: string,
  slug: string,
  id: string,
  opts?: { cwd?: string; parentSession?: string },
): Promise<string> {
  const sessionDir = join(dir, 'sessions', slug)
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${id}.jsonl`)
  const header: Record<string, unknown> = { type: 'session', id, cwd: opts?.cwd ?? `/proj/${slug}` }
  if (opts?.parentSession) header.parentSession = opts.parentSession
  await writeFile(path, JSON.stringify(header) + '\n')
  return path
}

/**
 * 写 subagent session 文件：首行 header（真实 id）+ 占位 message + 尾行 identity。
 * identity 在尾行（实测 pi 行为；subagent-identity 由 session-runner 在 session 创建后写）。
 */
async function writeSubagentSession(
  dir: string,
  slug: string,
  realId: string,
  identity: { rootSessionId: string; slug: string; dataId?: string },
): Promise<string> {
  const sessionDir = join(dir, 'subagents', slug, 'sessions')
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${realId}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', id: realId, cwd: `/proj/${slug}` }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: realId,
      message: { role: 'user', content: 'do work' },
    }),
    JSON.stringify({
      type: 'custom',
      customType: 'subagent-identity',
      data: {
        id: identity.dataId ?? `sa-${realId.slice(0, 8)}`,
        rootSessionId: identity.rootSessionId,
        slug: identity.slug,
        agent: 'explorer',
        mode: 'sync',
        task: 't',
        startedAt: 1,
      },
    }),
  ]
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** 写 records manifest（孤儿源）。 */
async function writeRecordManifest(
  dir: string,
  slug: string,
  id: string,
  fields: { rootSessionId: string; agentName?: string; sessionFile: string },
): Promise<void> {
  const recordsDir = join(dir, 'subagents', slug, 'records')
  await mkdir(recordsDir, { recursive: true })
  await writeFile(join(recordsDir, `${id}.json`), JSON.stringify({ id, ...fields }))
}

// ============================================================
// fixture 测试
// ============================================================

describe('buildFamilyFromFs - fixture', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeAgentDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('基础 family：root + fork + 隔代 subagent，SubagentRef.sessionId 是真实 id（非 sa-xxx）', async () => {
    const rootPath = await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // fork 在不同 cwd slug（模拟跨 cwd fork）
    await writeMainSession(dir, '--fork-cwd--', FORK, {
      cwd: '/proj/fork',
      parentSession: rootPath,
    })
    // subagent 挂在 fork 子代下（rootSessionId=FORK，非 ROOT）→ 隔代
    await writeSubagentSession(dir, '--fork-cwd--', SUB_REAL, {
      rootSessionId: FORK,
      slug: 'test-sub',
      dataId: 'sa-placeholder-1',
    })

    const family = await buildFamilyFromFs(ROOT, dir)

    expect(family.root.sessionId).toBe(ROOT)
    // fork：parentSession 含 ROOT id → childrenOf[ROOT] = [FORK]
    expect(family.forks.some((f) => f.sessionId === FORK)).toBe(true)
    // Q1 隔代：subagent rootSessionId=FORK（fork 子代），从 ROOT resolve 能关联
    const sub = family.subagents.find((s) => s.sessionId === SUB_REAL)
    expect(sub).toBeDefined()
    // id 修正核心断言：sessionId 是 subagent 文件首行 header.id（真实），非 identity.data.id 的 sa-xxx
    expect(sub!.sessionId).toBe(SUB_REAL)
    expect(sub!.sessionId.startsWith('sa-')).toBe(false)
    expect(sub!.rootSessionId).toBe(FORK)
    expect(sub!.slug).toBe('test-sub')
    expect(sub!.cleanedUp).toBe(false)
    // enrich：fileName/cwd 已补真实值（非 M1 占位空串）
    expect(sub!.fileName.length).toBeGreaterThan(0)
    expect(sub!.cwd).toBe('/proj/--fork-cwd--')
  })

  it('从 fork 子代 resolve 也能关联到挂在其下的 subagent', async () => {
    const rootPath = await writeMainSession(dir, '--root-cwd--', ROOT)
    await writeMainSession(dir, '--fork-cwd--', FORK, { parentSession: rootPath })
    await writeSubagentSession(dir, '--fork-cwd--', SUB_REAL, { rootSessionId: FORK, slug: 's' })

    const family = await buildFamilyFromFs(FORK, dir)
    expect(family.subagents.some((s) => s.sessionId === SUB_REAL)).toBe(true)
  })

  it('cleanedUp：manifest 孤儿（.jsonl 不存在）→ cleanedUp=true', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // 孤儿 manifest：rootSessionId=ROOT，sessionFile 指向不存在路径（模拟 .jsonl 被 GC）
    await writeRecordManifest(dir, '--root-cwd--', 'sa-ghost-id', {
      rootSessionId: ROOT,
      agentName: 'explorer',
      sessionFile: '/nonexistent/ghost.jsonl',
    })

    const family = await buildFamilyFromFs(ROOT, dir)

    const ghost = family.subagents.find((s) => s.sessionId === 'sa-ghost-id')
    expect(ghost).toBeDefined()
    expect(ghost!.cleanedUp).toBe(true)
    expect(ghost!.rootSessionId).toBe(ROOT)
    // 孤儿无文件 → mtime/size 占位 0
    expect(ghost!.mtime).toBe(0)
    expect(ghost!.sizeBytes).toBe(0)
  })

  it('alive subagent 同时有 manifest → 不重复计数（manifest 跳过 alive）', async () => {
    const rootPath = await writeMainSession(dir, '--root-cwd--', ROOT)
    await writeMainSession(dir, '--fork-cwd--', FORK, { parentSession: rootPath })
    const subPath = await writeSubagentSession(dir, '--fork-cwd--', SUB_REAL, {
      rootSessionId: FORK,
      slug: 'dup-test',
    })
    // manifest 指向真实文件路径（alive）→ 应被跳过，不产生孤儿副本
    await writeRecordManifest(dir, '--fork-cwd--', `sa-${SUB_REAL}`, {
      rootSessionId: FORK,
      agentName: 'explorer',
      sessionFile: subPath,
    })

    const family = await buildFamilyFromFs(ROOT, dir)
    // 只有一个 SUB_REAL（真实 id），无 sa- 副本
    const realOnes = family.subagents.filter((s) => s.sessionId === SUB_REAL)
    expect(realOnes).toHaveLength(1)
    expect(realOnes[0].cleanedUp).toBe(false)
    const orphans = family.subagents.filter((s) => s.sessionId.startsWith('sa-'))
    expect(orphans).toHaveLength(0)
  })

  it('sessionId 不在任意 main header → 抛 Error', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    await expect(buildFamilyFromFs('nonexistent-session-id', dir)).rejects.toThrow(/not found/)
  })
})

// ============================================================
// 真实数据集成测试（~/.pi/agent）
// ============================================================

describe.skipIf(!HAS_REAL_ROOT)('buildFamilyFromFs - 真实数据 ~/.pi/agent', () => {
  it('019fe620 family：fork 019fe632（跨 cwd）+ 隔代 subagent 019fe635（真实 id）', async () => {
    const family = await buildFamilyFromFs(
      '019fe620-8ae1-78a7-b76a-43a1ba4cc3c7',
      REAL_AGENT_DIR,
    )
    // fork 019fe632（cwd feat-optimize-todo-goal，与 root 的 fix-cw-tool-wroktree 不同）
    const fork = family.forks.find((f) => f.sessionId.startsWith('019fe632'))
    expect(fork).toBeDefined()
    // 隔代 subagent：rootSessionId=019fe632（fork 子代），sessionId 真实（019fe635 开头，非 sa-）
    const sub = family.subagents.find(
      (s) => s.rootSessionId.startsWith('019fe632') && s.sessionId.startsWith('019fe635'),
    )
    expect(sub).toBeDefined()
    expect(sub!.sessionId.startsWith('sa-')).toBe(false)
  }, 30000)
})

describe.skipIf(!HAS_REAL_WF)('buildFamilyFromFs - 真实 workflow 数据', () => {
  it('019fdcda：workflows 非空，至少一个 workflow calls>=4', async () => {
    const family = await buildFamilyFromFs(
      '019fdcda-75c7-74b7-a160-f67f6bf88384',
      REAL_AGENT_DIR,
    )
    expect(family.workflows.length).toBeGreaterThan(0)
    // wf-1786121387659-5voqzc 有 4 个 agent() calls（sessionFile 持久化）
    const rich = family.workflows.find((w) => w.calls.length >= 4)
    expect(rich).toBeDefined()
    // calls 的 sessionFile 路径已落入 fileName（sessionRefFromPath）
    expect(rich!.calls.every((c) => c.fileName.length > 0)).toBe(true)
    // stateFile 是 wf-state 文件绝对路径
    expect(rich!.stateFile.endsWith('.jsonl')).toBe(true)
    expect(rich!.runId.startsWith('wf-')).toBe(true)
  }, 30000)
})
