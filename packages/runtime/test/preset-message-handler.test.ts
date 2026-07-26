/**
 * PresetMessageHandler 单测 —— preset.* 消息路由 + PresetService 调用验证。
 *
 * 覆盖：
 * - preset.list → reply { presets }（getAllPresets 返回值）
 * - preset.getDefault → reply { presetId }（getDefaultPresetId 返回值）
 * - preset.setDefault → reply ack（setDefaultPresetId 被调用）
 * - preset.create → reply { preset }（savePreset + getPreset）
 * - preset.update → reply { preset }（savePreset + getPreset）
 * - preset.delete → reply ack（deletePreset 被调用）
 * - PresetGuardError → error envelope（code='preset_guard_error'）
 *
 * mock 策略：mock PresetService 方法，捕获 reply/sendError 调用。
 * 运行：cd packages/runtime && npx vitest run test/preset-message-handler.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { PiLaunchPreset } from '@xyz-agent/shared'
import { PresetMessageHandler } from '../src/transport/preset-message-handler.js'
import { PresetGuardError } from '../src/services/preset-service.js'

// ── Fixtures ──────────────────────────────────────────────────────

const fullPreset: PiLaunchPreset = {
  id: 'builtin:full',
  name: '全工具模式',
  builtin: true,
  order: 0,
  toolMode: 'all',
  extensionMode: 'all',
}

const customPreset: PiLaunchPreset = {
  id: 'custom:test-uuid',
  name: '自定义预设',
  builtin: false,
  order: 3,
  toolMode: 'allowlist',
  allowedTools: ['read', 'grep'],
  extensionMode: 'all',
}

// ── Mocks ─────────────────────────────────────────────────────────

function createMockWs(): WebSocket {
  return {} as WebSocket
}

function createMockPresetService() {
  return {
    getAllPresets: vi.fn().mockReturnValue([fullPreset, customPreset]),
    getPreset: vi.fn().mockImplementation((id: string) => {
      if (id === 'builtin:full') return fullPreset
      if (id === 'custom:test-uuid') return customPreset
      return undefined
    }),
    getDefaultPresetId: vi.fn().mockReturnValue('builtin:full'),
    setDefaultPresetId: vi.fn(),
    savePreset: vi.fn(),
    deletePreset: vi.fn(),
  }
}

function createMockContext() {
  const presetService = createMockPresetService()
  return {
    presetService,
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('PresetMessageHandler', () => {
  let ctx: ReturnType<typeof createMockContext>
  let handler: PresetMessageHandler
  let ws: WebSocket

  beforeEach(() => {
    ctx = createMockContext()
    handler = new PresetMessageHandler(ctx)
    ws = createMockWs()
  })

  it('handles 消息类型清单包含 6 个 preset.* 类型', () => {
    expect(handler.handles).toEqual([
      'preset.list',
      'preset.getDefault',
      'preset.setDefault',
      'preset.create',
      'preset.update',
      'preset.delete',
    ])
  })

  describe('preset.list', () => {
    it('调用 getAllPresets 并 reply { presets }', async () => {
      const msg = { type: 'preset.list' as const, id: 'req-1', payload: {} }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.presetService.getAllPresets).toHaveBeenCalledTimes(1)
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-1', 'preset.list', { presets: [fullPreset, customPreset] })
    })
  })

  describe('preset.getDefault', () => {
    it('调用 getDefaultPresetId 并 reply { presetId }', async () => {
      const msg = { type: 'preset.getDefault' as const, id: 'req-2', payload: {} }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.presetService.getDefaultPresetId).toHaveBeenCalledTimes(1)
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-2', 'preset.getDefault', { presetId: 'builtin:full' })
    })
  })

  describe('preset.setDefault', () => {
    it('调用 setDefaultPresetId 并 reply ack', async () => {
      const msg = { type: 'preset.setDefault' as const, id: 'req-3', payload: { presetId: 'custom:test-uuid' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.presetService.setDefaultPresetId).toHaveBeenCalledWith('custom:test-uuid')
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-3', 'preset.setDefault', expect.any(Object))
    })
  })

  describe('preset.create', () => {
    it('调用 savePreset 并 reply { preset }', async () => {
      const msg = { type: 'preset.create' as const, id: 'req-4', payload: { preset: customPreset } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.presetService.savePreset).toHaveBeenCalledWith(customPreset)
      expect(ctx.presetService.getPreset).toHaveBeenCalledWith('custom:test-uuid')
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-4', 'preset.create', { preset: customPreset })
    })

    it('getPreset 返回 undefined 时用传入 preset 兜底', async () => {
      ctx.presetService.getPreset.mockReturnValueOnce(undefined)
      const msg = { type: 'preset.create' as const, id: 'req-4b', payload: { preset: customPreset } }
      await handler.handlePresetMessage(msg, ws)
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-4b', 'preset.create', { preset: customPreset })
    })
  })

  describe('preset.update', () => {
    it('调用 savePreset 并 reply { preset }', async () => {
      const updated = { ...customPreset, name: '新名称' }
      const msg = { type: 'preset.update' as const, id: 'req-5', payload: { preset: updated } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.presetService.savePreset).toHaveBeenCalledWith(updated)
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-5', 'preset.update', { preset: customPreset })
    })
  })

  describe('preset.delete', () => {
    it('调用 deletePreset 并 reply ack', async () => {
      const msg = { type: 'preset.delete' as const, id: 'req-6', payload: { presetId: 'custom:test-uuid' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.presetService.deletePreset).toHaveBeenCalledWith('custom:test-uuid')
      expect(ctx.reply).toHaveBeenCalledWith(ws, 'req-6', 'preset.delete', expect.any(Object))
    })
  })

  describe('错误处理', () => {
    it('PresetGuardError → sendError envelope（code=preset_guard_error）', async () => {
      ctx.presetService.savePreset.mockImplementationOnce(() => {
        throw new PresetGuardError('cannot delete builtin preset')
      })
      const msg = { type: 'preset.create' as const, id: 'err-1', payload: { preset: fullPreset } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.sendError).toHaveBeenCalledWith(ws, 'preset_guard_error', 'cannot delete builtin preset', 'err-1')
    })

    it('普通 Error → sendError envelope（code=preset_guard_error 兜底）', async () => {
      ctx.presetService.deletePreset.mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      const msg = { type: 'preset.delete' as const, id: 'err-2', payload: { presetId: 'custom:x' } }
      const result = await handler.handlePresetMessage(msg, ws)
      expect(result).toBe(true)
      expect(ctx.sendError).toHaveBeenCalledWith(ws, 'preset_guard_error', 'disk full', 'err-2')
    })

    it('带 code 的 Error → 透传 code', async () => {
      const err = new Error('custom error') as Error & { code: string }
      err.code = 'CUSTOM_CODE'
      ctx.presetService.deletePreset.mockImplementationOnce(() => { throw err })
      const msg = { type: 'preset.delete' as const, id: 'err-3', payload: { presetId: 'custom:x' } }
      await handler.handlePresetMessage(msg, ws)
      expect(ctx.sendError).toHaveBeenCalledWith(ws, 'CUSTOM_CODE', 'custom error', 'err-3')
    })
  })
})
