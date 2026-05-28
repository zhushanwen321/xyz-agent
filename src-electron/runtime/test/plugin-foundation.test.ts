/**
 * Task 1 测试: Plugin Types + Built-in Scan + Registry
 *
 * 验证 BG1 阶段的类型系统扩展、built-in 扫描路径、
 * 以及 PluginDescriptor 的 source / extensionDependencies 字段。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  type PluginSource,
  type PluginState,
  type PluginDescriptor,
  type XyzAgentManifest,
  type BridgeState,
  type BridgeSyncRequest,
  type BridgeSyncResponse,
  type BridgeToolExecuteRequest,
  type BridgeToolExecuteResponse,
  type InterceptorHookType,
  type ObserverHookType,
  type HookType,
  type InterceptorResult,
  type HookContext,
  type HookResult,
  type HookBlockedResult,
  PermissionConstants,
} from '../src/services/plugin-service/plugin-types.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let tmpDir: string

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-foundation-test-'))
})

after(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('Task 1: Plugin Types + Built-in Scan + Registry', () => {
  // ── 类型系统验证 ──────────────────────────────────────────────

  describe('PluginSource type', () => {
    it('accepts built-in and external values', () => {
      const builtIn: PluginSource = 'built-in'
      const external: PluginSource = 'external'
      assert.strictEqual(builtIn, 'built-in')
      assert.strictEqual(external, 'external')
    })
  })

  describe('PluginState', () => {
    it('includes DEPS_MISSING state', () => {
      const state: PluginState = 'DEPS_MISSING'
      assert.strictEqual(state, 'DEPS_MISSING')
    })

    it('still supports all original states', () => {
      const states: PluginState[] = [
        'UNLOADED', 'LOADING', 'ACTIVATING', 'ACTIVE',
        'DEACTIVATING', 'CRASHED', 'DEPS_MISSING',
      ]
      assert.strictEqual(states.length, 7)
    })
  })

  describe('XyzAgentManifest', () => {
    it('supports source and extensionDependencies fields', () => {
      const manifest: XyzAgentManifest = {
        manifestVersion: 1,
        main: 'index.js',
        activationEvents: [],
        source: 'built-in',
        extensionDependencies: ['core-tools'],
      }
      assert.strictEqual(manifest.source, 'built-in')
      assert.deepStrictEqual(manifest.extensionDependencies, ['core-tools'])
    })

    it('source and extensionDependencies are optional', () => {
      const manifest: XyzAgentManifest = {
        manifestVersion: 1,
        main: 'index.js',
        activationEvents: [],
      }
      assert.strictEqual(manifest.source, undefined)
      assert.strictEqual(manifest.extensionDependencies, undefined)
    })
  })

  describe('PluginDescriptor', () => {
    it('includes source and extensionDependencies fields', () => {
      const desc: PluginDescriptor = {
        pluginId: 'test-plugin',
        version: '1.0.0',
        displayName: 'Test',
        description: '',
        main: 'index.js',
        activationEvents: [],
        trustLevel: 'sandbox',
        status: 'UNLOADED',
        contributes: {},
        permissions: [],
        engines: { 'xyz-agent': '*' },
        pluginPath: '/tmp/test',
        source: 'external',
        extensionDependencies: [],
      }
      assert.strictEqual(desc.source, 'external')
      assert.deepStrictEqual(desc.extensionDependencies, [])
    })
  })

  // ── PermissionConstants 验证 ─────────────────────────────────

  describe('PermissionConstants', () => {
    it('defines required permission constants', () => {
      assert.ok(PermissionConstants.TOOLS_REGISTER)
      assert.ok(PermissionConstants.HOOKS_REGISTER)
      assert.ok(PermissionConstants.SESSIONS_SEND_MESSAGE)
      assert.strictEqual(typeof PermissionConstants.TOOLS_REGISTER, 'string')
      assert.strictEqual(typeof PermissionConstants.HOOKS_REGISTER, 'string')
      assert.strictEqual(typeof PermissionConstants.SESSIONS_SEND_MESSAGE, 'string')
    })
  })

  // ── Bridge 类型验证 ──────────────────────────────────────────

  describe('Bridge types', () => {
    it('BridgeState has correct shape', () => {
      const state: BridgeState = {
        pluginId: 'test',
        connected: true,
        lastSyncAt: Date.now(),
      }
      assert.strictEqual(state.pluginId, 'test')
      assert.strictEqual(state.connected, true)
    })

    it('BridgeSyncRequest/Response have correct shape', () => {
      const req: BridgeSyncRequest = {
        type: 'bridge.sync',
        tools: [],
        hooks: [],
      }
      const res: BridgeSyncResponse = {
        success: true,
        registeredTools: [],
        registeredHooks: [],
      }
      assert.strictEqual(req.type, 'bridge.sync')
      assert.strictEqual(res.success, true)
    })

    it('BridgeToolExecuteRequest/Response have correct shape', () => {
      const req: BridgeToolExecuteRequest = {
        type: 'bridge.tool.execute',
        toolName: 'myTool',
        parameters: { a: 1 },
      }
      const res: BridgeToolExecuteResponse = {
        content: 'ok',
        isError: false,
      }
      assert.strictEqual(req.toolName, 'myTool')
      assert.strictEqual(res.content, 'ok')
    })
  })

  // ── Hook 类型验证 ────────────────────────────────────────────

  describe('Hook types', () => {
    it('InterceptorHookType includes expected values', () => {
      const hook: InterceptorHookType = 'onToolCall'
      assert.strictEqual(hook, 'onToolCall')
    })

    it('ObserverHookType includes expected values', () => {
      const hook: ObserverHookType = 'onMessage'
      assert.strictEqual(hook, 'onMessage')
    })

    it('HookResult can be success or blocked', () => {
      const success: HookResult = { blocked: false }
      const blocked: HookBlockedResult = { blocked: true, reason: 'not allowed' }
      assert.strictEqual(success.blocked, false)
      assert.strictEqual(blocked.blocked, true)
      assert.strictEqual(blocked.reason, 'not allowed')
    })

    it('HookContext has correct shape', () => {
      const ctx: HookContext = {
        pluginId: 'test',
        hookType: 'onToolCall' as HookType,
        data: { tool: 'myTool' },
        timestamp: Date.now(),
      }
      assert.strictEqual(ctx.pluginId, 'test')
    })

    it('InterceptorResult can allow or deny with modification', () => {
      const allow: InterceptorResult = { proceed: true }
      const deny: InterceptorResult = { proceed: false, reason: 'blocked' }
      const modify: InterceptorResult = { proceed: true, modifiedData: { a: 2 } }
      assert.strictEqual(allow.proceed, true)
      assert.strictEqual(deny.proceed, false)
      assert.ok(modify.modifiedData)
    })
  })

  // ── Built-in 扫描路径验证 ───────────────────────────────────

  describe('PluginRegistry built-in scan', () => {
    it('scan() includes built-in path resources/plugins/', async () => {
      const registry = new PluginRegistry(tmpDir)
      // 获取 scan 的目录列表——通过创建 built-in 插件验证
      const builtInDir = join(tmpDir, 'resources', 'plugins', 'core-tool')
      await mkdir(builtInDir, { recursive: true })
      await writeFile(
        join(builtInDir, 'package.json'),
        JSON.stringify({
          name: 'core-tool',
          version: '1.0.0',
          xyzAgent: {
            manifestVersion: 1,
            main: 'index.js',
            activationEvents: ['onStartupFinished'],
          },
        }),
        'utf-8',
      )

      const descriptors = await registry.scan()
      const coreTool = descriptors.find(d => d.pluginId === 'core-tool')
      assert.ok(coreTool, 'should discover built-in plugin from resources/plugins/')
      assert.strictEqual(coreTool.source, 'built-in')
      assert.deepStrictEqual(coreTool.extensionDependencies, [])
    })

    it('external plugins are marked as external', async () => {
      const pluginDir = join(tmpDir, '.xyz-agent', 'plugins', 'ext-plugin')
      await mkdir(pluginDir, { recursive: true })
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'ext-plugin',
          version: '1.0.0',
          xyzAgent: {
            manifestVersion: 1,
            main: 'index.js',
            activationEvents: [],
            extensionDependencies: ['core-tool'],
          },
        }),
        'utf-8',
      )

      const registry = new PluginRegistry(tmpDir)
      const descriptors = await registry.scan()
      const ext = descriptors.find(d => d.pluginId === 'ext-plugin')
      assert.ok(ext, 'should discover external plugin')
      assert.strictEqual(ext.source, 'external')
      assert.deepStrictEqual(ext.extensionDependencies, ['core-tool'])
    })
  })
})
