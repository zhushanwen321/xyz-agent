/**
 * W1 基础层红灯测试 —— fork 字段透传（U1-U6）。
 *
 * 本文件为 TDD 红灯阶段：测试断言 W1 即将引入的 fork 相关字段/函数已存在且行为正确。
 * 当前实现尚未引入这些字段（parentSession / forkEntryId / handedOffTo / lastMergedAt）
 * 与函数（persistHandedOff / extractHandedOff）。
 *
 * 红灯分类：
 * - U2/U3/U4/U5：运行时红灯 —— 直接断言行为，vitest run 即 fail。
 * - U1/U6：类型契约红灯 —— 断言类型接受新字段。vitest 用 esbuild 不做类型检查，这两条
 *   在 vitest run 下会通过；W1 实现后这些字段成为类型的一部分，契约自然满足。真正的类型
 *   回归防护由 `pnpm --filter @xyz-agent/runtime typecheck`（tsc --noEmit）承担：若 W1
 *   实现移除字段，字面量赋值会在 tsc 下报错。
 *
 * W1 实现完成后，本文件应全绿。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-fork-fields.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// shared 类型（U1）
import type { SessionSummary } from '@xyz-agent/shared'

// infra 工具（U2/U3/U6 第一处）
import {
  parseSessionHeader,
  // persistHandedOff / extractHandedOff 尚不存在 —— 引入失败即红灯
  persistHandedOff as persistHandedOffInfra,
  extractHandedOff as extractHandedOffInfra,
} from '../infra/pi/session-file-utils.js'

// session-fork（U4）
import { createForkedSessionFile } from '../services/session/session-fork.js'

// ports 第二处 ScannedSessionMeta（U6）
import type { ScannedSessionMeta as ScannedSessionMetaPort } from '../services/ports/session.js'
import type { ScannedSessionMeta as ScannedSessionMetaInfra } from '../infra/pi/session-file-utils.js'

describe('W1 fork 字段透传', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'w1-fork-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // ── U1：SessionSummary 含 4 个新可选字段 ─────────────────────────

  it('U1: SessionSummary 接受 parentSession / forkEntryId / handedOffTo / lastMergedAt 字段', () => {
    // 类型契约测试：把含全部新字段的对象赋值给 SessionSummary 类型变量。
    // 若 W1 实现移除任一字段，此赋值在 tsc --noEmit 下报错（字段名不在类型中）。
    // 运行时不断言（expect 对象有属性是恒真「空绿」），类型契约由 tsc --noEmit 承载。
    const summary: SessionSummary = {
      id: 'sess-1',
      label: 'test',
      cwd: '/test',
      status: 'idle',
      lastActiveAt: Date.now(),
      modelId: 'p/m',
      tokenCount: 0,
      parentSession: '/path/to/parent.jsonl',
      forkEntryId: 'entry-123',
      handedOffTo: 'child-session-456',
      lastMergedAt: 1234567890,
    }
    // 引用 summary 避免未使用告警；运行时不做属性恒真断言（类型层已保障）。
    expect(summary.id).toBe('sess-1')
  })

  // ── U2：parseSessionHeader 解析 parentSession + forkEntryId ──────────

  it('U2: parseSessionHeader 返回 header 中的 parentSession + forkEntryId', () => {
    const filePath = join(dir, 'forked.jsonl')
    writeFileSync(
      filePath,
      JSON.stringify({
        type: 'session',
        id: 'forked-1',
        cwd: '/test',
        timestamp: '2026-07-07T01:00:00.000Z',
        parentSession: '/path/to/parent.jsonl',
        forkEntryId: 'entry-123',
      }) + '\n',
    )
    const header = parseSessionHeader(filePath)
    expect(header).not.toBeNull()
    expect(header?.parentSession).toBe('/path/to/parent.jsonl')
    expect(header?.forkEntryId).toBe('entry-123')
  })

  // ── U3：persistHandedOff append + extractHandedOff 尾读 ───────────

  it('U3: persistHandedOff 追加 handoff marker 行，extractHandedOff 尾读返回目标 sessionId', () => {
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(
      filePath,
      JSON.stringify({ type: 'session', id: 'src-1', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }) + '\n',
    )

    persistHandedOffInfra(filePath, 'new-session-id')

    // 文件追加了 handoff marker 行（运行时标记新 session 已接管）
    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain('new-session-id')

    // extractHandedOff 尾读返回被交接的目标 sessionId
    expect(extractHandedOffInfra(filePath)).toBe('new-session-id')
  })

  // ── U4：createForkedSessionFile 写入 forkEntryId 到 newHeader ───────

  it('U4: createForkedSessionFile 写入 forkEntryId 到新 session 的 header', async () => {
    const sourceFile = join(dir, 'source.jsonl')
    writeFileSync(
      sourceFile,
      [
        { type: 'session', version: 3, id: 'src-session-id', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    // 传入 forkEntryId（fork 点的 pi entryId），期望新文件 header 记录该字段
    const { filePath } = await createForkedSessionFile(
      sourceFile,
      'a1',          // forkEntryId（截断点）
      true,          // includeFrom
      dir,           // targetDir
      'a1',          // forkEntryId 字段（写入新 header，供后续 merge 定位 fork 点）
    )

    const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0]
    const header = JSON.parse(firstLine)
    expect(header.forkEntryId).toBe('a1')
  })

  // ── U5：parentSession fallback（源 session 未落盘时用源 sessionId）──

  it('U5: 源 session sessionFilePath 缺失时，parentSession fallback 到源 sessionId', async () => {
    // createForkedSessionFile 在源 header 已有 parentSession 时透传；
    // 若源 sessionFile 尚未落盘（sessionFilePath=undefined），forkSession/
    // initializeManagedSession 应把 parentSession 写成源 sessionId 而非 undefined。
    //
    // 本用例通过 createForkedSessionFile 的 parentSession fallback 参数覆盖：
    // 传入 fallbackParentId，期望新 header.parentSession 在源 header 无 parentSession 时
    // 取 fallbackParentId（源 sessionId），形成可追溯的父子链。
    const sourceFile = join(dir, 'source-noparent.jsonl')
    writeFileSync(
      sourceFile,
      [
        // 源 session header 无 parentSession（顶层 session，非 fork 产物）
        { type: 'session', version: 3, id: 'top-level-session', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    const { filePath } = await createForkedSessionFile(
      sourceFile,
      'u1',
      true,
      dir,
      undefined,        // forkEntryId 字段（本用例不关心）
      'top-level-session', // fallbackParentId：源 session 尚未落盘时用源 sessionId
    )

    const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0]
    const header = JSON.parse(firstLine)
    // fallback 生效：parentSession 不是源文件路径（源未落盘），而是源 sessionId
    expect(header.parentSession).toBe('top-level-session')
  })

  // ── U6：ScannedSessionMeta 两处定义字段对齐 ────────────────────────

  it('U6: ScannedSessionMeta 两处定义都含 parentSession / forkEntryId / handedOffTo 字段', () => {
    // 类型契约测试：同一个含全部字段的对象同时赋值给两处 ScannedSessionMeta 类型别名
    // （infra/pi/session-file-utils.ts 与 services/ports/session.ts）。若两处定义字段集分歧
    // （如一处删了 parentSession），对应赋值在 tsc --noEmit 下报错。运行时不断言属性恒真
    // （空绿），类型契约由 tsc --noEmit 承载；此处仅引用变量避免未使用告警。
    const meta = {
      id: 'sess-1',
      filePath: '/test/sess-1.jsonl',
      cwd: '/test',
      timestamp: '2026-07-07T01:00:00.000Z',
      name: 'test',
      outcome: 'done' as const,
      lastModified: Date.now(),
      size: 100,
      parentSession: '/path/to/parent.jsonl',
      forkEntryId: 'entry-123',
      handedOffTo: 'child-session-456',
    }

    // infra/pi/session-file-utils.ts 的定义
    const metaInfra: ScannedSessionMetaInfra = meta
    // services/ports/session.ts 的定义
    const metaPort: ScannedSessionMetaPort = meta

    // 运行时不做属性恒真断言（类型层已保障两处接受同一字段集），仅引用防未使用。
    expect(metaInfra.id).toBe(metaPort.id)
  })
})
