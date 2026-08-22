import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildExecutionTree, formatExecutionTreeText, type ExecutionTreeNode } from '../core/execution-tree.js'

/**
 * M3b U7 buildExecutionTree 单测（design m3b 6 testCases）。
 *
 * 测试框架 vitest（禁止 node:test/tsx）。fixture 自包含（mkdtemp 临时目录），复用
 * subagents.test.ts 验证过的 fixture 拓扑（main session + subagent session + records manifest
 * + workflow-state 文件 + workflow-state-link）。
 *
 * 覆盖：
 * - TC-m3b-nested-tree：任意深度 subagent↔workflow-call 相互嵌套（parentRecordId 精确链）
 * - TC-m3b-flat-fallback：旧机制扁平回退（全无 parentRecordId）
 * - TC-m3b-cycle-detection：workflow 指针环（A→B→A），visited Set 防环
 * - TC-m3b-single-node：单节点树（无后代，ES5）
 * - TC-m3b-source-priority：parentRecordId 三级数据源优先级（manifest>identity>flat，DM4）
 * - TC-m3b-real-data-guard：本机真实数据 flat 回退（旧机制，skipIf CI 无数据）
 */

// ---- fixture 常量（uuid 特征，互不为子串，满足 extractSessionIdFromFilename）----
const MAIN = '0aaaaaaa-bbbb-7ccc-dddd-000000000001'
const A_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000002'
const B_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000003'
const C_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000004'
const D_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000005'
const X_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000006'
// workflow-state-link runId
const RUN_A = 'wf-1786121304924-runA'
const RUN_B = 'wf-1786121304924-runB'

/** 真实 pi agent 目录（本机），用于集成测试守卫。 */
const REAL_AGENT_DIR = '/Users/zhushanwen/.pi/agent'
const HAS_REAL = (() => {
  try {
    return (
      execSync(`find ${REAL_AGENT_DIR}/sessions -maxdepth 1 -type d 2>/dev/null | head -1`, {
        encoding: 'utf8',
      }).trim().length > 0
    )
  } catch {
    return false
  }
})()

// ---- fixture helpers（自包含，拓扑同 subagents.test.ts）----

async function makeAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'exec-tree-test-'))
}

/** 写 main session 文件（首行 header）。 */
async function writeMainSession(dir: string, slug: string, id: string): Promise<string> {
  const sessionDir = join(dir, 'sessions', slug)
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${id}.jsonl`)
  await writeFile(path, JSON.stringify({ type: 'session', id, cwd: `/proj/${slug}` }) + '\n')
  return path
}

/**
 * 写 subagent session 文件：首行 header（真实 id）+ 占位 message + 尾行 identity。
 * identity 尾行含 rootSessionId/slug/agent，可选 parentRecordId（数据源 ② 测试用）。
 */
async function writeSubagentSession(
  dir: string,
  slug: string,
  realId: string,
  identity: {
    rootSessionId: string
    slug: string
    agent?: string
    parentRecordId?: string
    task?: string
  },
): Promise<string> {
  const sessionDir = join(dir, 'subagents', slug, 'sessions')
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${realId}.jsonl`)
  const data: Record<string, unknown> = {
    id: `sa-${realId.slice(0, 8)}`,
    rootSessionId: identity.rootSessionId,
    slug: identity.slug,
    agent: identity.agent ?? 'explorer',
    mode: 'sync',
    task: identity.task ?? 'do work',
    startedAt: 1,
  }
  if (identity.parentRecordId !== undefined) data.parentRecordId = identity.parentRecordId
  const lines = [
    JSON.stringify({ type: 'session', id: realId, cwd: `/proj/${slug}` }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: realId,
      message: { role: 'user', content: 'do work' },
    }),
    JSON.stringify({ type: 'custom', customType: 'subagent-identity', data }),
  ]
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** 写 records manifest。fields 含必填 + 可选 parentRecordId（数据源 ①）。 */
async function writeRecordManifest(
  dir: string,
  slug: string,
  id: string,
  fields: {
    rootSessionId: string
    agentName?: string
    sessionFile: string
    task?: string
    slug?: string
    model?: string
    status?: string
    parentRecordId?: string
  },
): Promise<void> {
  const recordsDir = join(dir, 'subagents', slug, 'records')
  await mkdir(recordsDir, { recursive: true })
  await writeFile(join(recordsDir, `${id}.json`), JSON.stringify({ id, ...fields }))
}

/** 写 wf-state 文件（NEW 格式 v=wf-run-v1，calls[].sessionFile）。返回绝对路径。 */
async function writeWfState(
  dir: string,
  slug: string,
  runId: string,
  callSessionFiles: string[],
): Promise<string> {
  const wfDir = join(dir, 'sessions', slug, 'workflow-state')
  await mkdir(wfDir, { recursive: true })
  const path = join(wfDir, `${runId}.jsonl`)
  const snap = JSON.stringify({
    v: 'wf-run-v1',
    runId,
    state: {
      status: 'done',
      calls: callSessionFiles.map((sf, i) => ({ id: i, status: 'done', sessionFile: sf })),
    },
  })
  await writeFile(path, snap + '\n')
  return path
}

/** 向 session 文件追加 workflow-state-link custom entry。 */
async function writeWfLink(
  sessionPath: string,
  sessionId: string,
  link: { runId: string; path: string },
): Promise<void> {
  const line = JSON.stringify({
    type: 'custom',
    id: `wf-link-${link.runId}`,
    parentId: sessionId,
    customType: 'workflow-state-link',
    data: { runId: link.runId, path: link.path, updatedAt: '2026-08-07T16:48:24.933Z' },
  })
  await writeFile(sessionPath, line + '\n', { flag: 'a' })
}

/** 在节点树里按 type+sessionId 查找节点（DFS）。 */
function findNode(
  node: ExecutionTreeNode,
  type: string,
  sidPrefix: string,
): ExecutionTreeNode | undefined {
  if (node.type === type && node.sessionId.startsWith(sidPrefix)) return node
  for (const c of node.children) {
    const found = findNode(c, type, sidPrefix)
    if (found) return found
  }
  return undefined
}

// ============================================================
// fixture 用例
// ============================================================

describe('buildExecutionTree - fixture', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeAgentDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('TC-m3b-nested-tree：main→subagent A→{workflow-call B, subagent C} 相互嵌套（parentRecordId 精确链）', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)
    // subagent A（顶层，parentRecordId=undefined），sessionFile 含 workflow-state-link → call session B
    const saA = await writeSubagentSession(dir, '--main-cwd--', A_REAL, {
      rootSessionId: MAIN,
      slug: 'sub-a',
    })
    const recAId = 'sa-record-A'
    await writeRecordManifest(dir, '--main-cwd--', recAId, {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saA,
      status: 'completed',
      parentRecordId: undefined,
    })
    // subagent C（A 的后代，parentRecordId=recAId，精确链）
    const saC = await writeSubagentSession(dir, '--main-cwd--', C_REAL, {
      rootSessionId: MAIN,
      slug: 'sub-c',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-record-C', {
      rootSessionId: MAIN,
      agentName: 'worker',
      sessionFile: saC,
      status: 'completed',
      parentRecordId: recAId,
    })
    // workflow-call B：A 的 sessionFile 的 workflow-state-link → wf-state → calls[].sessionFile = SB
    const sbB = join(
      dir,
      'subagents',
      '--main-cwd--',
      'sessions',
      `2026-08-07T16-49-48-393Z_${B_REAL}.jsonl`,
    )
    // B call session 文件需存在（resolveWorkflows 读 call sessionFile；这里只需路径，不读内容建树）
    await mkdir(join(dir, 'subagents', '--main-cwd--', 'sessions'), { recursive: true })
    await writeFile(sbB, JSON.stringify({ type: 'session', id: B_REAL, cwd: '/proj/wf' }) + '\n')
    const wfPath = await writeWfState(dir, '--main-cwd--', RUN_A, [sbB])
    await writeWfLink(saA, A_REAL, { runId: RUN_A, path: wfPath })

    const tree = await buildExecutionTree(MAIN, dir)

    // 根节点
    expect(tree.root.type).toBe('main')
    expect(tree.root.sessionId).toBe(MAIN)
    // root.children 含 A（subagent）
    const nodeA = findNode(tree.root, 'subagent', A_REAL)
    expect(nodeA).toBeDefined()
    expect(tree.root.children.some((c) => c === nodeA)).toBe(true)
    // A.children 含 B（workflow-call，runId/stateFile）
    const nodeB = findNode(tree.root, 'workflow-call', B_REAL)
    expect(nodeB).toBeDefined()
    expect(nodeA!.children.some((c) => c === nodeB)).toBe(true)
    expect(nodeB!.runId).toBe(RUN_A)
    // A.children 含 C（subagent，parentRecordId=recAId，严格 parentRecordId 链挂 A 下）
    const nodeC = findNode(tree.root, 'subagent', C_REAL)
    expect(nodeC).toBeDefined()
    expect(nodeA!.children.some((c) => c === nodeC)).toBe(true)
    expect(nodeC!.parentRecordId).toBe(recAId)
    // 树规模与精度
    expect(tree.totalNodes).toBe(4) // main + A + B + C
    expect(tree.maxDepth).toBe(2) // root=0, A=1, B/C=2
    expect(tree.sourceMode).toBe('precise')
    expect(tree.truncated).toBe(false)
  })

  it('TC-m3b-flat-fallback：旧机制全无 parentRecordId → 全挂 main（扁平）+ flat-fallback', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)
    // 3 个顶层 subagent，全无 parentRecordId（旧机制）
    const saA = await writeSubagentSession(dir, '--main-cwd--', A_REAL, {
      rootSessionId: MAIN,
      slug: 'a',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-A', {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saA,
    })
    const saB = await writeSubagentSession(dir, '--main-cwd--', B_REAL, {
      rootSessionId: MAIN,
      slug: 'b',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-B', {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saB,
    })
    const saC = await writeSubagentSession(dir, '--main-cwd--', C_REAL, {
      rootSessionId: MAIN,
      slug: 'c',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-C', {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saC,
    })

    const tree = await buildExecutionTree(MAIN, dir)

    // 全挂 main（flat）
    expect(tree.root.children).toHaveLength(3)
    expect(tree.root.children.every((c) => c.type === 'subagent')).toBe(true)
    // 不丢弃任何 record
    expect(tree.totalNodes).toBe(4) // main + 3 subagent
    expect(tree.sourceMode).toBe('flat-fallback')
    expect(tree.truncated).toBe(false)
  })

  it('TC-m3b-cycle-detection：workflow 指针环 A→B→A，visited Set 防环 + truncated', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)
    // A（顶层），A 的 workflow call → SB
    const saA = await writeSubagentSession(dir, '--main-cwd--', A_REAL, {
      rootSessionId: MAIN,
      slug: 'a',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-A', {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saA,
    })
    // B（顶层），B 的 workflow call → SA（指回 A，成环）
    const saB = await writeSubagentSession(dir, '--main-cwd--', B_REAL, {
      rootSessionId: MAIN,
      slug: 'b',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-B', {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saB,
    })
    const wfA = await writeWfState(dir, '--main-cwd--', RUN_A, [saB])
    const wfB = await writeWfState(dir, '--main-cwd--', RUN_B, [saA])
    await writeWfLink(saA, A_REAL, { runId: RUN_A, path: wfA })
    await writeWfLink(saB, B_REAL, { runId: RUN_B, path: wfB })

    const tree = await buildExecutionTree(MAIN, dir)

    // 环检测：truncated=true，不抛错
    expect(tree.truncated).toBe(true)
    // root.children 含 A, B（正常分支继续建树）
    expect(tree.root.children).toHaveLength(2)
    // A 下有 workflow-call 指向 B session；B 的 workflow 指回 A 被 visited 跳过（不无限递归）
    const nodeA = findNode(tree.root, 'subagent', A_REAL)
    expect(nodeA).toBeDefined()
    // A 至少展开了 workflow-call（B session 的 call）
    expect(nodeA!.children.some((c) => c.type === 'workflow-call')).toBe(true)
  })

  it('TC-m3b-single-node：无 subagent record、无 workflow → 单节点树（ES5）', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)

    const tree = await buildExecutionTree(MAIN, dir)

    expect(tree.root.type).toBe('main')
    expect(tree.root.sessionId).toBe(MAIN)
    expect(tree.root.children).toEqual([])
    expect(tree.totalNodes).toBe(1)
    expect(tree.maxDepth).toBe(0)
    expect(tree.sourceMode).toBe('precise') // 无 record → 确定无后代（非回退），ES5
    expect(tree.truncated).toBe(false)
  })

  it('TC-m3b-source-priority：parentRecordId 三级数据源 manifest>identity>flat（DM4）', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)
    // X：顶层 subagent（挂 main）
    const saX = await writeSubagentSession(dir, '--main-cwd--', A_REAL, {
      rootSessionId: MAIN,
      slug: 'x',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-X', {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saX,
    })
    // Y：manifest.parentRecordId=sa-X（数据源 ①，精确挂 X）
    const saY = await writeSubagentSession(dir, '--main-cwd--', B_REAL, {
      rootSessionId: MAIN,
      slug: 'y',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-Y', {
      rootSessionId: MAIN,
      agentName: 'worker',
      sessionFile: saY,
      parentRecordId: 'sa-X',
    })
    // Z：manifest 无 parentRecordId，但 identity.data.parentRecordId=sa-X（数据源 ②，精确挂 X）
    const saZ = await writeSubagentSession(dir, '--main-cwd--', C_REAL, {
      rootSessionId: MAIN,
      slug: 'z',
      parentRecordId: 'sa-X', // 写入 identity.data.parentRecordId
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-Z', {
      rootSessionId: MAIN,
      agentName: 'worker',
      sessionFile: saZ,
      // manifest 无 parentRecordId → 走 ② identity
    })
    // W：manifest + identity 都无 parentRecordId（数据源 ③，flat 挂 main）
    const saW = await writeSubagentSession(dir, '--main-cwd--', '000000000005', {
      rootSessionId: MAIN,
      slug: 'w',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-W', {
      rootSessionId: MAIN,
      agentName: 'worker',
      sessionFile: saW,
    })

    const tree = await buildExecutionTree(MAIN, dir)

    // sourceMode=precise（Y/Z 有精确链）
    expect(tree.sourceMode).toBe('precise')
    // X 挂 main（顶层）
    const nodeX = findNode(tree.root, 'subagent', A_REAL)
    expect(nodeX).toBeDefined()
    expect(tree.root.children.some((c) => c === nodeX)).toBe(true)
    // Y 挂 X（manifest.parentRecordId=sa-X，①）
    const nodeY = findNode(tree.root, 'subagent', B_REAL)
    expect(nodeY).toBeDefined()
    expect(nodeX!.children.some((c) => c === nodeY)).toBe(true)
    expect(nodeY!.parentRecordId).toBe('sa-X')
    // Z 挂 X（identity.data.parentRecordId=sa-X，②）
    const nodeZ = findNode(tree.root, 'subagent', C_REAL)
    expect(nodeZ).toBeDefined()
    expect(nodeX!.children.some((c) => c === nodeZ)).toBe(true)
    expect(nodeZ!.parentRecordId).toBe('sa-X')
    // W 挂 main（flat，③）
    const nodeW = findNode(tree.root, 'subagent', '000000000005')
    expect(nodeW).toBeDefined()
    expect(tree.root.children.some((c) => c === nodeW)).toBe(true)
    expect(nodeW!.parentRecordId).toBeUndefined()
  })

  it('TC-m3b-mf1-dedup：call session 有 manifest（parentRecordId 链 + wf 指针双命中）只出现一次（MF-1）', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)
    // A（顶层，parentRecordId=undefined），sessionFile 含 workflow-state-link → call session B
    const saA = await writeSubagentSession(dir, '--main-cwd--', A_REAL, {
      rootSessionId: MAIN,
      slug: 'sub-a',
    })
    const recAId = 'sa-record-A'
    await writeRecordManifest(dir, '--main-cwd--', recAId, {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saA,
      status: 'completed',
      parentRecordId: undefined,
    })
    // B：A 的 subagent 后代（parentRecordId=recA）+ A 的 workflow call 目标（双命中，MF-1 场景）
    const sbB = join(
      dir,
      'subagents',
      '--main-cwd--',
      'sessions',
      `2026-08-07T16-49-48-393Z_${B_REAL}.jsonl`,
    )
    await mkdir(join(dir, 'subagents', '--main-cwd--', 'sessions'), { recursive: true })
    await writeFile(sbB, JSON.stringify({ type: 'session', id: B_REAL, cwd: '/proj/wf' }) + '\n')
    const recBId = 'sa-record-B'
    await writeRecordManifest(dir, '--main-cwd--', recBId, {
      rootSessionId: MAIN,
      agentName: 'worker',
      sessionFile: sbB,
      status: 'completed',
      parentRecordId: recAId,
    })
    // D：B 的 subagent 后代（验证 call session 内派生的嵌套 sub-subagent 仍正确挂到 B 下）
    const saD = await writeSubagentSession(dir, '--main-cwd--', D_REAL, {
      rootSessionId: MAIN,
      slug: 'sub-d',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-record-D', {
      rootSessionId: MAIN,
      agentName: 'worker',
      sessionFile: saD,
      status: 'completed',
      parentRecordId: recBId,
    })
    // A 的 workflow-state-link → wf-state → calls[0].sessionFile = sbB
    const wfPath = await writeWfState(dir, '--main-cwd--', RUN_A, [sbB])
    await writeWfLink(saA, A_REAL, { runId: RUN_A, path: wfPath })

    const tree = await buildExecutionTree(MAIN, dir)

    // B 作为 subagent 出现一次（parentRecordId 链命中）
    const nodeBSub = findNode(tree.root, 'subagent', B_REAL)
    expect(nodeBSub).toBeDefined()
    expect(nodeBSub!.parentRecordId).toBe(recAId)
    // B 不作为 workflow-call 重复出现（MF-1 dedup）
    const nodeBWf = findNode(tree.root, 'workflow-call', B_REAL)
    expect(nodeBWf).toBeUndefined()
    // B 挂在 A 下；A 下不应有指向 B 的 workflow-call
    const nodeA = findNode(tree.root, 'subagent', A_REAL)
    expect(nodeA).toBeDefined()
    expect(nodeA!.children.some((c) => c === nodeBSub)).toBe(true)
    expect(
      nodeA!.children.some((c) => c.type === 'workflow-call' && c.sessionId === B_REAL),
    ).toBe(false)
    // B 的嵌套后代 D 仍挂在 B 下（caution：call 节点内派生的 sub-subagent 不丢失）
    const nodeD = findNode(tree.root, 'subagent', D_REAL)
    expect(nodeD).toBeDefined()
    expect(nodeBSub!.children.some((c) => c === nodeD)).toBe(true)
    // 树规模：main + A + B + D = 4（B 不重复计数）
    expect(tree.totalNodes).toBe(4)
    expect(tree.truncated).toBe(false)
  })

  it('TC-m3b-mf2-subtree：buildExecutionTree(subagentId) 切该 subagent 子树（MF-2，§5.5）', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)
    // A（顶层）+ X（顶层，A 的兄弟，不应进 A 的子树）
    const saA = await writeSubagentSession(dir, '--main-cwd--', A_REAL, {
      rootSessionId: MAIN,
      slug: 'sub-a',
    })
    const recAId = 'sa-record-A'
    await writeRecordManifest(dir, '--main-cwd--', recAId, {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saA,
      status: 'completed',
      parentRecordId: undefined,
    })
    const saX = await writeSubagentSession(dir, '--main-cwd--', X_REAL, {
      rootSessionId: MAIN,
      slug: 'sub-x',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-record-X', {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saX,
      status: 'completed',
      parentRecordId: undefined,
    })
    // B（A 的后代），C（B 的后代）
    const saB = await writeSubagentSession(dir, '--main-cwd--', B_REAL, {
      rootSessionId: MAIN,
      slug: 'sub-b',
    })
    const recBId = 'sa-record-B'
    await writeRecordManifest(dir, '--main-cwd--', recBId, {
      rootSessionId: MAIN,
      agentName: 'worker',
      sessionFile: saB,
      status: 'completed',
      parentRecordId: recAId,
    })
    const saC = await writeSubagentSession(dir, '--main-cwd--', C_REAL, {
      rootSessionId: MAIN,
      slug: 'sub-c',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-record-C', {
      rootSessionId: MAIN,
      agentName: 'worker',
      sessionFile: saC,
      status: 'completed',
      parentRecordId: recBId,
    })

    // 切 A 的子树（subagent root）
    const tree = await buildExecutionTree(A_REAL, dir)

    // root 是 A（subagent 节点，携带 manifest 元数据）
    expect(tree.root.type).toBe('subagent')
    expect(tree.root.sessionId).toBe(A_REAL)
    expect(tree.root.agentName).toBe('explorer')
    // A 的子树含 B→C，不含兄弟 X
    const nodeB = findNode(tree.root, 'subagent', B_REAL)
    expect(nodeB).toBeDefined()
    expect(tree.root.children.some((c) => c === nodeB)).toBe(true)
    const nodeC = findNode(tree.root, 'subagent', C_REAL)
    expect(nodeC).toBeDefined()
    expect(nodeB!.children.some((c) => c === nodeC)).toBe(true)
    // 兄弟 X 不在 A 的子树
    const nodeX = findNode(tree.root, 'subagent', X_REAL)
    expect(nodeX).toBeUndefined()
    // 树规模：A + B + C = 3
    expect(tree.totalNodes).toBe(3)
    expect(tree.sourceMode).toBe('precise')
    expect(tree.truncated).toBe(false)
  })

  it('TC-m3b-mf1-main-root：main root 填 sessionFile 后 main 自身发起的 workflow run 入树（MF-1）', async () => {
    const mainPath = await writeMainSession(dir, '--main-cwd--', MAIN)
    // main 的 workflow-state-link → wf-state → call session B
    const sbB = join(
      dir,
      'subagents',
      '--main-cwd--',
      'sessions',
      `2026-08-07T16-49-48-393Z_${B_REAL}.jsonl`,
    )
    await mkdir(join(dir, 'subagents', '--main-cwd--', 'sessions'), { recursive: true })
    await writeFile(sbB, JSON.stringify({ type: 'session', id: B_REAL, cwd: '/proj/wf' }) + '\n')
    const wfPath = await writeWfState(dir, '--main-cwd--', RUN_A, [sbB])
    await writeWfLink(mainPath, MAIN, { runId: RUN_A, path: wfPath })

    const tree = await buildExecutionTree(MAIN, dir, mainPath)

    // main root 携带 sessionFile，workflow-state-link 被读取 → wf-call 子节点入树
    expect(tree.root.type).toBe('main')
    expect(tree.root.sessionFile).toBe(mainPath)
    const nodeB = findNode(tree.root, 'workflow-call', B_REAL)
    expect(nodeB).toBeDefined()
    expect(tree.root.children.some((c) => c === nodeB)).toBe(true)
    expect(nodeB!.runId).toBe(RUN_A)
    expect(tree.totalNodes).toBe(2) // main + wf-call B
    expect(tree.maxDepth).toBe(1)
    expect(tree.truncated).toBe(false)

    // 差分守卫：不传 mainSessionFile（旧行为）→ main root 无 sessionFile → workflow run 不可达
    const tree2 = await buildExecutionTree(MAIN, dir)
    expect(tree2.root.sessionFile).toBeUndefined()
    expect(tree2.totalNodes).toBe(1)
  })

  it('TC-m3b-max-depth：21+ 层 parentRecordId 链在 MAX_DEPTH(20) 截断，truncated=true 不抛错（MF-4）', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)
    // 循环生成 25 层链：R1 顶层（parentRecordId=undefined），R(i+1).parentRecordId=Ri.id
    // 深度计数：root=0，R1=1，…，R20=20（attachSubagentChildren 在 node.depth>=20 截断，R21+ 不挂）
    const CHAIN_RECORDS = 25
    // 链 id 用独立前缀（0bbbbb…，与 MAIN 的 0aaaa… 不撞——否则 sidOf(1)===MAIN 会被
    // rootManifest 探测误判为 subagent root，深度计数整体偏移 1）
    const sidOf = (n: number): string =>
      `0bbbbbbb-cccc-7ddd-eeee-0000000000${String(n).padStart(2, '0')}`
    const recIdOf = (n: number): string => `sa-chain-${String(n).padStart(2, '0')}`
    let prevRecId: string | undefined
    for (let i = 1; i <= CHAIN_RECORDS; i++) {
      const saPath = await writeSubagentSession(dir, '--main-cwd--', sidOf(i), {
        rootSessionId: MAIN,
        slug: `chain-${i}`,
      })
      await writeRecordManifest(dir, '--main-cwd--', recIdOf(i), {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saPath,
        parentRecordId: prevRecId,
      })
      prevRecId = recIdOf(i)
    }

    const tree = await buildExecutionTree(MAIN, dir)

    // 深度截断契约：MAX_DEPTH=20 → main + 20 层 subagent = 21 节点，R21+ 被截断
    expect(tree.truncated).toBe(true)
    expect(tree.maxDepth).toBe(20)
    expect(tree.totalNodes).toBe(21)
    // R20 是最后挂载的节点，其下无后代（R21 被截断）
    const deepest = findNode(tree.root, 'subagent', sidOf(20))
    expect(deepest).toBeDefined()
    expect(deepest!.children).toEqual([])
    // R21 不在树中
    expect(findNode(tree.root, 'subagent', sidOf(21))).toBeUndefined()
    expect(tree.root.children).toHaveLength(1)
    expect(tree.sourceMode).toBe('precise')
  })

  it('TC-m3b-bfs-spread：旧机制嵌套形态 rootSessionId=父 session id，BFS 扩散收集不丢 record（MF-5）', async () => {
    await writeMainSession(dir, '--main-cwd--', MAIN)
    // A：顶层（rootSessionId=MAIN，无 parentRecordId——旧机制）
    const saA = await writeSubagentSession(dir, '--main-cwd--', A_REAL, {
      rootSessionId: MAIN,
      slug: 'a',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-A', {
      rootSessionId: MAIN,
      agentName: 'explorer',
      sessionFile: saA,
    })
    // B：旧机制嵌套形态——rootSessionId=A 的 session id（非 MAIN），A 无 manifest.parentRecordId
    const saB = await writeSubagentSession(dir, '--main-cwd--', B_REAL, {
      rootSessionId: A_REAL,
      slug: 'b',
    })
    await writeRecordManifest(dir, '--main-cwd--', 'sa-B', {
      rootSessionId: A_REAL,
      agentName: 'explorer',
      sessionFile: saB,
    })

    const tree = await buildExecutionTree(MAIN, dir)

    // BFS 扩散：queue 从 MAIN → A 的 session id 入队 → 第二轮收 B。B 不被丢弃（ES3）
    expect(tree.totalNodes).toBe(3) // main + A + B
    expect(tree.sourceMode).toBe('flat-fallback')
    const nodeA = findNode(tree.root, 'subagent', A_REAL)
    expect(nodeA).toBeDefined()
    const nodeB = findNode(tree.root, 'subagent', B_REAL)
    expect(nodeB).toBeDefined()
    // 旧机制无 parentRecordId → B 与 A 都 flat 挂 main（flat-fallback 语义）
    expect(tree.root.children.some((c) => c === nodeA)).toBe(true)
    expect(tree.root.children.some((c) => c === nodeB)).toBe(true)
    expect(tree.truncated).toBe(false)
  })
})

// ============================================================
// 真实数据守卫（CI 无本机 ~/.pi/agent → skip）
// ============================================================

describe.skipIf(!HAS_REAL)('buildExecutionTree - 真实数据守卫', () => {
  it('TC-m3b-real-data-guard：本机旧机制数据 flat 回退，不抛错，totalNodes>1', async () => {
    // 取一个真实存在的 main session（FAM 是 fork 家族根）
    const FAM = '019fe620-8ae1-78a7-b76a-43a1ba4cc3c7'
    const tree = await buildExecutionTree(FAM, REAL_AGENT_DIR)
    // 旧机制：sourceMode='flat-fallback'（全无 parentRecordId）
    expect(tree.sourceMode).toBe('flat-fallback')
    // 有 subagent 后代（本机 3610 record，FAM 树非空）
    expect(tree.totalNodes).toBeGreaterThan(1)
    // 不抛错（已隐含：到这行说明成功）
    expect(tree.root.type).toBe('main')
    expect(tree.root.sessionId).toBe(FAM)
  }, 60000)
})

// ============================================================
// formatExecutionTreeText 渲染（IF5）
// ============================================================

describe('formatExecutionTreeText', () => {
  it('渲染头部摘要 + 树形 + 尾部 👉 指引', () => {
    const tree = {
      root: {
        type: 'main' as const,
        sessionId: MAIN,
        depth: 0,
        rootSessionId: MAIN,
        children: [
          {
            type: 'subagent' as const,
            sessionId: A_REAL,
            depth: 1,
            rootSessionId: MAIN,
            status: 'completed',
            slug: 'sub-a',
            task: 'do something',
            children: [],
          },
        ],
      },
      totalNodes: 2,
      maxDepth: 1,
      truncated: false,
      sourceMode: 'precise' as const,
    }
    const text = formatExecutionTreeText(tree)
    // 头部摘要
    expect(text).toContain('2 node(s)')
    expect(text).toContain('maxDepth 1')
    expect(text).toContain('precise')
    // 树形：type + sessionId 截断 + status + slug + task
    expect(text).toContain('main')
    expect(text).toContain('subagent')
    expect(text).toContain(A_REAL.slice(0, 8))
    expect(text).toContain('[completed]')
    expect(text).toContain('slug=sub-a')
    expect(text).toContain('do something')
    // 尾部 👉 指引
    expect(text).toContain('👉')
    expect(text).toContain("outline")
  })

  it('flat-fallback 模式注明精度限制', () => {
    const tree = {
      root: {
        type: 'main' as const,
        sessionId: MAIN,
        depth: 0,
        rootSessionId: MAIN,
        children: [],
      },
      totalNodes: 1,
      maxDepth: 0,
      truncated: false,
      sourceMode: 'flat-fallback' as const,
    }
    const text = formatExecutionTreeText(tree)
    expect(text).toContain('flat-fallback')
    expect(text).toContain('旧机制')
  })

  it('truncated 模式标注截断', () => {
    const tree = {
      root: {
        type: 'main' as const,
        sessionId: MAIN,
        depth: 0,
        rootSessionId: MAIN,
        children: [],
      },
      totalNodes: 1,
      maxDepth: 0,
      truncated: true,
      sourceMode: 'precise' as const,
    }
    const text = formatExecutionTreeText(tree)
    expect(text).toContain('truncated')
  })
})
