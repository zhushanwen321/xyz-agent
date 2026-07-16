import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractWorkflowsFromSessionFile } from '../src/services/session/workflow-extractor.js'

/**
 * workflow-extractor 测试。
 *
 * 数据链：主 session JSONL 的 workflow-state-link custom entry →
 * data.path 指向的 workflow-state/<runId>.jsonl（单行 RunSnapshot）→
 * 版本守卫 v==='wf-run-v1' → 映射 WorkflowRunRecord。
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

  it('正常映射：主 session JSONL 含 workflow-state-link + state 文件含 wf-run-v1 快照（2 个 trace 节点）', () => {
    const stateFilePath = join(tempDir, 'wf-test-001.jsonl')
    const sessionFile = join(tempDir, 'main-session.jsonl')

    // 构造 wf-run-v1 快照（2 个 trace 节点）
    const snapshot = {
      v: 'wf-run-v1',
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

  it('边界：版本不匹配跳过 + 同 runId 多条 link 去重 + state 文件不存在跳过', () => {
    const sessionFile = join(tempDir, 'main-session.jsonl')

    // wf-A 的 state 文件（旧版本，无 v 字段）
    const stateA = join(tempDir, 'wf-A.jsonl')
    writeFileSync(stateA, JSON.stringify({ runId: 'wf-A', name: 'old-format' }) + '\n')

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

    // wf-A 版本不匹配（无 v 字段）跳过，wf-B 文件不存在跳过 → 空数组
    expect(result).toEqual([])
  })

  it('边界：主 session 文件不存在返回空数组', () => {
    const result = extractWorkflowsFromSessionFile(join(tempDir, 'no-such-file.jsonl'))
    expect(result).toEqual([])
  })

  it('边界：running 状态 + trace 节点含 pending/failed 的映射', () => {
    const stateFilePath = join(tempDir, 'wf-running.jsonl')
    const sessionFile = join(tempDir, 'main-session.jsonl')

    const snapshot = {
      v: 'wf-run-v1',
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
