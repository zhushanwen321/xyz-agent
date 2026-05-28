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

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  createRequireInterceptor,
  BLOCKED_BUILTINS,
} from '../src/services/plugin-service/plugin-sandbox.js'

describe('Task 2: Worker Sandbox (require 拦截)', () => {
  describe('BLOCKED_BUILTINS', () => {
    it('includes dangerous modules', () => {
      assert.ok(BLOCKED_BUILTINS.includes('fs'))
      assert.ok(BLOCKED_BUILTINS.includes('child_process'))
      assert.ok(BLOCKED_BUILTINS.includes('cluster'))
      assert.ok(BLOCKED_BUILTINS.includes('dgram'))
      assert.ok(BLOCKED_BUILTINS.includes('dns'))
      assert.ok(BLOCKED_BUILTINS.includes('net'))
    })

    it('does not block safe modules', () => {
      assert.ok(!BLOCKED_BUILTINS.includes('path'))
      assert.ok(!BLOCKED_BUILTINS.includes('url'))
      assert.ok(!BLOCKED_BUILTINS.includes('util'))
      assert.ok(!BLOCKED_BUILTINS.includes('events'))
    })
  })

  describe('createRequireInterceptor', () => {
    const pluginDir = '/tmp/test-plugin'

    it('allows relative paths within pluginDir', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 应该不抛异常
      const result = interceptor('./utils', '/tmp/test-plugin/utils.js')
      assert.strictEqual(result, '/tmp/test-plugin/utils.js')
    })

    it('rejects relative paths outside pluginDir', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      assert.throws(
        () => interceptor('../escape', '/tmp/escape.js'),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.strictEqual((err as { code?: string }).code, 'PERMISSION_DENIED')
          return true
        },
      )
    })

    it('allows non-blocked npm packages', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 不在 blocklist 中的包名不抛异常（实际 resolve 可能失败，但拦截层不阻止）
      const result = interceptor('lodash', undefined)
      assert.strictEqual(result, 'lodash')
    })

    it('rejects blocked builtin modules', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      for (const mod of ['fs', 'child_process', 'net']) {
        assert.throws(
          () => interceptor(mod, undefined),
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.strictEqual((err as { code?: string }).code, 'PERMISSION_DENIED')
            return true
          },
        )
      }
    })

    it('allows path, url, util, events', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      for (const mod of ['path', 'url', 'util', 'events']) {
        const result = interceptor(mod, undefined)
        assert.strictEqual(result, mod)
      }
    })

    it('handles nested path traversal attempts', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      assert.throws(
        () => interceptor('./../../etc/passwd', '/tmp/etc/passwd'),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.strictEqual((err as { code?: string }).code, 'PERMISSION_DENIED')
          return true
        },
      )
    })
  })
})
