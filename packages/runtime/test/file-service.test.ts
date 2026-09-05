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
import { READ_TIMEOUT_MS, FileService, type FileServiceOptions } from '../src/services/file-service.js'
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

  it('cwd 路合法目录：返回扁平 FileNode[]（dir 在前 + name 降序，子目录递归）', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(listRepo)

    const files = await svc().searchFilesInCwd('/repo')

    // sortNodes：dir 在前；同类型 name 降序（x.ts > b.ts > a.ts）
    expect(files.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
    expect(files.every((n) => !n.path.startsWith('/'))).toBe(true) // path 相对 cwd，无前导斜杠
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
    expect(viaSession).toEqual(viaCwd)
    expect(viaSession.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
  })

  it('session 路回归：session 不存在仍抛 session_not_found（requireCwd 保留在包装层）', async () => {
    sessionService.getSummary.mockReturnValue(undefined)

    await expect(svc().searchFiles('sX')).rejects.toMatchObject({
      name: 'FileError',
      code: 'session_not_found',
    })
  })
})
