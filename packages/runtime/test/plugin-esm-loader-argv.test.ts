/**
 * MF-5: resolveEsmLoaderExecArgv fail-open 分支单元测试。
 *
 * 锁定 resolveEsmLoaderExecArgv 的行为契约：loader 缺失时 catch 后返回 undefined（不抛），
 * 使 runtime 启动不被 loader 缺失阻塞（fail-closed 由 fork 边界 MF-1 断言兜底）。
 * 若有人把 catch 改回 throw，本测试会红——防止「fail-open → runtime 崩溃」回归。
 *
 * 运行命令: npx vitest run test/plugin-esm-loader-argv.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock plugin-host.js：保留真实 PluginHost，仅 mock resolveAndValidateFile（按用例控制）
vi.mock('../src/services/plugin-service/plugin-host.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/plugin-service/plugin-host.js')>()
  return {
    ...actual,
    resolveAndValidateFile: vi.fn(),
  }
})

import { resolveEsmLoaderExecArgv } from '../src/services/plugin-service/plugin-service.js'
import { resolveAndValidateFile } from '../src/services/plugin-service/plugin-host.js'

describe('resolveEsmLoaderExecArgv (MF-5 fail-open branch)', () => {
  beforeEach(() => {
    vi.mocked(resolveAndValidateFile).mockReset()
  })

  it('loader present: returns ["--import", <absolute path>]', () => {
    vi.mocked(resolveAndValidateFile).mockReturnValue('/abs/plugin-esm-loader.cjs')
    expect(resolveEsmLoaderExecArgv()).toEqual(['--import', '/abs/plugin-esm-loader.cjs'])
  })

  it('loader missing: catch 分支返回 undefined，不抛——runtime 启动不被 loader 缺失阻塞', () => {
    vi.mocked(resolveAndValidateFile).mockImplementation(() => {
      throw new Error('[plugin-host] Required file not found: plugin-esm-loader.cjs')
    })
    // MF-5 契约：resolver 层 fail-open（返回 undefined）。fail-closed 在 fork 边界（MF-1
    // PluginHostProcess.createProcess 的 SANDBOX_LOADER_MISSING 断言）兑现，故 resolver 不抛
    // 确保 PluginService 构造/runtime boot 不崩。锁定此契约，防止 catch 被改回 throw。
    expect(resolveEsmLoaderExecArgv()).toBeUndefined()
  })
})
