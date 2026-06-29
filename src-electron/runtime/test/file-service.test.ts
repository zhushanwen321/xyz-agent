/**
 * FileService 单测（#2，T1.1-1.6 / T2.1 / T2.10 / AC-2.x / readFile 截断）。
 *
 * 覆盖：
 * - T1.1 首加载：顶层 + 顶层 dir 的一级子（path 相对 cwd，如 'src/main.ts'）
 * - T1.2 空目录 → []
 * - T1.3 越界（expandDir 绝对外部路径）→ FileError('out_of_cwd')
 * - T1.4 EACCES → FileError('permission_denied')
 * - T1.5 超时（fake timers，advanceTimersByTime）→ FileError('timeout')
 * - T1.6 session 不存在（getSummary=undefined）→ FileError('session_not_found')
 * - T2.1 expandDir 单层（不递归）
 * - T2.10 expandDir 越界（相对 ../）→ FileError('out_of_cwd')
 * - AC-2.x ignore 双模式：默认隐藏 / showIgnored=true 保留+标记 ignored=true
 * - readFile 截断（stat.size > MAX_FILE_SIZE → truncated=true）
 *
 * mock 策略（test-strategy §2.2，照 git-service.test.ts 范式）：
 * IFileExecutor + ISessionService 构造注入。不起真实 fs。
 *
 * 运行：cd src-electron/runtime && npx vitest run test/file-service.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FileService, READ_TIMEOUT_MS, MAX_FILE_SIZE, type FileServiceOptions } from '../src/services/file-service.js'
import { FileError } from '../src/services/file-error.js'
import type { IFileExecutor, FsEntry } from '../src/services/ports/file-executor.js'

const executor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
const sessionService = { getSummary: vi.fn() }

function svc(): FileService {
  return new FileService({
    sessionService: sessionService as unknown as FileServiceOptions['sessionService'],
    executor: executor as unknown as IFileExecutor,
  })
}

/** 拒绝（带 code）的 Error，模拟 node:fs/promises 的 errno 错误。 */
function fsErr(code: string): Error {
  return Object.assign(new Error(code), { code })
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionService.getSummary.mockReturnValue({ cwd: '/repo' })
})

describe('FileService.listTree (#2 首加载)', () => {
  it('T1.1 顶层 + 顶层 dir 的一级子（children path 相对 cwd，如 src/main.ts）', async () => {
    // loadMatcher 先 readFile('/repo/.gitignore') → 拒绝（无 .gitignore）
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'src', type: 'dir' },
        { name: 'index.ts', type: 'file', size: 100 },
      ] as FsEntry[])
      // src 子层（一级子）listDir('/repo/src')
      .mockResolvedValueOnce([{ name: 'main.ts', type: 'file', size: 50 }] as FsEntry[])

    const tree = await svc().listTree('s1')

    expect(tree).toHaveLength(2)
    // 顶层 file
    expect(tree[0]).toMatchObject({ path: 'src', name: 'src', type: 'dir' })
    expect(tree[1]).toMatchObject({ path: 'index.ts', name: 'index.ts', type: 'file', size: 100 })
    // src 的一级子 children
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children![0]).toMatchObject({
      path: 'src/main.ts',
      name: 'main.ts',
      type: 'file',
      size: 50,
    })
    // index.ts 是文件，无 children
    expect(tree[1].children).toBeUndefined()
  })

  it('T1.2 空目录 → listTree 返回 []', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
    executor.listDir.mockResolvedValueOnce([] as FsEntry[])

    const tree = await svc().listTree('s1')

    expect(tree).toEqual([])
  })

  it('T1.4 EACCES（listDir 权限拒绝）→ FileError(permission_denied)', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
    executor.listDir.mockRejectedValueOnce(fsErr('EACCES'))

    await expect(svc().listTree('s1')).rejects.toMatchObject({
      name: 'FileError',
      code: 'permission_denied',
    })
  })

  it('T1.5 超时（listDir 永不 resolve + fake timers）→ FileError(timeout)', async () => {
    vi.useFakeTimers()
    try {
      executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
      executor.listDir.mockImplementationOnce(() => new Promise<FsEntry[]>(() => {})) // 挂起

      const p = svc().listTree('s1')
      // 先挂 rejection handler（advanceTimersByTimeAsync 同步触发定时器 reject，
      // 需在 reject 发生前已挂 handler，否则 Node 报 unhandledRejection）
      const assertion = expect(p).rejects.toMatchObject({
        name: 'FileError',
        code: 'timeout',
      })
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('T1.6 session 不存在（getSummary=undefined）→ FileError(session_not_found)，不触达 executor', async () => {
    sessionService.getSummary.mockReturnValue(undefined)

    await expect(svc().listTree('s1')).rejects.toMatchObject({
      name: 'FileError',
      code: 'session_not_found',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('AC-2.x ignore 默认模式：.gitignore 含 node_modules → 默认隐藏（被过滤）', async () => {
    executor.readFile.mockResolvedValueOnce('node_modules\n') // /repo/.gitignore
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'node_modules', type: 'dir' },
        { name: 'src', type: 'dir' },
        { name: 'package.json', type: 'file', size: 10 },
      ] as FsEntry[])
      // node_modules 被过滤，不展开；src 展开
      .mockResolvedValueOnce([{ name: 'index.ts', type: 'file', size: 5 }] as FsEntry[])

    const tree = await svc().listTree('s1') // 默认 showIgnored=false

    // node_modules 被过滤（只剩 src + package.json）
    expect(tree.map((n) => n.name).sort()).toEqual(['package.json', 'src'])
    // 过滤的 node 不触达其 listDir（仅 src 触发 1 次子层）
    expect(executor.listDir).toHaveBeenCalledTimes(2)
    // 保留的节点不应带 ignored 标志（默认模式不标记）
    expect(tree.every((n) => n.ignored === undefined)).toBe(true)
  })

  it('AC-2.x ignore 显示模式：showIgnored=true → node_modules 保留且 ignored=true', async () => {
    executor.readFile.mockResolvedValueOnce('node_modules\n')
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'node_modules', type: 'dir' },
        { name: 'src', type: 'dir' },
      ] as FsEntry[])
      // 两个 dir 都展开一级子
      .mockResolvedValueOnce([] as FsEntry[])
      .mockResolvedValueOnce([] as FsEntry[])

    const tree = await svc().listTree('s1', true) // showIgnored=true

    const nm = tree.find((n) => n.name === 'node_modules')
    const src = tree.find((n) => n.name === 'src')
    expect(nm).toBeDefined()
    expect(nm!.ignored).toBe(true) // 保留并标记
    expect(src).toBeDefined()
    expect(src!.ignored).toBeUndefined() // 非 ignore 节点不标记
  })
})

describe('FileService.expandDir (#3 展开目录)', () => {
  it('T2.1 正常路径 → 单层 FileNode[]（不递归，子目录无 children）', async () => {
    // expandDir: loadMatcher 读 /repo/.gitignore + /repo/src/.gitignore（合并）
    executor.readFile
      .mockRejectedValueOnce(fsErr('ENOENT')) // /repo/.gitignore 无
      .mockRejectedValueOnce(fsErr('ENOENT')) // /repo/src/.gitignore 无
    executor.listDir.mockResolvedValueOnce([
      { name: 'main.ts', type: 'file', size: 50 },
      { name: 'sub', type: 'dir' },
    ] as FsEntry[])

    const nodes = await svc().expandDir('s1', 'src')

    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({ path: 'src/main.ts', type: 'file', size: 50 })
    expect(nodes[1]).toMatchObject({ path: 'src/sub', type: 'dir' })
    // 单层：不递归，dir 子节点无 children（懒加载未展开）
    expect(nodes[1].children).toBeUndefined()
    // listDir 以绝对路径调用（cwd 子树内）
    expect(executor.listDir).toHaveBeenCalledWith('/repo/src')
  })

  it('T2.10 expandDir 越界（相对 ../etc → resolve 出 cwd 外）→ FileError(out_of_cwd)', async () => {
    await expect(svc().expandDir('s1', '../etc')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('T1.3 expandDir 绝对外部路径（/etc/passwd）→ FileError(out_of_cwd)', async () => {
    await expect(svc().expandDir('s1', '/etc/passwd')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('expandDir 展开顶层 cwd（path=.）→ relParent 空，path=name', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT')) // 仅 /repo/.gitignore
    executor.listDir.mockResolvedValueOnce([
      { name: 'a.ts', type: 'file', size: 1 },
    ] as FsEntry[])

    const nodes = await svc().expandDir('s1', '.')

    expect(nodes[0]).toMatchObject({ path: 'a.ts', type: 'file', size: 1 })
  })

  it('expandDir 超时 → FileError(timeout)', async () => {
    vi.useFakeTimers()
    try {
      executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
      executor.listDir.mockImplementationOnce(() => new Promise<FsEntry[]>(() => {}))

      const p = svc().expandDir('s1', 'src')
      // 先挂 rejection handler 再 advance（同 T1.5，避免 unhandledRejection）
      const assertion = expect(p).rejects.toMatchObject({
        name: 'FileError',
        code: 'timeout',
      })
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('FileService.readFile (#7 截断 + 越界)', () => {
  it('小文件 → truncated=false，全文返回', async () => {
    executor.stat.mockResolvedValueOnce({ type: 'file', size: 10 })
    executor.readFile.mockResolvedValueOnce('hello world')

    const r = await svc().readFile('s1', 'a.txt')

    expect(r).toEqual({ content: 'hello world', truncated: false })
    expect(executor.readFile).toHaveBeenCalledWith('/repo/a.txt')
  })

  it('超大文件（size > MAX_FILE_SIZE）→ truncated=true，内容截断', async () => {
    const big = 'x'.repeat(MAX_FILE_SIZE + 100)
    executor.stat.mockResolvedValueOnce({ type: 'file', size: big.length })
    executor.readFile.mockResolvedValueOnce(big)

    const r = await svc().readFile('s1', 'big.log')

    expect(r.truncated).toBe(true)
    expect(r.content.length).toBe(MAX_FILE_SIZE)
    expect(r.content).toBe('x'.repeat(MAX_FILE_SIZE))
  })

  it('越界（../etc/secret）→ FileError(out_of_cwd)', async () => {
    await expect(svc().readFile('s1', '../etc/secret')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.stat).not.toHaveBeenCalled()
  })

  it('文件不存在（stat ENOENT）→ FileError(not_found)', async () => {
    executor.stat.mockRejectedValueOnce(fsErr('ENOENT'))

    await expect(svc().readFile('s1', 'nope.txt')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
  })

  it('权限拒绝（stat EACCES）→ FileError(permission_denied)', async () => {
    executor.stat.mockRejectedValueOnce(fsErr('EACCES'))

    await expect(svc().readFile('s1', 'secret.txt')).rejects.toMatchObject({
      name: 'FileError',
      code: 'permission_denied',
    })
  })

  it('session 不存在 → FileError(session_not_found)', async () => {
    sessionService.getSummary.mockReturnValue(undefined)
    await expect(svc().readFile('s1', 'a.txt')).rejects.toMatchObject({
      name: 'FileError',
      code: 'session_not_found',
    })
  })
})
