/**
 * FileService.readFile 真实 fs 集成测试（real 层）。
 *
 * 运行：cd packages/runtime && npx vitest run test/file-service-real.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileService } from '../src/services/file-service.js'
import { FsExecutor } from '../src/infra/fs-executor.js'
import type { ISessionService } from '../src/interfaces.js'

describe('FileService.readFile real fs', () => {
  let tempDir: string
  let service: FileService

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'file-service-real-'))
    const sessionService: ISessionService = {
      getSummary: vi.fn().mockReturnValue({ cwd: tempDir }),
    } as unknown as ISessionService
    service = new FileService({ sessionService, executor: new FsExecutor() })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('E1: 读取 tempDir 之外的绝对路径文件成功', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-outside-'))
    const outsideFile = join(outsideDir, 'outside.md')
    writeFileSync(outsideFile, 'outside content')

    try {
      const result = await service.readFile('s1', outsideFile)
      expect(result.content).toBe('outside content')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
