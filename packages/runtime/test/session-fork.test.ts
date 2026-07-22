/**
 * createForkedSessionFile 单测 — JSONL 截断工具（fork 路径 A 核心）。
 *
 * 覆盖：
 * - 树回溯（从 forkEntryId 沿 parentId 到 root）
 * - includeFrom=true（含 fork 点）/ false（不含）
 * - session header 重建（新 id/timestamp/parentSession 指回源）
 * - 兄弟分支丢弃（不在路径上的 entry 不写入）
 * - 边界：源文件不存在 / 无 session header / forkEntryId 找不到
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/session-fork.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createForkedSessionFile } from '../src/services/session/session-fork.js'
import { parseJsonl } from '../src/utils/jsonl.js'

/** 读 fork 后的文件，返回解析后的 entry 数组（文件级共享，多 describe 复用） */
async function readForked(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, 'utf-8')
  return parseJsonl(raw) as Record<string, unknown>[]
}

describe('createForkedSessionFile', () => {
  let sourceDir: string
  let targetDir: string
  let sourceFile: string

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), 'fork-src-'))
    targetDir = await mkdtemp(join(tmpdir(), 'fork-tgt-'))
    sourceFile = join(sourceDir, 'source.jsonl')
  })

  afterEach(async () => {
    await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
  })

  /** 构建测试 JSONL：session header + 3 turn（user/assistant/toolResult） */
  async function writeSourceJSONL(): Promise<void> {
    const lines = [
      { type: 'session', version: 3, id: 'src-session-id', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-07-07T01:00:00.100Z', provider: 'p', modelId: 'm' },
      // turn 1
      { type: 'message', id: 'u1', parentId: 'mc1', timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      // turn 2
      { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-07-07T01:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'do work' }] } },
      { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-07-07T01:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      // turn 3
      { type: 'message', id: 'u3', parentId: 'a2', timestamp: '2026-07-07T01:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'more' }] } },
      { type: 'message', id: 'a3', parentId: 'u3', timestamp: '2026-07-07T01:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]
    await writeFile(sourceFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  it('includeFrom=true：保留到 fork 点（含），兄弟分支丢弃', async () => {
    await writeSourceJSONL()
    // fork 到 a2（turn 2 assistant，含）→ 保留 u1/a1/u2/a2 + mc1，丢弃 u3/a3
    const { filePath } = await createForkedSessionFile(sourceFile, 'a2', true, targetDir)

    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)

    // session header（新 id）+ mc1 + u1 + a1 + u2 + a2
    expect(ids).toHaveLength(6)
    expect(ids).toContain('mc1')
    expect(ids).toContain('u1')
    expect(ids).toContain('a1')
    expect(ids).toContain('u2')
    expect(ids).toContain('a2')
    expect(ids).not.toContain('u3')
    expect(ids).not.toContain('a3')
  })

  it('includeFrom=false：保留到 fork 点前（不含 fork 点）', async () => {
    await writeSourceJSONL()
    // fork 到 u3（不含）→ 保留到 u3 前 = mc1/u1/a1/u2/a2，丢弃 u3/a3
    const { filePath } = await createForkedSessionFile(sourceFile, 'u3', false, targetDir)

    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)

    expect(ids).toContain('mc1')
    expect(ids).toContain('u1')
    expect(ids).toContain('a1')
    expect(ids).toContain('u2')
    expect(ids).toContain('a2')
    expect(ids).not.toContain('u3')
    expect(ids).not.toContain('a3')
  })

  it('session header 重建：新 id + parentSession 指回源文件', async () => {
    await writeSourceJSONL()
    const { filePath, sessionId } = await createForkedSessionFile(sourceFile, 'a1', true, targetDir)

    const entries = await readForked(filePath)
    const header = entries[0]
    expect(header.type).toBe('session')
    expect(header.id).toBe(sessionId) // 新 session id
    expect(header.id).not.toBe('src-session-id') // 不是源 id
    expect(header.cwd).toBe('/test') // 继承源 cwd
    expect(header.parentSession).toBe(sourceFile) // 指回源文件
  })

  it('源文件不存在时报错', async () => {
    const missing = join(sourceDir, 'no-such.jsonl')
    await expect(createForkedSessionFile(missing, 'a1', true, targetDir))
      .rejects.toThrow(/source session file not found/)
  })

  it('源文件无 session header 时报错', async () => {
    // 只有 message entry，没有 session header
    await writeFile(sourceFile, JSON.stringify({ type: 'message', id: 'x', parentId: null, message: { role: 'user', content: [] } }) + '\n')
    await expect(createForkedSessionFile(sourceFile, 'x', true, targetDir))
      .rejects.toThrow(/no valid session header/)
  })

  it('forkEntryId 在树中找不到时报错', async () => {
    await writeSourceJSONL()
    await expect(createForkedSessionFile(sourceFile, 'nonexistent-id', true, targetDir))
      .rejects.toThrow(/not found in session tree/)
  })

  it('保留 fork 点是 root 链头（mc1）时正确截断', async () => {
    await writeSourceJSONL()
    // fork 到 mc1（最早的 entry，includeFrom=true）→ 只保留 mc1（header 的 id 是新 session id，不算 entry）
    const { filePath } = await createForkedSessionFile(sourceFile, 'mc1', true, targetDir)
    const entries = await readForked(filePath)
    // 排除 session header（type==='session'），只看业务 entry id
    const ids = entries.filter((e) => e.type !== 'session' && typeof e.id === 'string').map((e) => e.id as string)
    expect(ids).toEqual(['mc1'])
  })
})

// ── 盲区 1：streaming 中 fork 的 JSONL 竞态 ──────────────────────────────
// 场景：源 session 正在 streaming，pi 增量写入 JSONL 时末行可能不完整（JSON 被截断）。
// 若此刻触发 fork（用户在 streaming 中点 fork），createForkedSessionFile 读到的源文件
// 末行是残行。parseJsonl 静默跳过残行（不崩溃），但残行对应的 entry 不进 fork 结果。
// 验证：fork 成功（不抛错）+ 残行 entry 静默丢失（不出现在 fork 文件中）。
// 回归防护：若某天 parseJsonl 改成抛错或 createForkedSessionFile 加严格校验，此用例会 fail 提示。
describe('createForkedSessionFile · streaming JSONL 竞态（末行残行静默丢失）', () => {
  let srcDir: string
  let tgtDir: string
  let src: string

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'fork-race-src-'))
    tgtDir = await mkdtemp(join(tmpdir(), 'fork-race-tgt-'))
    src = join(srcDir, 'streaming.jsonl')
  })
  afterEach(async () => {
    await Promise.all([rm(srcDir, { recursive: true, force: true }), rm(tgtDir, { recursive: true, force: true })])
  })

  it('末行 JSON 被截断时 fork 不崩溃，截断的 entry 不出现在 fork 文件中', async () => {
    // 模拟 streaming：前 3 条完整行（header + u1 + a1）+ 第 4 行残行（a2 的 JSON 被切断，缺右花括号）。
    // 残行 a2 是 a1 的下一条 assistant（不在 fork 路径上——fork 点是 a1）。
    const fullLines = [
      { type: 'session', version: 3, id: 'src-stream', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ].map((l) => JSON.stringify(l)).join('\n')
    // 残行：a2 的 JSON 写到一半被切断（合法 JSON 前缀，但缺闭合 → parse 失败）
    const truncatedLine = '\n{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-07-07T01:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"streaming'
    await writeFile(src, fullLines + truncatedLine)

    // fork 到 a1（含）——残行 a2 不在路径上，应静默丢失，不崩溃
    const { filePath } = await createForkedSessionFile(src, 'a1', true, tgtDir)

    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)

    // 保留 header（新 id）+ u1 + a1
    expect(ids).toContain('u1')
    expect(ids).toContain('a1')
    // 残行 a2 不在 fork 结果（静默丢失验证）
    expect(ids).not.toContain('a2')
  })

  it('残行是 fork 点的直接子且不在路径上时不阻断 fork（路径截断于 fork 点）', async () => {
    // 变体：残行 a2 的 parentId 指向 a1（fork 点），但因残行被跳过，a2 不进 entryById。
    // fork 点 a1 的 parentId=u1 正常回溯（与 a2 无关），fork 仍成功含 u1/a1。
    const fullLines = [
      { type: 'session', version: 3, id: 'src-stream2', timestamp: '2026-07-07T02:00:00.000Z', cwd: '/test' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T02:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T02:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
    ].map((l) => JSON.stringify(l)).join('\n')
    // 残行：a2 parent 指向 a1，JSON 截断（缺右括号）
    const truncated = '\n{"type":"message","id":"a2","parentId":"a1","timestamp":"x"'
    await writeFile(src, fullLines + truncated)

    const { filePath } = await createForkedSessionFile(src, 'a1', true, tgtDir)
    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)
    expect(ids).toContain('a1')
    expect(ids).not.toContain('a2')
  })
})

// ── 盲区 2（runtime 部分）：fork 失败路径 ────────────────────────────────
// 源文件不存在 / forkEntryId 在源中不存在 → createForkedSessionFile 抛错。
// 上层 forkSession 据此抛错，调用方 catch 做 toast（renderer 侧 fork-entry-behavior 补 W2 路径）。
describe('createForkedSessionFile · 失败路径（源缺失 / fork 点不存在）', () => {
  let srcDir: string
  let tgtDir: string

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'fork-fail-src-'))
    tgtDir = await mkdtemp(join(tmpdir(), 'fork-fail-tgt-'))
  })
  afterEach(async () => {
    await Promise.all([rm(srcDir, { recursive: true, force: true }), rm(tgtDir, { recursive: true, force: true })])
  })

  it('源文件不存在 → 抛错（含 source session file not found）', async () => {
    const missing = join(srcDir, 'no-such.jsonl')
    await expect(createForkedSessionFile(missing, 'a1', true, tgtDir))
      .rejects.toThrow(/source session file not found/)
  })

  it('forkEntryId 在源 session 树中不存在 → 抛错（含 not found in session tree）', async () => {
    const src = join(srcDir, 'has-messages.jsonl')
    await writeFile(src, [
      { type: 'session', version: 3, id: 'src', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    // ghost-id 不在树中
    await expect(createForkedSessionFile(src, 'ghost-id', true, tgtDir))
      .rejects.toThrow(/not found in session tree/)
  })
})

// ── 盲区 3：多级 fork parentSession 透传（W3 修复回归防护） ───────────────
// 场景：A → B → C 三级 fork。
//   B 由 A fork 出：B.header.parentSession = A.path（直接父级 = A）
//   C 由 B fork 出：C.header.parentSession 应 = B.path（直接父级 = B），不能透传成 A.path（祖父）。
// W3 修复：parentSession 指向直接父级（源文件路径），不透传源 header 的 parentSession（那是祖父）。
// 回归防护：若 W3 回退（透传源的 parentSession），C.parentSession 会错误指向 A.path，此用例 fail。
describe('createForkedSessionFile · 多级 fork parentSession 指向直接父级（W3）', () => {
  let dir: string

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fork-multi-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('A→B→C 三级 fork：C.parentSession = B.path（直接父级），不透传成 A.path', async () => {
    // ── A：顶层 session（无 parentSession）──
    const aFile = join(dir, 'A.jsonl')
    await writeFile(aFile, [
      { type: 'session', version: 3, id: 'sess-A', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'A 的提问' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'A 的回复' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')

    // ── B：从 A fork（fork 点 a1）──
    const { filePath: bFile } = await createForkedSessionFile(aFile, 'a1', true, dir)
    // B.parentSession 应 = A.path（直接父级）
    const bEntries = await readForked(bFile)
    const bHeader = bEntries[0]
    expect(bHeader.parentSession).toBe(aFile)

    // ── C：从 B fork（fork 点 B 内的 a1，被透传保留）──
    const { filePath: cFile } = await createForkedSessionFile(bFile, 'a1', true, dir)
    const cEntries = await readForked(cFile)
    const cHeader = cEntries[0]
    // 关键断言（W3）：C.parentSession = B.path（直接父级），不是 A.path（祖父）
    expect(cHeader.parentSession).toBe(bFile)
    expect(cHeader.parentSession).not.toBe(aFile)
  })
})
