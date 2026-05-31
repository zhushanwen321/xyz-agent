/**
 * Task 1 测试: Plugin Types + Built-in Scan + Registry
 *
 * 验证 BG1 阶段的类型系统扩展、built-in 扫描路径、
 * 以及 PluginDescriptor 的 source / extensionDependencies 字段。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-foundation-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('Task 1: Plugin Types + Built-in Scan + Registry', () => {
  // ── 类型系统验证 ──────────────────────────────────────────────

  describe('PluginSource type', () => {
    it('accepts built-in and external values', () => {
      const builtIn: PluginSource = 'built-in'
      const external: PluginSource = 'external'
      expect(builtIn).toBe('built-in')
      expect(external).toBe('external')
    })
  })

  describe('PluginState', () => {
    it('includes DEPS_MISSING state', () => {
      const state: PluginState = 'DEPS_MISSING'
      expect(state).toBe('DEPS_MISSING')
    })

    it('still supports all original states', () => {
      const states: PluginState[] = [
        'UNLOADED', 'LOADING', 'ACTIVATING', 'ACTIVE',
        'DEACTIVATING', 'CRASHED', 'DEPS_MISSING',
      ]
      expect(states.length).toBe(7)
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
      expect(manifest.source).toBe('built-in')
      expect(manifest.extensionDependencies).toEqual(['core-tools'])
    })

    it('source and extensionDependencies are optional', () => {
      const manifest: XyzAgentManifest = {
        manifestVersion: 1,
        main: 'index.js',
        activationEvents: [],
      }
      expect(manifest.source).toBe(undefined)
      expect(manifest.extensionDependencies).toBe(undefined)
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
      expect(desc.source).toBe('external')
      expect(desc.extensionDependencies).toEqual([])
    })
  })

  // ── PermissionConstants 验证 ─────────────────────────────────

  describe('PermissionConstants', () => {
    it('defines required permission constants', () => {
      expect(PermissionConstants.TOOLS_REGISTER).toBeTruthy()
      expect(PermissionConstants.HOOKS_REGISTER).toBeTruthy()
      expect(PermissionConstants.SESSIONS_SEND_MESSAGE).toBeTruthy()
      expect(typeof PermissionConstants.TOOLS_REGISTER).toBe('string')
      expect(typeof PermissionConstants.HOOKS_REGISTER).toBe('string')
      expect(typeof PermissionConstants.SESSIONS_SEND_MESSAGE).toBe('string')
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
      expect(state.pluginId).toBe('test')
      expect(state.connected).toBe(true)
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
      expect(req.type).toBe('bridge.sync')
      expect(res.success).toBe(true)
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
      expect(req.toolName).toBe('myTool')
      expect(res.content).toBe('ok')
    })
  })

  // ── Hook 类型验证 ────────────────────────────────────────────

  describe('Hook types', () => {
    it('InterceptorHookType includes expected values', () => {
      const hook: InterceptorHookType = 'onToolCall'
      expect(hook).toBe('onToolCall')
    })

    it('ObserverHookType includes expected values', () => {
      const hook: ObserverHookType = 'onMessage'
      expect(hook).toBe('onMessage')
    })

    it('HookResult can be success or blocked', () => {
      const success: HookResult = { blocked: false }
      const blocked: HookBlockedResult = { blocked: true, reason: 'not allowed' }
      expect(success.blocked).toBe(false)
      expect(blocked.blocked).toBe(true)
      expect(blocked.reason).toBe('not allowed')
    })

    it('HookContext has correct shape', () => {
      const ctx: HookContext = {
        pluginId: 'test',
        hookType: 'onToolCall' as HookType,
        data: { tool: 'myTool' },
        timestamp: Date.now(),
      }
      expect(ctx.pluginId).toBe('test')
    })

    it('InterceptorResult can allow or deny with modification', () => {
      const allow: InterceptorResult = { proceed: true }
      const deny: InterceptorResult = { proceed: false, reason: 'blocked' }
      const modify: InterceptorResult = { proceed: true, modifiedData: { a: 2 } }
      expect(allow.proceed).toBe(true)
      expect(deny.proceed).toBe(false)
      expect(modify.modifiedData).toBeTruthy()
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
      const coreTool = descriptors.find(d => d.pluginId === 'core-tool')!
      expect(coreTool).toBeTruthy()
      expect(coreTool.source).toBe('built-in')
      expect(coreTool.extensionDependencies).toEqual([])
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
      const ext = descriptors.find(d => d.pluginId === 'ext-plugin')!
      expect(ext).toBeTruthy()
      expect(ext.source).toBe('external')
      expect(ext.extensionDependencies).toEqual(['core-tool'])
    })
  })
})
