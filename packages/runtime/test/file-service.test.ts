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
 * - AC-2.x ignore 标记：.gitignore 命中节点始终保留并标 ignored=true（前端按开关过滤）
 * - readFile 截断（stat.size > MAX_FILE_SIZE → truncated=true）
 *
 * mock 策略（test-strategy §2.2，照 git-service.test.ts 范式）：
 * IFileExecutor + ISessionService 构造注入。不起真实 fs。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/file-service.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FileService, READ_TIMEOUT_MS, MAX_FILE_SIZE, MAX_SEARCH_RESULTS, type FileServiceOptions } from '../src/services/file-service.js'
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

  it('AC-2.x ignore 标记：.gitignore 命中节点始终保留并标 ignored=true（前端按开关过滤）', async () => {
    executor.readFile.mockResolvedValueOnce('node_modules\n') // /repo/.gitignore
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'node_modules', type: 'dir' },
        { name: 'src', type: 'dir' },
        { name: 'package.json', type: 'file', size: 10 },
      ] as FsEntry[])
      // 两个 dir 都展开一级子（node_modules 不再被丢弃，仍下钻拿一级子）
      .mockResolvedValueOnce([] as FsEntry[]) // node_modules 子
      .mockResolvedValueOnce([{ name: 'index.ts', type: 'file', size: 5 }] as FsEntry[]) // src 子

    const tree = await svc().listTree('s1')

    // 全部保留（node_modules 不再被过滤）
    expect(tree.map((n) => n.name).sort()).toEqual(['node_modules', 'package.json', 'src'])
    const nm = tree.find((n) => n.name === 'node_modules')
    const src = tree.find((n) => n.name === 'src')
    const pkg = tree.find((n) => n.name === 'package.json')
    expect(nm).toBeDefined()
    expect(nm!.ignored).toBe(true) // .gitignore 命中 → 标记 ignored=true
    expect(src).toBeDefined()
    expect(src!.ignored).toBeUndefined() // 非 ignore 节点不标记
    expect(pkg!.ignored).toBeUndefined()
  })

  it('AC-2.x 排序：dir 在前、同类型内 name 降序（listTree 顶层 + 子层一致）', async () => {
    // 顶层混合 dir/file + 同类型多元素，验证排序规则全树一致
    executor.readFile.mockResolvedValueOnce('') // /repo/.gitignore 空（不过滤）
    executor.listDir
      // 顶层：故意喂无序 + 大小写混合（z.ts/a.md/Bdir/adir）
      .mockResolvedValueOnce([
        { name: 'z.ts', type: 'file', size: 1 },
        { name: 'Bdir', type: 'dir' },
        { name: 'a.md', type: 'file', size: 1 },
        { name: 'adir', type: 'dir' },
      ] as FsEntry[])
      // Bdir 展开一级子（验证子层也排序）
      .mockResolvedValueOnce([
        { name: 'y.ts', type: 'file', size: 1 },
        { name: 'x.ts', type: 'file', size: 1 },
      ] as FsEntry[])
      // adir 展开一级子（验证子层 dir/file 混排）
      .mockResolvedValueOnce([
        { name: 'inner.ts', type: 'file', size: 1 },
        { name: 'sub', type: 'dir' },
      ] as FsEntry[])

    const tree = await svc().listTree('s1')

    // 顶层：dir 在前（降序 adir > Bdir），file 在后（降序 z.ts > a.md）
    expect(tree.map((n) => n.name)).toEqual(['adir', 'Bdir', 'z.ts', 'a.md'])
    // Bdir 子层（纯 file，降序 y.ts > x.ts）
    expect(tree[1].children?.map((c) => c.name)).toEqual(['y.ts', 'x.ts'])
    // adir 子层（dir 在前 sub，file 在后 inner.ts）
    expect(tree[0].children?.map((c) => c.name)).toEqual(['sub', 'inner.ts'])
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
    // 排序后 dir 在前：sub(dir) 排到 main.ts(file) 之前
    expect(nodes[0]).toMatchObject({ path: 'src/sub', type: 'dir' })
    expect(nodes[1]).toMatchObject({ path: 'src/main.ts', type: 'file', size: 50 })
    // 单层：不递归，dir 子节点无 children（懒加载未展开）
    expect(nodes[0].children).toBeUndefined()
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

  it('相对路径越界（../etc/secret）→ FileError(out_of_cwd)，不触达 executor', async () => {
    await expect(svc().readFile('s1', '../etc/secret')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.stat).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
  })

  it('绝对路径越界（/etc/passwd）→ FileError(out_of_cwd)，不触达 executor', async () => {
    await expect(svc().readFile('s1', '/etc/passwd')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.stat).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
  })

  it('家目录展开越界（~/../etc/secret）→ FileError(out_of_cwd)，不触达 executor', async () => {
    await expect(svc().readFile('s1', '~/../etc/secret')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.stat).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
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

describe('FileService.readFile path resolution (安全守门: cwd 之外一律拒绝)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionService.getSummary.mockReturnValue({ cwd: '/project' })
    executor.stat = vi.fn().mockResolvedValue({ type: 'file', size: 0 })
    executor.readFile = vi.fn().mockResolvedValue('content')
  })

  it('U1: cwd 下相对路径基于 cwd resolve，正常读取', async () => {
    await svc().readFile('s1', 'README.md')
    expect(executor.readFile).toHaveBeenCalledWith('/project/README.md')
  })

  it('U2: cwd 外绝对路径（/var/tmp/...）→ FileError(out_of_cwd)，不触达 executor', async () => {
    await expect(svc().readFile('s1', '/var/tmp/absolute.md')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.stat).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
  })

  it('U3: ~ 展开（~/notes.md）仍受 cwd 守门约束，越界 → FileError(out_of_cwd)', async () => {
    await expect(svc().readFile('s1', '~/notes.md')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.stat).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
  })

  it('U4: 绝对路径 /etc/passwd 越界 → FileError(out_of_cwd)，不触达 executor', async () => {
    await expect(svc().readFile('s1', '/etc/passwd')).rejects.toMatchObject({
      name: 'FileError',
      code: 'out_of_cwd',
    })
    expect(executor.stat).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
  })
})

describe('FileService.searchFiles (#composer 文件候选全量递归)', () => {
  /**
   * searchFiles 与 listTree 的关键差异：
   * - 全量递归（listTree 仅 2 层），深度上限 8（根 cwd=depth 0）
   * - 返回扁平 FileNode[]（非嵌套树，给候选列表用）
   * - per-directory try/catch 容错（单子目录 EACCES 跳过不中断，listTree 则整体 reject）
   * - visited Set 防 symlink 成环
   * - 内建 ignore（node_modules 等）独立短路，不可被 .gitignore ! 覆盖
   * - DoS 防护上限 MAX_SEARCH_RESULTS（5000）
   */

  it('U1 正常：递归展开多层（path 相对 cwd，扁平数组）', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT')) // 无 .gitignore
    executor.listDir
      // 顶层 /repo
      .mockResolvedValueOnce([
        { name: 'src', type: 'dir' },
        { name: 'README.md', type: 'file', size: 100 },
      ] as FsEntry[])
      // /repo/src
      .mockResolvedValueOnce([{ name: 'index.ts', type: 'file', size: 50 }] as FsEntry[])

    const files = await svc().searchFiles('s1')

    // 扁平数组含 3 项（src 目录壳 + README.md + src/index.ts）
    expect(files).toHaveLength(3)
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['README.md', 'src', 'src/index.ts'])
    const srcNode = files.find((f) => f.path === 'src')
    expect(srcNode?.type).toBe('dir')
  })

  it('U2 内建 ignore：node_modules 即使无 .gitignore 也被短路', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT')) // 无 .gitignore
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'node_modules', type: 'dir' },
        { name: 'src', type: 'dir' },
      ] as FsEntry[])
      // node_modules 被内建 ignore 短路，不展开；仅 src 展开
      .mockResolvedValueOnce([] as FsEntry[])

    const files = await svc().searchFiles('s1')

    // 不含任何 node_modules 前缀项
    expect(files.every((f) => !f.path.startsWith('node_modules'))).toBe(true)
    // node_modules 未触达其 listDir（内建 ignore 在递归前短路）
    expect(executor.listDir).toHaveBeenCalledTimes(2) // 顶层 + src
  })

  it('U3 .gitignore 含 dist/ → matchPath 剪枝不下钻', async () => {
    executor.readFile.mockResolvedValueOnce('dist/\n') // /repo/.gitignore
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'dist', type: 'dir' },
        { name: 'src', type: 'dir' },
      ] as FsEntry[])
      // dist 被 ignore 剪枝不下钻；仅 src 展开
      .mockResolvedValueOnce([] as FsEntry[])

    const files = await svc().searchFiles('s1')

    expect(files.every((f) => !f.path.startsWith('dist'))).toBe(true)
    // dist 未下钻（matchPath 剪枝）
    expect(executor.listDir).toHaveBeenCalledTimes(2)
  })

  it('U4 深度上限：第 8 层节点返回，第 9 层不递归', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
    // 构造 8 层嵌套 a/b/c/d/e/f/g/h，每层 1 个 dir
    // 顶层 /repo: [a]
    // /repo/a: [b], /repo/a/b: [c], ... /repo/a/b/c/d/e/f/g: [h]
    // /repo/a/b/c/d/e/f/g/h: [leaf.txt]（第 9 层，不应出现）
    executor.listDir
      .mockResolvedValueOnce([{ name: 'a', type: 'dir' }] as FsEntry[]) // depth0 顶层
      .mockResolvedValueOnce([{ name: 'b', type: 'dir' }] as FsEntry[]) // depth1 a
      .mockResolvedValueOnce([{ name: 'c', type: 'dir' }] as FsEntry[]) // depth2 b
      .mockResolvedValueOnce([{ name: 'd', type: 'dir' }] as FsEntry[]) // depth3 c
      .mockResolvedValueOnce([{ name: 'e', type: 'dir' }] as FsEntry[]) // depth4 d
      .mockResolvedValueOnce([{ name: 'f', type: 'dir' }] as FsEntry[]) // depth5 e
      .mockResolvedValueOnce([{ name: 'g', type: 'dir' }] as FsEntry[]) // depth6 f
      .mockResolvedValueOnce([{ name: 'h', type: 'dir' }] as FsEntry[]) // depth7 g
    // 注意：h 在 depth8，h 本身返回但不再下钻其子（leaf.txt 不出现）

    const files = await svc().searchFiles('s1')

    const paths = files.map((f) => f.path)
    // 含 a..h 的路径前缀
    expect(paths).toContain('a')
    expect(paths).toContain('a/b/c/d/e/f/g/h')
    // 第 9 层 leaf.txt 不出现
    expect(paths.some((p) => p.includes('leaf.txt'))).toBe(false)
  })

  it('U5 深度上限：第 8 层是目录时返回壳但不展开（listDir 未调用）', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
    // 7 层到 g（depth7），g 下 h_dir（depth8，是 dir）
    executor.listDir
      .mockResolvedValueOnce([{ name: 'a', type: 'dir' }] as FsEntry[]) // depth0
      .mockResolvedValueOnce([{ name: 'b', type: 'dir' }] as FsEntry[]) // depth1
      .mockResolvedValueOnce([{ name: 'c', type: 'dir' }] as FsEntry[]) // depth2
      .mockResolvedValueOnce([{ name: 'd', type: 'dir' }] as FsEntry[]) // depth3
      .mockResolvedValueOnce([{ name: 'e', type: 'dir' }] as FsEntry[]) // depth4
      .mockResolvedValueOnce([{ name: 'f', type: 'dir' }] as FsEntry[]) // depth5
      .mockResolvedValueOnce([{ name: 'g', type: 'dir' }] as FsEntry[]) // depth6
      .mockResolvedValueOnce([{ name: 'h_dir', type: 'dir' }] as FsEntry[]) // depth7 g→h_dir(depth8)

    const files = await svc().searchFiles('s1')

    // h_dir 目录壳返回
    expect(files.map((f) => f.path)).toContain('a/b/c/d/e/f/g/h_dir')
    // h_dir 未被下钻（depth=8 守门，不再调 listDir）
    // 共 8 次 listDir：顶层 + a..g（7 次），h_dir 不调用
    expect(executor.listDir).toHaveBeenCalledTimes(8)
  })

  it('U6 session 不存在 → FileError(session_not_found)，不触达 executor', async () => {
    sessionService.getSummary.mockReturnValue(undefined)

    await expect(svc().searchFiles('s1')).rejects.toMatchObject({
      name: 'FileError',
      code: 'session_not_found',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('U7 单子目录 EACCES 容错：跳过该目录继续（不中断整体）', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'good', type: 'dir' },
        { name: 'locked', type: 'dir' },
      ] as FsEntry[])
      // good 可读
      .mockResolvedValueOnce([{ name: 'a.ts', type: 'file', size: 1 }] as FsEntry[])
      // locked 抛 EACCES
      .mockRejectedValueOnce(fsErr('EACCES'))

    const files = await svc().searchFiles('s1')

    // 整体 resolve 不抛错，good/a.ts 出现
    expect(files.map((f) => f.path)).toContain('good/a.ts')
    // locked 目录壳出现（顶层 entry 先 push 再尝试下钻），但其下子文件不出现（容错跳过）
    expect(files.map((f) => f.path)).toContain('locked')
    expect(files.every((f) => !f.path.startsWith('locked/'))).toBe(true)
  })

  /**
   * symlink 成环防护不在 service 层测——由 executor 层保证（fs-executor.ts Dirent.isDirectory()
   * 不 follow symlink，symlink 目录不会作为 dir 进入 FsEntry）。service 层靠深度上限 8
   * 作为递归硬限制（U4/U5 覆盖），无需 visited Set（service 层禁 import node:fs，无法 realpath）。
   */

  it('U9 空目录 → resolve []', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
    executor.listDir.mockResolvedValueOnce([] as FsEntry[])

    const files = await svc().searchFiles('s1')

    expect(files).toEqual([])
  })

  it('U10 DoS 上限：超过 MAX_SEARCH_RESULTS 文件截断到上限', async () => {
    executor.readFile.mockRejectedValueOnce(fsErr('ENOENT'))
    // 顶层超上限 100 个文件（引用常量，避免改上限时测试不同步）
    const many: FsEntry[] = Array.from({ length: MAX_SEARCH_RESULTS + 100 }, (_, i) => ({
      name: `f${i}.ts`,
      type: 'file' as const,
      size: 1,
    }))
    executor.listDir.mockResolvedValueOnce(many)

    const files = await svc().searchFiles('s1')

    expect(files).toHaveLength(MAX_SEARCH_RESULTS)
  })

  it('U11 内建 ignore 不可被 .gitignore ! 覆盖', async () => {
    // .gitignore 尝试用 !dist/keep.ts 取反，但内建 ignore 含 dist，独立关卡优先
    executor.readFile.mockResolvedValueOnce('!dist/keep.ts\n') // /repo/.gitignore
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'dist', type: 'dir' },
        { name: 'src', type: 'dir' },
      ] as FsEntry[])
      .mockResolvedValueOnce([] as FsEntry[]) // src 展开

    const files = await svc().searchFiles('s1')

    // dist/keep.ts 不出现（内建 ignore 独立短路，! 无法覆盖）
    expect(files.every((f) => !f.path.startsWith('dist'))).toBe(true)
  })

  it('U12 showIgnored=true：.gitignore 命中的文件标记 ignored=true 但不递归 ignore 目录', async () => {
    // composer 场景不传 showIgnored=true，但覆盖防御分支：true 时标记不递归
    executor.readFile.mockResolvedValueOnce('*.log\n') // /repo/.gitignore
    executor.listDir
      .mockResolvedValueOnce([
        { name: 'debug.log', type: 'file', size: 1 },
        { name: 'src', type: 'dir' },
      ] as FsEntry[])
      .mockResolvedValueOnce([] as FsEntry[]) // src 展开（非 ignore 目录正常递归）

    const files = await svc().searchFiles('s1', true)

    // debug.log 标记 ignored=true（显示模式保留+标记）
    const log = files.find((f) => f.path === 'debug.log')
    expect(log?.ignored).toBe(true)
  })
})
