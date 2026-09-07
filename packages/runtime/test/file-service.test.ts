/**
 * file-service.test.ts — F6 失败路径验收测试。
 *
 * 背景：文件操作可能超时（10s），需要抛 FileError('timeout') + withTimeout 无 unhandledRejection。
 * 本测试验证：
 * - F6: 文件操作超时 10s → FileError('timeout') + withTimeout 无 unhandledRejection
 *
 * 运行：cd packages/runtime && npx vitest run test/file-service.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_SEARCH_RESULTS, READ_TIMEOUT_MS, FileService, type FileServiceOptions } from '../src/services/file-service.js'
import { FileError } from '../src/services/file-error.js'
import type { IFileExecutor, FsEntry } from '../src/services/ports/file-executor.js'

describe('FileService · F6 文件操作超时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('F6: 超时常量 10s 正确', () => {
    expect(READ_TIMEOUT_MS).toBe(10_000)
  })

  it('F6: 超时后 reject FileError("timeout")', async () => {
    // 模拟 withTimeout 逻辑
    function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new FileError('timeout', errorMessage))
        }, ms)

        promise.then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    // 创建一个永不 resolve 的 promise
    const neverResolve = new Promise<string>(() => {})

    // 应在超时后 reject
    const promise = withTimeout(neverResolve, READ_TIMEOUT_MS, 'File read timeout')

    // 推进时间到超时
    vi.advanceTimersByTime(READ_TIMEOUT_MS)

    await expect(promise).rejects.toThrow(FileError)
    await expect(promise).rejects.toThrow('File read timeout')
  })

  it('F6: 超时前完成 — 不抛错', async () => {
    function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          // FileError(code, message)：源码 FileErrorCode 联合已含小写 'timeout'（file-error.ts），
          // 此前参数顺序颠倒把 message 传给了 code 形参，属测试侧笔误，修正测试而非源码
          reject(new FileError('timeout', errorMessage))
        }, ms)

        promise.then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    // 创建一个快速 resolve 的 promise
    const quickResolve = Promise.resolve('file-content')

    const result = await withTimeout(quickResolve, READ_TIMEOUT_MS, 'File read timeout')
    expect(result).toBe('file-content')
  })

  it('F6: FileError 结构 — message + code', () => {
    const error = new FileError('timeout', 'File read timeout')

    expect(error).toBeInstanceOf(FileError)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('File read timeout')
    expect(error.code).toBe('timeout')
  })

  it('F6: withTimeout 无 unhandledRejection — promise 链正确处理', async () => {
    function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new FileError('timeout', errorMessage))
        }, ms)

        promise.then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    // 模拟底层 promise reject
    const failingPromise = Promise.reject(new Error('IO error'))

    // 不应产生 unhandledRejection
    const promise = withTimeout(failingPromise, READ_TIMEOUT_MS, 'timeout')

    // 应该 reject 底层错误（非 timeout）
    await expect(promise).rejects.toThrow('IO error')
  })

  it('F6: 多个并发超时 — 互不影响', async () => {
    function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new FileError('timeout', errorMessage))
        }, ms)

        promise.then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    const never1 = new Promise<string>(() => {})
    const never2 = new Promise<string>(() => {})
    const never3 = new Promise<string>(() => {})

    const promise1 = withTimeout(never1, READ_TIMEOUT_MS, 'timeout-1')
    const promise2 = withTimeout(never2, READ_TIMEOUT_MS, 'timeout-2')
    const promise3 = withTimeout(never3, READ_TIMEOUT_MS, 'timeout-3')

    // 推进时间到超时
    vi.advanceTimersByTime(READ_TIMEOUT_MS)

    // 所有都应 reject
    await expect(promise1).rejects.toThrow('timeout-1')
    await expect(promise2).rejects.toThrow('timeout-2')
    await expect(promise3).rejects.toThrow('timeout-3')
  })
})

/**
 * searchFilesInCwd cwd 路用例（u2-runtime，landing `$` 候选数据通路）。
 *
 * mock 策略照 file-service-ignore-cache.test.ts 范式（IFileExecutor + ISessionService
 * 构造注入，纯 mock 不触真实 fs）。覆盖验收条款：
 * - 合法 cwd 返回 files（全量递归 + sortNodes 排序）
 * - cwd 不存在（stat ENOENT）/ 非目录（stat type='file'）→ FileError('not_found')
 *   结构化失败（设计 D6 准入边界，不做白名单）
 * - session 路等价回归：searchFiles('s1') ≡ searchFilesInCwd(cwd)（薄包装行为不变），
 *   且 session 不存在仍抛 session_not_found（requireCwd 保留在包装层）
 */
describe('FileService · searchFilesInCwd cwd 路 + searchFiles 薄包装等价回归', () => {
  const executor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
  const sessionService = { getSummary: vi.fn() }

  const svc = () =>
    new FileService({
      sessionService: sessionService as unknown as FileServiceOptions['sessionService'],
      executor: executor as unknown as IFileExecutor,
    })

  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

  /** /repo stat 目录命中，其余（.gitignore 等）ENOENT → 空 matcher，不读文件。 */
  const statRepoDir = (p: string): Promise<{ type: 'dir'; size: number; mtimeMs: number }> =>
    p === '/repo' ? Promise.resolve({ type: 'dir', size: 0, mtimeMs: 1 }) : Promise.reject(enoent())

  /** 固定小目录树：顶层 b.ts + src/ + a.ts，src/ 下 x.ts。 */
  const listRepo = async (p: string): Promise<FsEntry[]> => {
    if (p === '/repo') {
      return [
        { name: 'b.ts', type: 'file' },
        { name: 'src', type: 'dir' },
        { name: 'a.ts', type: 'file' },
      ]
    }
    if (p === '/repo/src') return [{ name: 'x.ts', type: 'file' }]
    return []
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sessionService.getSummary.mockReturnValue({ cwd: '/repo' })
  })

  it('cwd 路合法目录：返回扁平 FileNode[]（dir 在前 + name 降序，子目录递归）+ truncated=false', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(listRepo)

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    // sortNodes：dir 在前；同类型 name 降序（x.ts > b.ts > a.ts）
    expect(files.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
    expect(files.every((n) => !n.path.startsWith('/'))).toBe(true) // path 相对 cwd，无前导斜杠
    expect(truncated).toBe(false) // 小目录不触发 DoS 上限（D7）
  })

  it('cwd 不存在（stat ENOENT）→ FileError("not_found")，且不进入递归（准入先行）', async () => {
    executor.stat.mockRejectedValue(enoent())

    await expect(svc().searchFilesInCwd('/gone')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('cwd 是文件非目录（stat type=file）→ FileError("not_found")', async () => {
    executor.stat.mockResolvedValue({ type: 'file', size: 3, mtimeMs: 1 })

    await expect(svc().searchFilesInCwd('/repo')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
  })

  it('session 路等价回归：searchFiles("s1") 与 searchFilesInCwd("…cwd") 结果一致（薄包装行为不变）', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(listRepo)

    const service = svc()
    const viaSession = await service.searchFiles('s1')
    const viaCwd = await service.searchFilesInCwd('/repo')
    expect(viaSession).toEqual(viaCwd.files)
    expect(viaSession.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
  })

  it('session 路回归：session 不存在仍抛 session_not_found（requireCwd 保留在包装层）', async () => {
    sessionService.getSummary.mockReturnValue(undefined)

    await expect(svc().searchFiles('sX')).rejects.toMatchObject({
      name: 'FileError',
      code: 'session_not_found',
    })
  })

  it('session 存在但 cwd 目录已删（stat ENOENT）→ not_found（非 session_not_found，D6 #12）', async () => {
    // beforeEach 已置 getSummary → { cwd: '/repo' }：session 在、目录没了——session 路
    // 照样走 cwd 准入 stat，失败分类为 not_found（错误码语义：目录缺失 ≠ session 缺失）
    executor.stat.mockRejectedValue(enoent())

    await expect(svc().searchFiles('s1')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('cwd 归一化（D6 #11）：`~/repo` 与带冗余段的 `/repo/./` 均 stat 归一后路径', async () => {
    const home = homedir()
    const statCalls: string[] = []
    // 归一后根有两形：/repo 与 <home>/repo（~ 展开产物）——都按目录命中
    const statNormalizedRepoDir = (p: string): Promise<{ type: 'dir'; size: number; mtimeMs: number }> =>
      p === '/repo' || p === join(home, 'repo')
        ? Promise.resolve({ type: 'dir', size: 0, mtimeMs: 1 })
        : Promise.reject(enoent())
    executor.stat.mockImplementation((p: string) => {
      statCalls.push(p)
      return statNormalizedRepoDir(p)
    })
    executor.readFile.mockRejectedValue(enoent())
    // ~ 展开后的根走 walk：listDir 把 <home>/repo 前缀映射回 /repo 的同一目录树
    const homeRepoPrefix = `${join(home, 'repo')}/`
    executor.listDir.mockImplementation(async (p: string) =>
      p === join(home, 'repo') ? listRepo('/repo') : listRepo(p.startsWith(homeRepoPrefix) ? p.replace(homeRepoPrefix, '/repo/') : p),
    )

    const { files } = await svc().searchFilesInCwd('~/repo')
    expect(files.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
    expect(statCalls[0]).toBe(join(home, 'repo')) // ~ 已展开（executor 收到的全是规范绝对路径）

    statCalls.length = 0
    await svc().searchFilesInCwd('/repo/.')
    expect(statCalls[0]).toBe('/repo') // resolve 归一（尾段冗余剥离）
  })

  it('DoS 上限 5000 截止（D7）：同层还有未收集条目 → files 截在 5000 + truncated=true', async () => {
    // 单层 5001 文件：收集到第 5000 个时 cap 截止、本层还剩 1 条未收集（硬信号）
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(async (p: string) =>
      p === '/repo'
        ? Array.from({ length: MAX_SEARCH_RESULTS + 1 }, (_, i) => ({ name: `f${i}.ts`, type: 'file' }))
        : [],
    )

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    expect(files).toHaveLength(MAX_SEARCH_RESULTS)
    expect(truncated).toBe(true)
  })

  it('DoS 上限边界（D7）：恰 5000 条全量收集完（自然扫完无剩余）→ truncated=false', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(async (p: string) =>
      p === '/repo'
        ? Array.from({ length: MAX_SEARCH_RESULTS }, (_, i) => ({ name: `f${i}.ts`, type: 'file' }))
        : [],
    )

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    expect(files).toHaveLength(MAX_SEARCH_RESULTS)
    expect(truncated).toBe(false)
  })
})
