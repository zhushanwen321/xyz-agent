import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractWorkflowsFromSessionFile } from '../src/services/session/workflow-extractor.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * workflow-extractor 测试。
 *
 * 数据链：主 session JSONL 的 workflow-state-link custom entry →
 * data.path 指向的 workflow-state/<runId>.jsonl（单行 RunSnapshot）→
 * 版本守卫 v==='wf-run-v2'（v1 旧快照跳过，D-5）→ 映射 WorkflowRunRecord。
 *
 * 测试用临时目录模拟主 session JSONL + workflow-state 文件。
 */
describe('extractWorkflowsFromSessionFile', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('正常映射：主 session JSONL 含 workflow-state-link + state 文件含 wf-run-v2 快照（2 个 trace 节点）', () => {
    const stateFilePath = join(tempDir, 'wf-test-001.jsonl')
    const sessionFile = join(tempDir, 'main-session.jsonl')

    // 构造 wf-run-v2 快照（2 个 trace 节点）
    const snapshot = {
      v: 'wf-run-v2',
      runId: 'wf-test-001',
      spec: {
        scriptSource: 'const meta = {};',
        args: {},
        scriptName: 'execute-test-flow',
        scriptPath: '/workflows/test.ts',
        description: 'Test workflow',
      },
      state: {
        status: 'done',
        reason: 'completed',
        budget: {
          usedTokens: 350000,
          usedCost: 0,
          totalCallCount: 2,
        },
        calls: [
          {
            id: 0,
            opts: { prompt: 'task 1' },
            status: 'done',
            attempts: 1,
            sessionId: '019f4b91-e826-7d34-a5ad-4206aa7c5d13',
            traceNode: { stepIndex: 0, agent: 'dev-W1', task: 'task 1', model: 'default', status: 'completed', phase: 'Dev-w0(W1)' },
          },
          {
            id: 1,
            opts: { prompt: 'task 2' },
            status: 'done',
            attempts: 1,
            sessionId: '019f4b9e-0982-7645-8300-55dda1ec20de',
            traceNode: { stepIndex: 1, agent: 'dev-W2', task: 'task 2', model: 'default', status: 'completed', phase: 'Dev-w1(W2)' },
          },
        ],
        trace: [
          {
            stepIndex: 0,
            agent: 'dev-W1',
            task: 'task 1',
            model: 'default',
            status: 'completed',
            phase: 'Dev-w0(W1)',
            startedAt: '2026-07-10T10:28:01.191Z',
            completedAt: '2026-07-10T10:36:01.191Z',
            sessionId: '019f4b91-e826-7d34-a5ad-4206aa7c5d13',
            result: {
              content: 'done',
              usage: { input: 219882, output: 11242, cacheRead: 3302912, cacheWrite: 0, cost: 0, contextTokens: 81936, turns: 52 },
              durationMs: 480000,
              sessionId: '019f4b91-e826-7d34-a5ad-4206aa7c5d13',
            },
          },
          {
            stepIndex: 1,
            agent: 'dev-W2',
            task: 'task 2',
            model: 'default',
            status: 'completed',
            phase: 'Dev-w1(W2)',
            startedAt: '2026-07-10T10:36:01.191Z',
            completedAt: '2026-07-10T10:43:01.191Z',
            sessionId: '019f4b9e-0982-7645-8300-55dda1ec20de',
            result: {
              content: 'done',
              usage: { input: 132370, output: 11882, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50000, turns: 44 },
              durationMs: 420000,
              sessionId: '019f4b9e-0982-7645-8300-55dda1ec20de',
            },
          },
        ],
        errorLogs: [],
      },
      meta: {
        startedAt: '2026-07-10T10:27:59.983Z',
        completedAt: '2026-07-10T11:49:10.618Z',
      },
    }
    writeFileSync(stateFilePath, JSON.stringify(snapshot) + '\n')

    // 主 session JSONL：一条 workflow-state-link 指向 state 文件
    const sessionEntries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:27:00Z' },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-test-001', path: stateFilePath, updatedAt: '2026-07-10T10:28:00Z' },
        timestamp: '2026-07-10T10:28:00Z',
      },
    ]
    writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const result = extractWorkflowsFromSessionFile(sessionFile)

    expect(result).toHaveLength(1)
    const record = result[0]
    expect(record.runId).toBe('wf-test-001')
    expect(record.scriptName).toBe('execute-test-flow')
    expect(record.status).toBe('done')
    expect(record.reason).toBe('completed')
    expect(record.startedAt).toBe('2026-07-10T10:27:59.983Z')
    expect(record.completedAt).toBe('2026-07-10T11:49:10.618Z')
    expect(record.usedTokens).toBe(350000)
    expect(record.totalCallCount).toBe(2)
    expect(record.stateFilePath).toBe(stateFilePath)

    // agentCalls 映射
    expect(record.agentCalls).toHaveLength(2)
    expect(record.agentCalls[0].agent).toBe('dev-W1')
    expect(record.agentCalls[0].status).toBe('completed')
    expect(record.agentCalls[0].phase).toBe('Dev-w0(W1)')
    expect(record.agentCalls[0].sessionId).toBe('019f4b91-e826-7d34-a5ad-4206aa7c5d13')
    expect(record.agentCalls[0].inputTokens).toBe(219882)
    expect(record.agentCalls[0].outputTokens).toBe(11242)
    expect(record.agentCalls[0].turns).toBe(52)
    expect(record.agentCalls[0].durationMs).toBe(480000)
    expect(record.agentCalls[1].agent).toBe('dev-W2')
  })

  it('边界：版本不匹配跳过（v1 快照 + 无 v 字段） + 同 runId 多条 link 去重 + state 文件不存在跳过', () => {
    const sessionFile = join(tempDir, 'main-session.jsonl')

    // wf-A 的 state 文件（v1 旧版本快照——extension 已 bump 到 wf-run-v2，v1 一律跳过）
    const stateA = join(tempDir, 'wf-A.jsonl')
    writeFileSync(stateA, JSON.stringify({ v: 'wf-run-v1', runId: 'wf-A', name: 'old-format' }) + '\n')

    // wf-B 的 state 文件不存在（path 指向不存在的文件）
    const stateB = join(tempDir, 'wf-B-does-not-exist.jsonl')

    // 主 session JSONL：wf-A 出现两次（path 不同但指向同一旧格式文件）+ wf-B path 不存在
    const sessionEntries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-A', path: stateA, updatedAt: '2026-07-10T10:01:00Z' },
        timestamp: '2026-07-10T10:01:00Z',
      },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-A', path: stateA, updatedAt: '2026-07-10T10:02:00Z' },
        timestamp: '2026-07-10T10:02:00Z',
      },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-B', path: stateB, updatedAt: '2026-07-10T10:03:00Z' },
        timestamp: '2026-07-10T10:03:00Z',
      },
    ]
    writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const result = extractWorkflowsFromSessionFile(sessionFile)

    // wf-A 版本不匹配（v1 旧版本）跳过，wf-B 文件不存在跳过 → 空数组
    expect(result).toEqual([])
  })

  it('边界：主 session 文件不存在返回空数组', () => {
    const result = extractWorkflowsFromSessionFile(join(tempDir, 'no-such-file.jsonl'))
    expect(result).toEqual([])
  })

  // [review 修复] 结构守卫回归：JSON.parse 对 "null" / "42" / 缺 v 字段的合法 JSON
  // 产出非 RunSnapshot 结构，守卫前 `.v` 访问会抛 TypeError 而非走「跳过」路径。
  it('边界：state 文件最后一行为 null / 数字 / 缺 v 字段对象 → 按坏行跳过不抛', () => {
    const sessionFile = join(tempDir, 'main-session.jsonl')

    const stateNull = join(tempDir, 'wf-null.jsonl')
    writeFileSync(stateNull, 'null\n')
    const stateNum = join(tempDir, 'wf-num.jsonl')
    writeFileSync(stateNum, '42\n')
    const stateNoV = join(tempDir, 'wf-nov.jsonl')
    writeFileSync(stateNoV, JSON.stringify({ runId: 'wf-nov' }) + '\n')

    const sessionEntries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-null', path: stateNull, updatedAt: '2026-07-10T10:01:00Z' },
        timestamp: '2026-07-10T10:01:00Z',
      },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-num', path: stateNum, updatedAt: '2026-07-10T10:02:00Z' },
        timestamp: '2026-07-10T10:02:00Z',
      },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-nov', path: stateNoV, updatedAt: '2026-07-10T10:03:00Z' },
        timestamp: '2026-07-10T10:03:00Z',
      },
    ]
    writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    // 三种坏结构均跳过，不抛 TypeError
    const result = extractWorkflowsFromSessionFile(sessionFile)
    expect(result).toEqual([])
  })

  // [review 修复 R3-S3] 回归：v 匹配但缺 state/spec/meta 三段的合法 JSON（如并发
  // 截断写产出 {"v":"wf-run-v2"} 纯净对象 / 三段任一为 null），v 守卫放行后
  // mapSnapshotToRecord 直接访问 state.trace / spec.scriptName / meta.startedAt
  // 会抛 TypeError——补三段存在性守卫后按坏行跳过，与 malformed 行为一致。
  it('边界：v2 版本匹配但缺 state/spec/meta（或任一段为 null）→ 按坏行跳过不抛', () => {
    const sessionFile = join(tempDir, 'main-session.jsonl')

    const stateBare = join(tempDir, 'wf-bare.jsonl')
    writeFileSync(stateBare, JSON.stringify({ v: 'wf-run-v2' }) + '\n')
    const stateNullState = join(tempDir, 'wf-null-state.jsonl')
    writeFileSync(stateNullState, JSON.stringify({ v: 'wf-run-v2', state: null, spec: {}, meta: {} }) + '\n')
    const stateMissingSpec = join(tempDir, 'wf-no-spec.jsonl')
    writeFileSync(stateMissingSpec, JSON.stringify({ v: 'wf-run-v2', state: { status: 'running' }, meta: {} }) + '\n')

    const link = (runId: string, path: string, ts: string) => ({
      type: 'custom',
      customType: 'workflow-state-link',
      data: { runId, path, updatedAt: ts },
      timestamp: ts,
    })
    const sessionEntries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      link('wf-bare', stateBare, '2026-07-10T10:01:00Z'),
      link('wf-null-state', stateNullState, '2026-07-10T10:02:00Z'),
      link('wf-no-spec', stateMissingSpec, '2026-07-10T10:03:00Z'),
    ]
    writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    // 三种 v2 匹配的坏结构均跳过，不抛 TypeError
    const result = extractWorkflowsFromSessionFile(sessionFile)
    expect(result).toEqual([])
  })

  // [review 修复 R4] 回归：state.trace 是守卫后唯一被直接解引用的字段（.map）——
  // 非数组真值（"trace":{}）曾让 .map 抛 TypeError 上抛，readAndMapSnapshot 无
  // per-item catch，一个坏 state 文件使整个 session.getWorkflows RPC 回
  // handler_error（该 session 其余 run 一并不可见）。守卫补 Array.isArray 后
  // 该 run 按坏行跳过，其余 run 正常返回。
  it('边界：v2 匹配但 state.trace 非数组（{}）→ 该 run 跳过不抛，其余 run 正常', () => {
    const sessionFile = join(tempDir, 'main-session.jsonl')

    // 坏 run：trace 错型为对象
    const stateBadTrace = join(tempDir, 'wf-bad-trace.jsonl')
    writeFileSync(stateBadTrace, JSON.stringify({
      v: 'wf-run-v2',
      runId: 'wf-bad-trace',
      spec: { scriptName: 'bad-trace-flow' },
      state: { status: 'running', trace: {} },
      meta: { startedAt: '2026-07-10T10:00:00Z' },
    }) + '\n')

    // 好 run：结构完整，与坏 run 共存于同一主 session
    const stateGood = join(tempDir, 'wf-good.jsonl')
    writeFileSync(stateGood, JSON.stringify({
      v: 'wf-run-v2',
      runId: 'wf-good',
      spec: { scriptName: 'good-flow' },
      state: {
        status: 'running',
        budget: { usedTokens: 1000, usedCost: 0 },
        calls: [],
        trace: [{ stepIndex: 0, agent: 'dev-W1', status: 'completed' }],
      },
      meta: { startedAt: '2026-07-10T10:00:00Z' },
    }) + '\n')

    const link = (runId: string, path: string, ts: string) => ({
      type: 'custom',
      customType: 'workflow-state-link',
      data: { runId, path, updatedAt: ts },
      timestamp: ts,
    })
    const sessionEntries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      link('wf-bad-trace', stateBadTrace, '2026-07-10T10:01:00Z'),
      link('wf-good', stateGood, '2026-07-10T10:02:00Z'),
    ]
    writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    // 坏 trace 的 run 跳过，好 run 保留——不抛 TypeError、不废整个列表
    const result = extractWorkflowsFromSessionFile(sessionFile)
    expect(result).toHaveLength(1)
    expect(result[0].runId).toBe('wf-good')
    expect(result[0].scriptName).toBe('good-flow')
    expect(result[0].agentCalls).toHaveLength(1)
    expect(result[0].agentCalls[0].agent).toBe('dev-W1')
  })

  // [review 修复 R4] 回归：trace 数组内的 null 项按坏项过滤——mapTraceNode 的
  // node.result 访问对 null 项抛 TypeError；过滤保留其余合法项，run 本身不跳过。
  it('边界：trace 数组含 null 项 → 坏项过滤、合法项保留（run 不跳过）', () => {
    const sessionFile = join(tempDir, 'main-session.jsonl')
    const stateFilePath = join(tempDir, 'wf-null-items.jsonl')

    const snapshot = {
      v: 'wf-run-v2',
      runId: 'wf-null-items',
      spec: { scriptName: 'mixed-trace-flow' },
      state: {
        status: 'done',
        budget: { usedTokens: 0, usedCost: 0 },
        calls: [],
        trace: [
          null,
          { stepIndex: 0, agent: 'dev-W1', status: 'completed', phase: 'P1' },
          null,
        ],
      },
      meta: { startedAt: '2026-07-10T10:00:00Z' },
    }
    writeFileSync(stateFilePath, JSON.stringify(snapshot) + '\n')

    const sessionEntries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-null-items', path: stateFilePath, updatedAt: '2026-07-10T10:01:00Z' },
        timestamp: '2026-07-10T10:01:00Z',
      },
    ]
    writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const result = extractWorkflowsFromSessionFile(sessionFile)
    expect(result).toHaveLength(1)
    expect(result[0].runId).toBe('wf-null-items')
    expect(result[0].agentCalls).toHaveLength(1)
    expect(result[0].agentCalls[0].agent).toBe('dev-W1')
    expect(result[0].agentCalls[0].phase).toBe('P1')
  })

  // [review 修复 R4] 版本不匹配不再静默跳过——extension（mandatory + autoUpgrade）
  // 先发版、app 未跟上时新 run 全部消失，warn 使该版本漂移可观测（含行动指引）。
  it('版本不匹配跳过时输出 warn（含实际版本、期望版本与修复指引）', () => {
    const sessionFile = join(tempDir, 'main-session.jsonl')
    const stateV1 = join(tempDir, 'wf-v1.jsonl')
    writeFileSync(stateV1, JSON.stringify({ v: 'wf-run-v1', runId: 'wf-v1', state: {}, spec: {}, meta: {} }) + '\n')

    const sessionEntries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-v1', path: stateV1, updatedAt: '2026-07-10T10:01:00Z' },
        timestamp: '2026-07-10T10:01:00Z',
      },
    ]
    writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = extractWorkflowsFromSessionFile(sessionFile)
      expect(result).toEqual([])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const msg = String(warnSpy.mock.calls[0][0])
      expect(msg).toContain("version 'wf-run-v1' unsupported (expected 'wf-run-v2')")
      expect(msg).toContain('wf-v1')
      expect(msg).toContain('jsonl-run-store.ts')
    } finally {
      warnSpy.mockRestore()
    }
  })

  // 三源一致性护栏：wf-run-v* 快照版本字面量分布在 3 个包（跨包依赖方向不允许互相
  // import 源码），extension bump 格式版本时任何一处漏改都会静默丢数据：
  // - 源 1（权威）：extension jsonl-run-store.ts 的 SNAPSHOT_VERSION——漏改不会（它是生产方）
  // - 源 2（副本）：runtime workflow-extractor.ts 的本地副本——漏改则版本守卫把新快照
  //   全部判为不匹配跳过（renderer WorkflowList 全空）
  // - 源 3（消费方）：session-reader（独立发 npm 的 sibling 扩展）两处版本判定——
  //   discovery/workflows.ts isNew + core/workflow.ts NEW 分支。漏改则 family/workflows
  //   腿对新 run 静默丢全部 calls sessionFile、workflow overview 对新 run 返 null
  it('三源一致性：runtime SNAPSHOT_VERSION 副本 + session-reader 两处版本判定与 extension jsonl-run-store.ts 同步', () => {
    const extSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'extensions', 'subagent-workflow', 'src', 'orchestration', 'jsonl-run-store.ts'),
      'utf-8',
    )
    const extMatch = extSrc.match(/export const SNAPSHOT_VERSION = "([^"]+)"/)
    expect(extMatch, 'extension 侧 SNAPSHOT_VERSION 导出字面量未找到——导出形式是否变了？').not.toBeNull()
    const current = extMatch![1]

    // 源 2：runtime 副本与权威源字面量相等
    const rtSrc = readFileSync(
      join(__dirname, '..', 'src', 'services', 'session', 'workflow-extractor.ts'),
      'utf-8',
    )
    const rtMatch = rtSrc.match(/const SNAPSHOT_VERSION = '([^']+)'/)
    expect(rtMatch, 'runtime 侧 SNAPSHOT_VERSION 常量字面量未找到').not.toBeNull()
    expect(rtMatch![1]).toBe(current)

    // 源 3a：session-reader discovery/workflows.ts 的 isNew 判定接受当前版本
    const srDiscoverySrc = readFileSync(
      join(__dirname, '..', '..', '..', 'extensions', 'session-reader', 'src', 'discovery', 'workflows.ts'),
      'utf-8',
    )
    const isNewLine = srDiscoverySrc.match(/const isNew = s\.v === '([^']+)[^\n]*/)
    expect(
      isNewLine,
      'session-reader discovery/workflows.ts 的 isNew 版本判定未找到——判定写法是否变了？',
    ).not.toBeNull()
    expect(
      isNewLine![0].includes(`'${current}'`),
      `session-reader discovery/workflows.ts isNew 判定不含当前快照版本 '${current}'——extension bump 快照版本时须同步扩 session-reader 的判定，否则 family/workflows 腿对新 run 静默丢全部 calls sessionFile`,
    ).toBe(true)

    // 源 3b：session-reader core/workflow.ts 的 NEW 分支判定接受当前版本
    const srCoreSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'extensions', 'session-reader', 'src', 'core', 'workflow.ts'),
      'utf-8',
    )
    const newBranchLine = srCoreSrc.match(/if \(v === '([^']+)[^\n]*/)
    expect(
      newBranchLine,
      'session-reader core/workflow.ts 的 NEW 分支版本判定未找到——判定写法是否变了？',
    ).not.toBeNull()
    expect(
      newBranchLine![0].includes(`'${current}'`),
      `session-reader core/workflow.ts NEW 分支判定不含当前快照版本 '${current}'——extension bump 快照版本时须同步扩 session-reader 的判定，否则 workflow overview 对新 run 静默返 null`,
    ).toBe(true)
  })

  it('边界：running 状态 + trace 节点含 pending/failed 的映射', () => {
    const stateFilePath = join(tempDir, 'wf-running.jsonl')
    const sessionFile = join(tempDir, 'main-session.jsonl')

    const snapshot = {
      v: 'wf-run-v2',
      runId: 'wf-running',
      spec: { scriptSource: '', args: {}, scriptName: 'partial-flow', scriptPath: '/wf.ts' },
      state: {
        status: 'running',
        budget: { usedTokens: 100000, usedCost: 0, totalCallCount: 2 },
        calls: [],
        trace: [
          {
            stepIndex: 0,
            agent: 'dev-W1',
            task: 'task 1',
            model: 'glm-4.6',
            status: 'completed',
            phase: 'Phase1',
            sessionId: 'sess-001',
            startedAt: '2026-07-10T10:00:00Z',
            result: { content: 'ok', usage: { input: 50000, output: 5000, turns: 10 }, durationMs: 300000 },
          },
          {
            stepIndex: 1,
            agent: 'dev-W2',
            task: 'task 2',
            model: 'glm-4.6',
            status: 'failed',
            phase: 'Phase1',
            sessionId: 'sess-002',
            startedAt: '2026-07-10T10:05:00Z',
            error: 'Build failed',
            result: { content: '', error: 'Build failed', usage: { input: 30000, output: 2000, turns: 5 } },
          },
          {
            stepIndex: 2,
            agent: 'dev-W3',
            task: 'task 3',
            model: 'glm-4.6',
            status: 'pending',
            phase: 'Phase2',
          },
        ],
        errorLogs: [],
      },
      meta: { startedAt: '2026-07-10T09:59:00Z' },
    }
    writeFileSync(stateFilePath, JSON.stringify(snapshot) + '\n')

    const sessionEntries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T09:58:00Z' },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-running', path: stateFilePath, updatedAt: '2026-07-10T10:10:00Z' },
        timestamp: '2026-07-10T10:10:00Z',
      },
    ]
    writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const result = extractWorkflowsFromSessionFile(sessionFile)

    expect(result).toHaveLength(1)
    const record = result[0]
    expect(record.status).toBe('running')
    expect(record.reason).toBeUndefined()
    expect(record.completedAt).toBeUndefined()
    expect(record.agentCalls).toHaveLength(3)

    // completed 节点
    expect(record.agentCalls[0].status).toBe('completed')
    expect(record.agentCalls[0].sessionId).toBe('sess-001')
    expect(record.agentCalls[0].inputTokens).toBe(50000)

    // failed 节点：error 从 trace.error 提取
    expect(record.agentCalls[1].status).toBe('failed')
    expect(record.agentCalls[1].error).toBe('Build failed')

    // pending 节点：无 result/sessionId
    expect(record.agentCalls[2].status).toBe('pending')
    expect(record.agentCalls[2].sessionId).toBeUndefined()
    expect(record.agentCalls[2].phase).toBe('Phase2')
  })
})
