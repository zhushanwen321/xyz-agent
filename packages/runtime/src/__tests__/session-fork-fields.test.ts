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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// shared 类型（U1）
import type { SessionSummary } from '@xyz-agent/shared'

// infra 工具（U2/U3/U6 第一处）
import {
  parseSessionHeader,
  // W11：persistHandedOff 迁 sidecar 改名 persistHandoffSidecar（旧名已删）
  persistHandoffSidecar as persistHandoffInfra,
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

  // ── U3：persistHandoffSidecar 写 sidecar + extractHandedOff 读取（W11 迁移）──

  it('U3: persistHandoffSidecar 写 .handoff.json sidecar（JSONL 零写），extractHandedOff 读回目标 sessionId', () => {
    const filePath = join(dir, 'session.jsonl')
    const original = JSON.stringify({ type: 'session', id: 'src-1', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }) + '\n'
    writeFileSync(filePath, original)

    persistHandoffInfra(filePath, 'new-session-id')

    // sidecar 出现且内容正确（xyz 自有文件，不触碰 pi 的 JSONL）
    const sidecarPath = filePath + '.handoff.json'
    expect(existsSync(sidecarPath)).toBe(true)
    const marker = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
    expect(marker.handedOffTo).toBe('new-session-id')
    expect(marker.type).toBe('handoff_marker')

    // JSONL 本体字节不变（绝对写规则：session JSONL 唯一写方是 pi）
    expect(readFileSync(filePath, 'utf-8')).toBe(original)

    // extractHandedOff 优先读 sidecar，返回被交接的目标 sessionId
    expect(extractHandedOffInfra(filePath)).toBe('new-session-id')
  })

  it('U3b: JSONL 不存在时跳过（规则 #6——绝不创建 sidecar，pi openSync("wx") 竞态防护）', () => {
    const filePath = join(dir, 'never-flushed.jsonl')
    expect(() => persistHandoffInfra(filePath, 'target-id')).not.toThrow()
    expect(existsSync(filePath + '.handoff.json')).toBe(false)
  })

  it('U3c: 存量旧 session 兼容——无 sidecar、JSONL 尾部含旧 handoff_marker entry 时 fallback 尾读', () => {
    const filePath = join(dir, 'legacy.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-2', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'legacy-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    // 无 sidecar → fallback 尾读旧 marker（W11 前写入的存量形态）
    expect(extractHandedOffInfra(filePath)).toBe('legacy-target')
  })

  it('U3d: sidecar 优先于旧 JSONL marker（两者并存时新值胜出）', () => {
    const filePath = join(dir, 'both.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-3', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'old-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    persistHandoffInfra(filePath, 'new-target')
    expect(extractHandedOffInfra(filePath)).toBe('new-target')
  })

  it('U3e: 无 sidecar 且无 marker → undefined（未交接）', () => {
    const filePath = join(dir, 'clean.jsonl')
    writeFileSync(
      filePath,
      JSON.stringify({ type: 'session', id: 'src-4', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }) + '\n',
    )
    expect(extractHandedOffInfra(filePath)).toBeUndefined()
  })

  it('U3f: 损坏 sidecar（handedOffTo 非字符串）→ fallthrough 尾读 JSONL 兜底', () => {
    const filePath = join(dir, 'corrupt.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-5', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'jsonl-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    writeFileSync(filePath + '.handoff.json', JSON.stringify({ handedOffTo: 123 }))
    expect(extractHandedOffInfra(filePath)).toBe('jsonl-target')
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
