import { describe, it, expect } from 'vitest'
import { isStrictlyUnder, isUnderOrEqual } from '../src/utils/path-utils.js'
import { resolve } from 'node:path'

describe('path-utils', () => {
  const parent = '/a/b'

  describe('isStrictlyUnder', () => {
    it('returns false when child equals parent', () => {
      expect(isStrictlyUnder(parent, parent)).toBe(false)
    })

    it('returns true when child is under parent', () => {
      expect(isStrictlyUnder(parent, '/a/b/c')).toBe(true)
    })

    it('returns false when child is outside parent', () => {
      expect(isStrictlyUnder(parent, '/a/other')).toBe(false)
    })

    it('returns false when child is a sibling prefix', () => {
      expect(isStrictlyUnder('/a/b', '/a/bc')).toBe(false)
    })

    it('handles trailing slash on parent', () => {
      expect(isStrictlyUnder('/a/b/', '/a/b/c')).toBe(true)
    })

    it('handles trailing slash on child', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/')).toBe(true)
    })

    it('handles trailing slashes on both', () => {
      expect(isStrictlyUnder('/a/b/', '/a/b/c/')).toBe(true)
    })

    it('returns false when parent is deeper than child', () => {
      expect(isStrictlyUnder('/a/b/c', '/a/b')).toBe(false)
    })

    it('normalizes relative segments in child', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/../d')).toBe(true)
    })

    it('returns false for relative child escaping parent', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/../../other')).toBe(false)
    })
  })

  describe('isUnderOrEqual', () => {
    it('returns true when child equals parent', () => {
      expect(isUnderOrEqual(parent, parent)).toBe(true)
    })

    it('returns true when child is under parent', () => {
      expect(isUnderOrEqual(parent, '/a/b/c')).toBe(true)
    })

    it('returns false when child is outside parent', () => {
      expect(isUnderOrEqual(parent, '/a/other')).toBe(false)
    })

    it('returns true when child equals parent with trailing slashes', () => {
      expect(isUnderOrEqual('/a/b/', '/a/b/')).toBe(true)
    })

    it('handles mixed trailing slashes (equal paths)', () => {
      expect(isUnderOrEqual('/a/b/', '/a/b')).toBe(true)
    })

    it('returns false when child is a sibling prefix', () => {
      expect(isUnderOrEqual('/a/b', '/a/bc')).toBe(false)
    })

    it('returns false for deeply nested child escaping parent', () => {
      expect(isUnderOrEqual('/a/b', '/a/b/c/../../other')).toBe(false)
    })
  })
})
