/**
 * Task 2 测试: Worker Sandbox (require 拦截)
 *
 * 验证 sandbox 模式下 require 拦截逻辑：
 * - trusted Worker 的 require 不受限
 * - sandbox Worker require 被拦截（blockedBuiltins）
 * - process.env 被替换为空 Proxy
 *
 * 不创建真实 Worker Thread，只单元测试拦截函数逻辑。
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  createRequireInterceptor,
  BLOCKED_BUILTINS,
} from '../src/services/plugin-service/plugin-sandbox.js'

describe('Task 2: Worker Sandbox (require 拦截)', () => {
  describe('BLOCKED_BUILTINS', () => {
    it('includes dangerous modules', () => {
      expect(BLOCKED_BUILTINS.includes('fs')).toBeTruthy()
      expect(BLOCKED_BUILTINS.includes('child_process')).toBeTruthy()
      expect(BLOCKED_BUILTINS.includes('cluster')).toBeTruthy()
      expect(BLOCKED_BUILTINS.includes('dgram')).toBeTruthy()
      expect(BLOCKED_BUILTINS.includes('dns')).toBeTruthy()
      expect(BLOCKED_BUILTINS.includes('net')).toBeTruthy()
    })

    it('does not block safe modules', () => {
      expect(!BLOCKED_BUILTINS.includes('path')).toBeTruthy()
      expect(!BLOCKED_BUILTINS.includes('url')).toBeTruthy()
      expect(!BLOCKED_BUILTINS.includes('util')).toBeTruthy()
      expect(!BLOCKED_BUILTINS.includes('events')).toBeTruthy()
    })
  })

  describe('createRequireInterceptor', () => {
    const pluginDir = '/tmp/test-plugin'

    it('allows relative paths within pluginDir', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 应该不抛异常
      const result = interceptor('./utils', '/tmp/test-plugin/utils.js')
      expect(result).toBe('/tmp/test-plugin/utils.js')
    })

    it('rejects relative paths outside pluginDir', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      try {
        interceptor('../escape', '/tmp/escape.js')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
      }
    })

    it('allows non-blocked npm packages', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 不在 blocklist 中的包名不抛异常（实际 resolve 可能失败，但拦截层不阻止）
      const result = interceptor('lodash', undefined)
      expect(result).toBe('lodash')
    })

    it('rejects blocked builtin modules', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      for (const mod of ['fs', 'child_process', 'net']) {
        try {
          interceptor(mod, undefined)
          expect.unreachable('should have thrown')
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
        }
      }
    })

    it('allows path, url, util, events', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      for (const mod of ['path', 'url', 'util', 'events']) {
        const result = interceptor(mod, undefined)
        expect(result).toBe(mod)
      }
    })

    it('handles nested path traversal attempts', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      try {
        interceptor('./../../etc/passwd', '/tmp/etc/passwd')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
      }
    })
  })
})
