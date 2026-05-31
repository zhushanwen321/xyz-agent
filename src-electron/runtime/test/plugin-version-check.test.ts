import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock createRequire to return a known version for testing
const mockPkg = { version: '0.3.2' }
vi.mock('node:module', () => ({
  createRequire: () => (path: string) => {
    if (typeof path === 'string' && path.includes('package.json')) {
      return mockPkg
    }
    throw new Error('not found')
  },
}))

// Import after mock setup
const { checkPluginCompatibility } = await import('../src/services/plugin-service/plugin-version-checker.js')

describe('checkPluginCompatibility', () => {
  it('returns compatible for wildcard "*"', () => {
    const result = checkPluginCompatibility('*')
    expect(result.compatible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('returns compatible for empty string', () => {
    const result = checkPluginCompatibility('')
    expect(result.compatible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('returns compatible when current version satisfies range', () => {
    // mockPkg.version = '0.3.2'
    const result = checkPluginCompatibility('^0.3.0')
    expect(result.compatible).toBe(true)
  })

  it('returns incompatible for unsatisfied range', () => {
    const result = checkPluginCompatibility('^99.0.0')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('Requires xyz-agent')
    expect(result.reason).toContain('^99.0.0')
  })

  it('returns incompatible for invalid version range', () => {
    const result = checkPluginCompatibility('not-valid-range')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('Invalid version range')
    expect(result.reason).toContain('not-valid-range')
  })

  it('returns compatible for exact current version', () => {
    // mockPkg.version = '0.3.2'
    const result = checkPluginCompatibility('0.3.2')
    expect(result.compatible).toBe(true)
  })
})
