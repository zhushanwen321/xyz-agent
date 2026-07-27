/**
 * preset sidecar IO 单测（wave2）。
 *
 * 覆盖：
 * - persistPresetBinding：写入 / 文件守卫（规则#6）/ 缓存失效
 * - readPresetBinding：正例 / ENOENT / JSON 畸形 / 类型守卫
 * - scanSessionMeta 四读合一：launchPresetId 合并进 meta + 缓存命中
 *
 * 策略：真实 mkdtemp 临时目录 + 真实 fs（参考 scan-cache-merge.test.ts 范式）。
 * 缓存命中验证用 vi.mock node:fs 计数 readFileSync（仅 tc8）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// 真实 fs 引用：用 createRequire 绕过 vi.mock（vi.mock 替换的是 ESM namespace 绑定，
// createRequire 拿的是 CJS 原始模块，不被 mock 拦截）
const realFs = createRequire(import.meta.url)('fs') as typeof import('node:fs')

// 计数器（hoisted，vi.mock 工厂可引用）
const fsState = vi.hoisted(() => ({ readCount: 0 }))

vi.mock('node:fs', async () => {
  const real = await import('node:fs')
  return {
    // 尾读路径透传真实实现
    openSync: real.openSync,
    readSync: real.readSync,
    closeSync: real.closeSync,
    fstatSync: real.fstatSync,
    // 计数 readFileSync（缓存命中时不被调）
    readFileSync: vi.fn((...args: Parameters<typeof real.readFileSync>) => {
      fsState.readCount++
      return real.readFileSync(...args)
    }),
    statSync: real.statSync,
    existsSync: real.existsSync,
    readdirSync: real.readdirSync,
    writeSync: real.writeSync,
    // atomicWrite 用的真实实现（sidecar 原子写）
    writeFileSync: real.writeFileSync,
    renameSync: real.renameSync,
  }
})

const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/fake/sessions') }))
vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: pathsMock.getSessionsDir,
}))

// import 在 mock 之后
import {
  persistPresetBinding,
  readPresetBinding,
  presetSidecarPath,
  scanPiSessions,
  _resetSessionMetaCacheForTest,
} from '../src/infra/pi/session-file-utils.js'

describe('presetSidecarPath helper · S-RT-3', () => {
  it('S-RT-3: presetSidecarPath 在 filePath 后追加 .preset.json 后缀', () => {
    expect(presetSidecarPath('/tmp/sessions/abc.jsonl')).toBe('/tmp/sessions/abc.jsonl.preset.json')
  })

  it('S-RT-3: persistPresetBinding 写入的路径等于 presetSidecarPath(filePath)', () => {
    const tmp = realFs.mkdtempSync(join(tmpdir(), 'sidecar-path-'))
    try {
      const filePath = join(tmp, 's9.jsonl')
      realFs.writeFileSync(filePath,
        JSON.stringify({ type: 'session', id: 's9', cwd: '/p', timestamp: '2025-01-01T00:00:00Z' }) + '\n',
        'utf-8',
      )
      persistPresetBinding(filePath, 'builtin:full')
      // 验证写入的 sidecar 路径就是 helper 计算的路径
      expect(realFs.existsSync(presetSidecarPath(filePath))).toBe(true)
      expect(readPresetBinding(filePath)).toBe('builtin:full')
    } finally {
      realFs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('preset sidecar IO', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(join(tmpdir(), 'preset-sidecar-'))
    fsState.readCount = 0
    _resetSessionMetaCacheForTest()
  })

  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 造一个真实 session JSONL 文件 */
  function makeSessionFile(id: string): string {
    const filePath = join(tmpDir, `${id}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'session', id, cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    realFs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    return filePath
  }

  // ── persistPresetBinding ──

  it('tc1: persistPresetBinding 文件存在时写入 .preset.json sidecar', () => {
    const filePath = makeSessionFile('s1')
    persistPresetBinding(filePath, 'builtin:full')

    const sidecarPath = filePath + '.preset.json'
    expect(realFs.existsSync(sidecarPath)).toBe(true)
    const content = JSON.parse(realFs.readFileSync(sidecarPath, 'utf-8'))
    expect(content).toEqual({ presetId: 'builtin:full', version: 1 })
  })

  it('tc2: persistPresetBinding 文件不存在时跳过（规则 #6，绝不创建文件）', () => {
    const filePath = join(tmpDir, 'nonexistent.jsonl')
    expect(realFs.existsSync(filePath)).toBe(false)

    persistPresetBinding(filePath, 'builtin:full')

    // 既不创建 JSONL，也不创建 sidecar
    expect(realFs.existsSync(filePath)).toBe(false)
    expect(realFs.existsSync(filePath + '.preset.json')).toBe(false)
  })

  it('tc3: persistPresetBinding 写入后失效 sessionMetaCache', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpDir)
    const filePath = makeSessionFile('s1')
    // 注意：scanPiSessions 要求文件在 sessionsDir 下且按 cwd 分组或顶层；
    // 此处直接造顶层 .jsonl，scanPiSessions 会扫到。
    realFs.utimesSync(filePath, new Date(1000), new Date(1000))

    // 第一次 scan 填充缓存（会读 preset sidecar，此时无 sidecar → launchPresetId undefined）
    let result = scanPiSessions()
    expect(result).toHaveLength(1)
    expect(result[0]?.launchPresetId).toBeUndefined()
    const readsAfterFirst = fsState.readCount
    expect(readsAfterFirst).toBeGreaterThan(0)

    // 第二次 scan 命中缓存（文件未变）→ readCount 不增加
    result = scanPiSessions()
    expect(fsState.readCount).toBe(readsAfterFirst)

    // persistPresetBinding 写 sidecar + 失效缓存
    persistPresetBinding(filePath, 'builtin:full')

    // 第三次 scan：缓存已失效 → 重新读 → launchPresetId 更新
    result = scanPiSessions()
    expect(result[0]?.launchPresetId).toBe('builtin:full')
    expect(fsState.readCount).toBeGreaterThan(readsAfterFirst)
  })

  // ── readPresetBinding ──

  it('tc4: readPresetBinding sidecar 存在且合法 → 返回 presetId', () => {
    const filePath = makeSessionFile('s2')
    realFs.writeFileSync(
      filePath + '.preset.json',
      JSON.stringify({ presetId: 'builtin:readonly', version: 1 }),
      'utf-8',
    )

    expect(readPresetBinding(filePath)).toBe('builtin:readonly')
  })

  it('tc5: readPresetBinding sidecar 不存在 → 返回 undefined（容错）', () => {
    const filePath = makeSessionFile('s3')
    // 不写 sidecar
    expect(realFs.existsSync(filePath + '.preset.json')).toBe(false)

    expect(readPresetBinding(filePath)).toBeUndefined()
  })

  it('tc6: readPresetBinding JSON 畸形 → 返回 undefined（容错）', () => {
    const filePath = makeSessionFile('s4')
    realFs.writeFileSync(filePath + '.preset.json', '{broken', 'utf-8')

    expect(readPresetBinding(filePath)).toBeUndefined()
  })

  it('tc7: readPresetBinding presetId 非字符串 → 返回 undefined（类型守卫）', () => {
    const filePath = makeSessionFile('s5')
    realFs.writeFileSync(
      filePath + '.preset.json',
      JSON.stringify({ presetId: 123, version: 1 }),
      'utf-8',
    )

    expect(readPresetBinding(filePath)).toBeUndefined()
  })

  // ── scanSessionMeta 四读合一 ──

  it('tc8: scanSessionMeta 四读合一：launchPresetId 合并进 meta 且享受缓存', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpDir)
    const filePath = makeSessionFile('s6')
    realFs.writeFileSync(
      filePath + '.preset.json',
      JSON.stringify({ presetId: 'builtin:full', version: 1 }),
      'utf-8',
    )
    realFs.utimesSync(filePath, new Date(2000), new Date(2000))

    // 第一次 scan：miss → 读全部（含 sidecar）→ launchPresetId 填充
    let result = scanPiSessions()
    expect(result).toHaveLength(1)
    expect(result[0]?.launchPresetId).toBe('builtin:full')
    const readsAfterFirst = fsState.readCount
    expect(readsAfterFirst).toBeGreaterThan(0)

    // 第二次 scan：命中缓存（mtime/size 不变）→ readCount 不增加
    result = scanPiSessions()
    expect(result[0]?.launchPresetId).toBe('builtin:full')
    expect(fsState.readCount).toBe(readsAfterFirst)
  })
})
