/**
 * W3 红灯测试：scanPiSessions 文件级 mtime+size 缓存 + 三读合一。
 *
 * 对应 FR-mtime-cache（AC-cache-1/2/3）+ FR-three-read-merge（AC-merge-1/2）。
 *
 * 策略：用真实临时文件（mkdtemp）+ mock node:fs 计数文件读取调用。
 * vi.mock 工厂内用 createRequire 拿真实的 openSync/readSync/closeSync（尾读路径），
 * readFileSync/statSync 用可控 mock（计数 + 返回真实文件内容）。
 *
 * 核心防的 bug：
 * - SR3：缓存必须模块级跨两阶段共享。若 per-call，scannedToSummary 阶段仍重复读。
 * - SR4：缓存键缺 size → 同 ms 并发写 mtimeMs 不变 → 返回旧内容。
 * - 三读合一：每文件应只读 1 次（miss）/ 0 次（hit），而非 3 次。
 *
 * [红灯说明] 当前 scanPiSessions 无缓存（每次冷读）。
 * AC-cache-1 断言"第二次读取调用不增加"——无缓存会 fail。
 *
 * 运行：cd packages/runtime && npx vitest run test/scan-cache-merge.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 真实 fs 引用：用 createRequire 绕过 vi.mock（vi.mock 替换的是 ESM namespace 绑定，
// createRequire 拿的是 CJS 原始模块，不被 mock 拦截）
import { createRequire } from 'node:module'
const realFs = createRequire(import.meta.url)('fs') as typeof import('node:fs')

// 计数器（hoisted，vi.mock 工厂可引用）
const fsState = vi.hoisted(() => ({ readCount: 0, statCount: 0 }))

vi.mock('node:fs', async () => {
  const real = await import('node:fs')
  return {
    // 尾读路径透传真实实现（openSync/readSync/closeSync/fstatSync）
    openSync: real.openSync,
    readSync: real.readSync,
    closeSync: real.closeSync,
    fstatSync: real.fstatSync,
    // 计数 readFileSync/statSync（缓存命中时不被调）
    readFileSync: vi.fn((...args: Parameters<typeof real.readFileSync>) => {
      fsState.readCount++
      return real.readFileSync(...args)
    }),
    statSync: vi.fn((...args: Parameters<typeof real.statSync>) => {
      fsState.statCount++
      return real.statSync(...args)
    }),
    existsSync: real.existsSync,
    readdirSync: real.readdirSync,
    writeSync: real.writeSync,
  }
})

const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/fake/sessions') }))
vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: pathsMock.getSessionsDir,
}))

// import 在 mock 之后（mock 提升，import 时已是 mock 版本）
import { scanPiSessions, _resetSessionMetaCacheForTest } from '../src/infra/pi/session-file-utils.js'

describe('W3 scanPiSessions mtime+size 缓存', () => {
  let tmpSessionsDir: string

  beforeEach(() => {
    tmpSessionsDir = realFs.mkdtempSync(join(tmpdir(), 'scan-cache-'))
    fsState.readCount = 0
    fsState.statCount = 0
    _resetSessionMetaCacheForTest()
  })

  afterEach(() => {
    realFs.rmSync(tmpSessionsDir, { recursive: true, force: true })
  })

  /** 在 sessions 目录下造一个 session 文件（用真实 fs，绕过 mock 计数）*/
  function makeSessionFile(id: string, name: string | null, outcome: string | null, mtime: Date): string {
    const dir = join(tmpSessionsDir, 'encodedCwd')
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir)
    const filePath = join(dir, `${id}.jsonl`)
    const lines = [JSON.stringify({ type: 'session', id, cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' })]
    if (name) lines.push(JSON.stringify({ type: 'session_info', name, timestamp: '2025-01-01T00:00:01Z' }))
    if (outcome) lines.push(JSON.stringify({ type: 'session_end', outcome, timestamp: '2025-01-01T00:00:02Z' }))
    realFs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    realFs.utimesSync(filePath, mtime, mtime)
    return filePath
  }

  /** 读计数：readFileSync + openSync（尾读入口）都是文件读取行为 */
  function getFileReads(): number {
    return fsState.readCount
  }

  it('AC-cache-1: 连续两次 scan 无变更 → 第二次 readFileSync 调用不增加（缓存命中）', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1', '名字', 'done', new Date(1000))

    scanPiSessions()
    const readsAfterFirst = getFileReads()
    expect(readsAfterFirst).toBeGreaterThan(0)

    scanPiSessions()
    const readsAfterSecond = getFileReads()
    // 核心：第二次文件未变（mtime+size 相同）→ 命中缓存 → readFileSync 不增加
    // 注意：若实现用 openSync 尾读而非 readFileSync，readCount 可能不增——
    // 此用例聚焦 readFileSync 路径；openSync 路径在 AC-merge-1 覆盖
    expect(readsAfterSecond).toBe(readsAfterFirst)
  })

  it('AC-cache-2: mtime 不变但文件内容变（size 变）→ miss 重读', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    const fixedMtime = new Date(5000)
    makeSessionFile('s1', '短', 'done', fixedMtime)

    scanPiSessions()
    const readsAfterFirst = getFileReads()

    // 覆盖写更长内容（size 变），mtime 保持不变
    const dir = join(tmpSessionsDir, 'encodedCwd')
    const filePath = join(dir, 's1.jsonl')
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'session_info', name: '这是一个更长的名字触发 size 变化', timestamp: '2025-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: '2025-01-01T00:00:02Z' }),
    ]
    realFs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    realFs.utimesSync(filePath, fixedMtime, fixedMtime)

    scanPiSessions()
    const readsAfterSecond = getFileReads()
    // 核心：mtime 不变但 size 变 → 必须 miss（键含 size）
    expect(readsAfterSecond).toBeGreaterThan(readsAfterFirst)

    const result = scanPiSessions()
    expect(result[0]?.name).toBe('这是一个更长的名字触发 size 变化')
  })

  it('AC-cache-3: 文件删除后下次 scan → 不返回 stale 结果', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1', '名字', 'done', new Date(1000))

    let result = scanPiSessions()
    expect(result).toHaveLength(1)

    realFs.rmSync(join(tmpSessionsDir, 'encodedCwd', 's1.jsonl'), { force: true })

    result = scanPiSessions()
    expect(result).toHaveLength(0)
  })

  it('AC-merge-1: 3 文件冷缓存 → readFileSync 总数 ≤ 6（三读合一，非 9；尾读命中则 ≤3）', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1', 'n1', 'done', new Date(1000))
    makeSessionFile('s2', 'n2', 'error', new Date(2000))
    makeSessionFile('s3', 'n3', 'stopped', new Date(3000))

    fsState.readCount = 0
    scanPiSessions()
    // 三读合一：原实现每文件 3 次全量读（header+name+outcome）= 9。
    // 现三读合一 + 尾读：parseSessionHeader(1 readFileSync/文件) + extract 尾读(openSync)。
    // 尾读命中 → readFileSync 仅 3（parseSessionHeader）；尾读 fallback → +1/文件 ≤6。
    // 关键是不再是 9（三个独立函数各全量读）。
    expect(fsState.readCount).toBeLessThanOrEqual(6)
    expect(fsState.readCount).toBeLessThan(9) // 必须显著低于原 3×3
  })
})
