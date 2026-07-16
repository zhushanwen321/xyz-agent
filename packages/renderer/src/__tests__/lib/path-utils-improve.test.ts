import { describe, it, expect } from 'vitest'
import { resolvePreviewPath, isAbsolutePath } from '@/lib/path-utils'

describe('path-utils improved', () => {
  describe('Windows paths', () => {
    it('U1: C:\\project\\src\\main.ts under C:\\project → relative src/main.ts', () => {
      const result = resolvePreviewPath('C:\\project', 'C:\\project\\src\\main.ts')
      expect(result.absolute).toBe('C:\\project\\src\\main.ts')
      expect(result.relative).toBe('src/main.ts')
    })

    it('U1b: Windows path with mixed separators', () => {
      const result = resolvePreviewPath('C:/project', 'C:\\project\\src\\main.ts')
      expect(result.relative).toBe('src/main.ts')
    })
  })

  describe('~ paths', () => {
    it('U2: ~ path is absolute and relative is null', () => {
      expect(isAbsolutePath('~/Code/foo.md')).toBe(true)
      const result = resolvePreviewPath('/Users/me/project', '~/Code/foo.md')
      expect(result.absolute).toBe('~/Code/foo.md')
      expect(result.relative).toBeNull()
    })
  })
})
