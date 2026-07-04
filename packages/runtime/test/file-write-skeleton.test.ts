/**
 * FileService file.write 骨架单测（#14，AC-14.1~14.4，结构化「待实现」演进帧）。
 *
 * 覆盖：
 * - AC-14.1~14.3 createFile/renameFile/deleteFile 三写操作均抛 FileError('not_implemented')
 * - AC-14.4 FileErrorCode 类型含 'not_implemented'（handler 据此转 { implemented:false } 结构化响应）
 *
 * 设计（code-architecture §3，#14 G4 实现延后）：FileService 的三个写方法当前为骨架，
 *   一律 throw FileError('not_implemented', ...)。本层只抛 not_implemented；
 *   handler（W1b-handler）catch 后转结构化响应 { implemented: false }。
 *
 * mock 策略：FileService 构造注入 mock executor + sessionService（写操作在抛错前不触达 executor，
 *   但 requireCwd 校验 session——需提供有效 cwd）。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/file-write-skeleton.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  FileService,
  type FileServiceOptions,
} from '../src/services/file-service.js'
import { FileError, type FileErrorCode } from '../src/services/file-error.js'
import type { IFileExecutor } from '../src/services/ports/file-executor.js'

const executor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
const sessionService = { getSummary: vi.fn() }

function svc(): FileService {
  return new FileService({
    sessionService: sessionService as unknown as FileServiceOptions['sessionService'],
    executor: executor as unknown as IFileExecutor,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // 写操作骨架先 requireCwd（抛 not_implemented 前会校验 session 存在）
  sessionService.getSummary.mockReturnValue({ cwd: '/repo' })
})

describe('FileService file.write 骨架 (#14 AC-14.1~14.4)', () => {
  it('AC-14.1 createFile → FileError(not_implemented)', async () => {
    await expect(svc().createFile('s1', 'a.txt', 'hi')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_implemented',
    })
    // 骨架不触达 executor（无真实写）
    expect(executor.listDir).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
  })

  it('AC-14.2 renameFile → FileError(not_implemented)', async () => {
    await expect(svc().renameFile('s1', 'a.txt', 'b.txt')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_implemented',
    })
  })

  it('AC-14.3 deleteFile → FileError(not_implemented)', async () => {
    await expect(svc().deleteFile('s1', 'a.txt')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_implemented',
    })
  })

  it('AC-14.4 FileErrorCode 类型含 not_implemented（handler 据此转结构化 { implemented:false }）', () => {
    // 类型层断言：not_implemented 是 FileErrorCode 合法成员
    const code: FileErrorCode = 'not_implemented'
    expect(code).toBe('not_implemented')

    // 实例层：抛出的错误是 FileError 且 code === 'not_implemented'
    const err = new FileError('not_implemented')
    expect(err).toBeInstanceOf(FileError)
    expect(err.code).toBe('not_implemented')
    expect(err.name).toBe('FileError')
  })

  it('AC-14.4 三个写操作抛出的 message 一致（结构化判定友好）', async () => {
    const a = await svc().createFile('s1', 'a', 'x').catch((e) => e as FileError)
    const b = await svc().renameFile('s1', 'a', 'b').catch((e) => e as FileError)
    const c = await svc().deleteFile('s1', 'a').catch((e) => e as FileError)
    expect(a.code).toBe('not_implemented')
    expect(b.code).toBe('not_implemented')
    expect(c.code).toBe('not_implemented')
    expect(a.message).toBe(b.message)
    expect(b.message).toBe(c.message)
  })
})
