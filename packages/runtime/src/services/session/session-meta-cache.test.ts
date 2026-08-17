/**
 * SessionMetaCache 单元测试。
 *
 * 验收标准 (A0/A1/A2):
 * - A0: SessionMetaCache unit tests pass
 * - A1: SessionMetaCache module exists with unified read/write API
 * - A2: pi session_info_changed event auto-updates cache label
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SessionMetaCache, sessionMetaCache } from './session-meta-cache.js'

describe('SessionMetaCache', () => {
  let cache: SessionMetaCache

  beforeEach(() => {
    cache = new SessionMetaCache()
  })

  describe('setLabel / getLabel', () => {
    it('should set and get label for a session', () => {
      cache.setLabel('session-1', 'My Session')
      expect(cache.getLabel('session-1')).toBe('My Session')
    })

    it('should return undefined for non-existent session', () => {
      expect(cache.getLabel('non-existent')).toBeUndefined()
    })

    it('should overwrite existing label', () => {
      cache.setLabel('session-1', 'Old Name')
      cache.setLabel('session-1', 'New Name')
      expect(cache.getLabel('session-1')).toBe('New Name')
    })

    it('should handle multiple sessions independently', () => {
      cache.setLabel('session-1', 'Session One')
      cache.setLabel('session-2', 'Session Two')
      expect(cache.getLabel('session-1')).toBe('Session One')
      expect(cache.getLabel('session-2')).toBe('Session Two')
    })
  })

  describe('setThinkingLevel / getThinkingLevel', () => {
    it('should set and get thinking level', () => {
      cache.setThinkingLevel('session-1', 'high')
      expect(cache.getThinkingLevel('session-1')).toBe('high')
    })

    it('should return undefined for non-existent session', () => {
      expect(cache.getThinkingLevel('non-existent')).toBeUndefined()
    })

    it('should handle undefined level (clear)', () => {
      cache.setThinkingLevel('session-1', 'high')
      cache.setThinkingLevel('session-1', undefined)
      expect(cache.getThinkingLevel('session-1')).toBeUndefined()
    })

    it('should overwrite existing thinking level', () => {
      cache.setThinkingLevel('session-1', 'low')
      cache.setThinkingLevel('session-1', 'high')
      expect(cache.getThinkingLevel('session-1')).toBe('high')
    })
  })

  describe('delete', () => {
    it('should delete session entry', () => {
      cache.setLabel('session-1', 'Test')
      cache.setThinkingLevel('session-1', 'high')
      cache.delete('session-1')
      expect(cache.getLabel('session-1')).toBeUndefined()
      expect(cache.getThinkingLevel('session-1')).toBeUndefined()
    })

    it('should be safe to delete non-existent session', () => {
      expect(() => cache.delete('non-existent')).not.toThrow()
    })
  })

  describe('has', () => {
    it('should return false for non-existent session', () => {
      expect(cache.has('session-1')).toBe(false)
    })

    it('should return true after setting label', () => {
      cache.setLabel('session-1', 'Test')
      expect(cache.has('session-1')).toBe(true)
    })

    it('should return true after setting thinking level', () => {
      cache.setThinkingLevel('session-1', 'high')
      expect(cache.has('session-1')).toBe(true)
    })

    it('should return false after delete', () => {
      cache.setLabel('session-1', 'Test')
      cache.delete('session-1')
      expect(cache.has('session-1')).toBe(false)
    })
  })

  describe('clear', () => {
    it('should clear all entries', () => {
      cache.setLabel('session-1', 'One')
      cache.setLabel('session-2', 'Two')
      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.getLabel('session-1')).toBeUndefined()
      expect(cache.getLabel('session-2')).toBeUndefined()
    })
  })

  describe('size', () => {
    it('should return 0 for empty cache', () => {
      expect(cache.size).toBe(0)
    })

    it('should return correct count', () => {
      cache.setLabel('session-1', 'One')
      cache.setLabel('session-2', 'Two')
      expect(cache.size).toBe(2)
    })

    it('should decrease after delete', () => {
      cache.setLabel('session-1', 'One')
      cache.setLabel('session-2', 'Two')
      cache.delete('session-1')
      expect(cache.size).toBe(1)
    })
  })

  describe('mixed operations', () => {
    it('should support setting both label and thinking level for same session', () => {
      cache.setLabel('session-1', 'My Session')
      cache.setThinkingLevel('session-1', 'high')
      expect(cache.getLabel('session-1')).toBe('My Session')
      expect(cache.getThinkingLevel('session-1')).toBe('high')
    })

    it('should handle lazy initialization correctly', () => {
      // First access via thinking level should create entry
      cache.setThinkingLevel('session-1', 'low')
      expect(cache.has('session-1')).toBe(true)
      // Label should be undefined (entry exists but label not set)
      expect(cache.getLabel('session-1')).toBeUndefined()
      // Now set label
      cache.setLabel('session-1', 'Test')
      expect(cache.getLabel('session-1')).toBe('Test')
    })
  })
})

describe('sessionMetaCache singleton', () => {
  beforeEach(() => {
    sessionMetaCache.clear()
  })

  it('should be a SessionMetaCache instance', () => {
    expect(sessionMetaCache).toBeInstanceOf(SessionMetaCache)
  })

  it('should maintain state across imports', () => {
    sessionMetaCache.setLabel('test-session', 'Test Label')
    expect(sessionMetaCache.getLabel('test-session')).toBe('Test Label')
  })
})
