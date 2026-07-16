import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { discoverPort } from '../port-discovery.js'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

describe('discoverPort', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('reads port from runtime.port file', async () => {
    const { readFileSync } = await import('node:fs')
    vi.mocked(readFileSync).mockReturnValue('3210\n')
    process.env.XYZ_AGENT_DATA_DIR = '/tmp/test-xyz'
    expect(discoverPort()).toBe(3210)
    expect(readFileSync).toHaveBeenCalledWith('/tmp/test-xyz/runtime.port', 'utf-8')
  })

  it('throws when runtime.port file missing', async () => {
    const { readFileSync } = await import('node:fs')
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    process.env.XYZ_AGENT_DATA_DIR = '/tmp/test-xyz'
    expect(() => discoverPort()).toThrow(/runtime not running/)
  })

  it('throws when port file contains non-numeric', async () => {
    const { readFileSync } = await import('node:fs')
    vi.mocked(readFileSync).mockReturnValue('not-a-port')
    process.env.XYZ_AGENT_DATA_DIR = '/tmp/test-xyz'
    expect(() => discoverPort()).toThrow(/[Ii]nvalid port/)
  })
})
