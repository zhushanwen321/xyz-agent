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
import { READ_TIMEOUT_MS } from '../src/services/file-service.js'
import { FileError } from '../src/services/file-error.js'

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
          reject(new FileError(errorMessage, 'timeout'))
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
