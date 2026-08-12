import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { parseRunSnapshot, renderWorkflowOverview } from '../core/workflow.js'
import { readRunSnapshot } from '../discovery/workflows.js'
import { REAL_AGENT_DIR } from './real-data.js'

// ============================================================
// fixture（结构对齐真实 wf-state 探针数据）
// ============================================================

/**
 * NEW 格式 fixture（对齐 ~/.pi/agent/workflow-state/wf-1785762350110-d297tr.jsonl）。
 * runId 故意写成 'wf-ignore' 验证 parseRunSnapshot 用参数透传不读 snapshot.runId。
 */
const NEW_SNAPSHOT_FIXTURE = {
  v: 'wf-run-v1',
  runId: 'wf-ignore',
  spec: { scriptName: 'thinkinglevel-probe', name: 'Probe Name', scriptSource: '// ...' },
  state: {
    status: 'done',
    reason: 'completed',
    budget: { usedTokens: 11060.24, usedCost: 0, totalCallCount: 1, maxTokens: 100000 },
    calls: [
      {
        id: 0,
        opts: {
          prompt: 'Reply with exactly: PROBE-OK',
          model: 'deepseek-router/ds-pro',
          thinkingLevel: 'high',
          description: 'step-0',
        },
        status: 'done',
        attempts: 1,
        result: {
          content: 'PROBE-OK',
          durationMs: 1234,
          sessionId: '019xxx',
          sessionFile: '/abs/session.jsonl',
          usage: { input: 10546 },
        },
      },
    ],
  },
  meta: { startedAt: '2026-08-03T13:05:50.111Z', completedAt: '2026-08-03T13:05:55.384Z' },
}

/** OLD 格式 fixture（对齐 wf-skip-ok.jsonl：无 v，callCache value 无 sessionFile/result）。 */
const OLD_SNAPSHOT_FIXTURE = {
  runId: 'wf-old-ignore',
  name: 'workflow-wf-skip-ok',
  status: 'running',
  callCache: [{ key: 7, value: { content: '', usage: { input: 0 } } }],
  trace: [],
  worker: 'agent-test',
  startedAt: '2026-01-01T00:00:00Z',
  budget: { usedTokens: 0, usedCost: 0 },
}

// ============================================================
// parseRunSnapshot（纯逻辑，TC-w5-parse-new/old/corrupt/malformed）
// ============================================================

describe('parseRunSnapshot', () => {
  it('TC-w5-parse-new：NEW 格式 (v=wf-run-v1) 字段映射，runId/stateFile 参数透传', () => {
    const overview = parseRunSnapshot(NEW_SNAPSHOT_FIXTURE, 'wf-link-runid', '/abs/wf.jsonl')
    expect(overview).not.toBeNull()
    // 参数透传（不读 snapshot.runId）
    expect(overview!.runId).toBe('wf-link-runid')
    expect(overview!.stateFile).toBe('/abs/wf.jsonl')
    // 顶层字段
    expect(overview!.version).toBe('wf-run-v1')
    expect(overview!.status).toBe('done')
    expect(overview!.reason).toBe('completed')
    expect(overview!.script).toBe('thinkinglevel-probe') // spec.scriptName 优先于 name
    expect(overview!.startedAt).toBe('2026-08-03T13:05:50.111Z')
    expect(overview!.completedAt).toBe('2026-08-03T13:05:55.384Z')
    // budget 透传
    expect(overview!.budget.usedTokens).toBe(11060.24)
    expect(overview!.budget.usedCost).toBe(0)
    expect(overview!.budget.totalCallCount).toBe(1)
    expect(overview!.budget.maxTokens).toBe(100000)
    // steps
    expect(overview!.steps).toHaveLength(1)
    const step = overview!.steps[0]
    expect(step.index).toBe(0)
    expect(step.status).toBe('done')
    expect(step.description).toBe('step-0')
    expect(step.model).toBe('deepseek-router/ds-pro')
    expect(step.thinkingLevel).toBe('high')
    expect(step.attempts).toBe(1)
    expect(step.durationMs).toBe(1234)
    expect(step.sessionId).toBe('019xxx')
    expect(step.sessionFile).toBe('/abs/session.jsonl')
    expect(step.contentPreview).toBe('PROBE-OK')
  })

  it('TC-w5-parse-old：OLD 格式 (无 v) 尽力解析为 legacy overview，step status 推测', () => {
    const overview = parseRunSnapshot(OLD_SNAPSHOT_FIXTURE, 'wf-old-link', '/abs/wf-old.jsonl')
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('legacy')
    expect(overview!.status).toBe('running') // 顶层 status
    expect(overview!.script).toBe('workflow-wf-skip-ok') // name 映射
    expect(overview!.startedAt).toBe('2026-01-01T00:00:00Z')
    expect(overview!.budget.usedTokens).toBe(0)
    expect(overview!.budget.usedCost).toBe(0)
    // steps
    expect(overview!.steps).toHaveLength(1)
    const step = overview!.steps[0]
    expect(step.index).toBe(0) // callCache 顺序索引
    expect(step.status).toBe('pending') // content='' 空串不算完成标志 → pending
    expect(step.sessionFile).toBeUndefined() // OLD 未持久化
    expect(step.contentPreview).toBe('') // value.content='' 仍提取
  })

  it('TC-w5-parse-corrupt-nonobject：非对象输入（null/undefined/string/number/array）返回 null', () => {
    for (const bad of [null, undefined, 'string', 42, [1, 2, 3]] as unknown[]) {
      expect(parseRunSnapshot(bad, 'r', 's')).toBeNull()
    }
  })

  it('TC-w5-parse-malformed：既非 NEW 也非 OLD（缺关键字段）返回 null', () => {
    // (a) 有 v 但 v!=='wf-run-v1' 且无 callCache（未来版本 wf-run-v2）
    expect(parseRunSnapshot({ v: 'wf-run-v2', state: { calls: [] } }, 'r', 's')).toBeNull()
    // (b) 无 v 无 callCache 无 status（异构对象）
    expect(parseRunSnapshot({ foo: 'bar', baz: 1 }, 'r', 's')).toBeNull()
  })
})

// ============================================================
// renderWorkflowOverview（纯逻辑，TC-w5-render-new/old）
// ============================================================

describe('renderWorkflowOverview', () => {
  it('TC-w5-render-new：NEW 概览含 run 头/budget/steps，step 含 call sessionId 截断 + sessionFile 绝对路径', () => {
    const overview = {
      runId: 'wf-run-1',
      stateFile: '/abs/state.jsonl',
      status: 'done',
      version: 'wf-run-v1' as const,
      script: 'probe',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      budget: { usedTokens: 11060, usedCost: 0, totalCallCount: 2, maxTokens: 100000 },
      steps: [
        {
          index: 0,
          status: 'done' as const,
          model: 'm1',
          durationMs: 100,
          sessionId: '019aaa',
          sessionFile: '/abs/a.jsonl',
        },
        {
          index: 1,
          status: 'done' as const,
          model: 'm1',
          durationMs: 200,
          sessionId: '019bbb',
          sessionFile: '/abs/b.jsonl',
        },
      ],
    }
    const out = renderWorkflowOverview(overview)
    // 头行
    expect(out).toContain('run: wf-run-1')
    expect(out).toContain('[done]')
    // budget 行
    expect(out).toContain('budget:')
    expect(out).toContain('used=11060tok')
    expect(out).toContain('calls=2')
    expect(out).toContain('max=100000tok')
    // 每个 step 行
    expect(out).toContain('#0')
    expect(out).toContain('#1')
    expect(out).toContain('model=m1')
    expect(out).toContain('100ms')
    expect(out).toContain('call=019aaa') // sessionId 截断（6 字符 <= 12）
    expect(out).toContain('/abs/a.jsonl') // sessionFile 绝对路径（跳转入口）
    expect(out).toContain('/abs/b.jsonl')
  })

  it('TC-w5-render-old：OLD 概览 step sessionFile 缺标「（无 sessionFile，OLD 格式未持久化）」', () => {
    const overview = {
      runId: 'wf-old-1',
      stateFile: '/abs/old.jsonl',
      status: 'running',
      version: 'legacy' as const,
      budget: { usedTokens: 0 },
      steps: [{ index: 0, status: 'pending' as const, sessionFile: undefined }],
    }
    const out = renderWorkflowOverview(overview)
    expect(out).toContain('run:')
    expect(out).toContain('[running]')
    expect(out).toContain('budget:')
    expect(out).toContain('#0')
    expect(out).toContain('[pending]')
    expect(out).toContain('（无 sessionFile，OLD 格式未持久化）')
    // 不输出 'sessionFile=undefined' 字面量
    expect(out).not.toContain('sessionFile=undefined')
  })
})

// ============================================================
// readRunSnapshot（IO，TC-w5-read-tail-fallback/no-file/all-unparseable）
// ============================================================

describe('readRunSnapshot', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('TC-w5-read-tail-fallback：末行半截 JSON 回退倒数第二行完整快照', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-read-tail-'))
    const path = join(dir, 'wf.jsonl')
    // 第 1 行完整 NEW snapshot + 半截第 2 行（模拟 rewrite 中点）
    const fullLine = JSON.stringify(NEW_SNAPSHOT_FIXTURE)
    const halfLine = '{"v":"wf-run-v1","state":{"calls":[{'
    await writeFile(path, fullLine + '\n' + halfLine)

    const snap = await readRunSnapshot(path)
    expect(snap).not.toBeUndefined()
    const s = snap as Record<string, unknown>
    expect(s.v).toBe('wf-run-v1') // 倒数第二行完整 NEW snapshot
    expect(s.state).toBeDefined()
  })

  it('TC-w5-read-no-file：文件不存在返回 undefined（不抛错）', async () => {
    const snap = await readRunSnapshot('/nonexistent/wf-xxx.jsonl')
    expect(snap).toBeUndefined()
  })

  it('TC-w5-read-all-unparseable：全行 JSON.parse 失败返回 undefined', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-read-bad-'))
    const path = join(dir, 'wf.jsonl')
    await writeFile(path, '{bad json\n}{also bad')
    const snap = await readRunSnapshot(path)
    expect(snap).toBeUndefined()
  })
})

// ============================================================
// 真实数据守卫（~/.pi/agent/workflow-state，CI 无本机数据时 skipIf 跳过）
// ============================================================

const REAL_WF_NEW = join(REAL_AGENT_DIR, 'workflow-state', 'wf-1785762350110-d297tr.jsonl')
const REAL_WF_OLD = join(REAL_AGENT_DIR, 'workflow-state', 'wf-skip-ok.jsonl')
const HAS_REAL_WF_NEW = existsSync(REAL_WF_NEW)
const HAS_REAL_WF_OLD = existsSync(REAL_WF_OLD)

describe.skipIf(!HAS_REAL_WF_NEW)('真实数据守卫 - NEW wf-state（wf-1785762350110-d297tr）', () => {
  it('TC-w5-real-new-guard：readRunSnapshot+parseRunSnapshot 类型化 NEW 真实快照', async () => {
    const snap = await readRunSnapshot(REAL_WF_NEW)
    expect(snap).not.toBeUndefined()
    const overview = parseRunSnapshot(snap, 'wf-1785762350110-d297tr', REAL_WF_NEW)
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('wf-run-v1')
    expect(overview!.steps.length).toBeGreaterThanOrEqual(1)
    // call 的 sessionFile 是真实绝对 .jsonl 路径（跳转入口）
    expect(overview!.steps[0].sessionFile).toMatch(/\.jsonl$/)
    expect(overview!.steps[0].sessionFile!.startsWith('/')).toBe(true)
    expect(overview!.steps[0].sessionId).toBeTruthy()
  }, 30000)
})

describe.skipIf(!HAS_REAL_WF_OLD)('真实数据守卫 - OLD wf-state（wf-skip-ok）', () => {
  it('TC-w5-real-old-guard：readRunSnapshot+parseRunSnapshot 尽力解析 OLD 真实快照', async () => {
    const snap = await readRunSnapshot(REAL_WF_OLD)
    expect(snap).not.toBeUndefined()
    const overview = parseRunSnapshot(snap, 'wf-skip-ok', REAL_WF_OLD)
    expect(overview).not.toBeNull()
    expect(overview!.version).toBe('legacy')
    expect(overview!.status).toBe('running')
    expect(overview!.script).toBe('workflow-wf-skip-ok') // name 映射
    // OLD callCache value 无 sessionFile（探针 112 文件 0 sessionFile）
    expect(overview!.steps[0].sessionFile).toBeUndefined()
  }, 30000)
})
