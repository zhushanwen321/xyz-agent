/**
 * config.previewImportProviders / config.applyImportProviders WS round-trip 测试（W2）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-provider-import.test.ts
 *
 * 测试模式参考 config-detect-sources.test.ts（W1）：
 *   - mock ctx（含 reply / configService 等），构造 ClientMessage，调 handler，断言 reply 参数。
 *
 * 覆盖：
 *   - T8：发 config.previewImportProviders {source:'pi'} → 收到 config.providersPreviewed，
 *         payload.importId 非空，payload.preview.providers 是数组。
 *   - T9：先 preview 拿 importId → 发 config.applyImportProviders {importId, selectedIds}
 *         → 收到 config.providersImported，payload.result.imported 是数组 + broadcastProviderList 被调。
 *   - T8b：preview 返回 error（源未安装）→ reply 仍 config.providersPreviewed（含 error 字段），不报错。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsMessageHandler, type SettingsHandlerContext } from '../../transport/settings-message-handler.js'
import type { ClientMessage, ProviderImportPreview, ProviderImportResult } from '@xyz-agent/shared'

// ── mock helpers ─────────────────────────────────────────────

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as unknown as Parameters<SettingsMessageHandler['handleSettingsMessage']>[1]
}

/**
 * 构造满足 preview/apply case 所需的最小 ctx。
 * previewImportProviders / applyImportProviders 是 vi.fn()，各 test 用 mockReturnValue 覆盖返回值。
 */
function mockContext(): SettingsHandlerContext {
  return {
    reply: vi.fn(),
    send: vi.fn(),
    sendError: vi.fn(),
    configService: {
      previewImportProviders: vi.fn(),
      applyImportProviders: vi.fn(),
    } as unknown as SettingsHandlerContext['configService'],
    sessionService: {} as SettingsHandlerContext['sessionService'],
    modelService: {} as SettingsHandlerContext['modelService'],
    skillRegistry: {} as SettingsHandlerContext['skillRegistry'],
    projectRoot: '/tmp/project',
    nextPushId: vi.fn(() => 'push-1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
  } as unknown as SettingsHandlerContext
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// ── tests ────────────────────────────────────────────────────

describe('config.previewImportProviders / config.applyImportProviders WS round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T8: preview {source:pi} → reply config.providersPreviewed，importId 非空 + providers 是数组', async () => {
    const ctx = mockContext()
    const preview: ProviderImportPreview = {
      source: 'pi',
      providers: [
        {
          id: 'deepseek-router',
          name: 'deepseek-router',
          protocol: 'anthropic-messages',
          modelCount: 2,
          apiKeyExtracted: true,
          conflict: 'none',
          warnings: [],
        },
      ],
    }
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      importId: 'import-uuid-123',
      preview,
    })
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(msg('config.previewImportProviders', { source: 'pi' }), mockWs())

    expect(handled).toBe(true)
    expect(ctx.configService.previewImportProviders).toHaveBeenCalledWith('pi')
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'msg-1',
      'config.providersPreviewed',
      { importId: 'import-uuid-123', preview },
    )
    // payload 形状断言
    const payload = vi.mocked(ctx.reply).mock.calls[0][3] as { importId: string; preview: ProviderImportPreview }
    expect(payload.importId).toBe('import-uuid-123')
    expect(Array.isArray(payload.preview.providers)).toBe(true)
    expect(payload.preview.providers).toHaveLength(1)
  })

  it('T9: preview 拿 importId → apply → reply config.providersImported + broadcastProviderList', async () => {
    const ctx = mockContext()
    const importId = 'round-trip-import-id'
    const result: ProviderImportResult = {
      source: 'pi',
      imported: [
        { id: 'deepseek-router', name: 'deepseek-router', status: 'imported' },
        { id: 'existing-one', name: 'existing-one', status: 'skipped', reason: 'duplicate' },
      ],
      failedCount: 0,
    }
    // preview 返回 importId（apply 测试复用同一 importId）
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      importId,
      preview: { source: 'pi', providers: [] },
    })
    vi.mocked(ctx.configService.applyImportProviders).mockReturnValue({ result })
    const handler = new SettingsMessageHandler(ctx)

    // Step1 preview
    await handler.handleSettingsMessage(msg('config.previewImportProviders', { source: 'pi' }, 'preview-id'), mockWs())

    // Step2 apply —— 复用 preview reply 里的 importId
    await handler.handleSettingsMessage(
      msg('config.applyImportProviders', { importId, selectedIds: ['deepseek-router', 'existing-one'] }, 'apply-id'),
      mockWs(),
    )

    // apply reply 断言
    const applyReply = vi.mocked(ctx.reply).mock.calls.find((c) => c[2] === 'config.providersImported')
    expect(applyReply).toBeDefined()
    // vi.mocked().mock.calls.find 返回 T | undefined；tsc 不会因 expect(toBeDefined) 收窄，故用非空断言。
    expect(applyReply![1]).toBe('apply-id')
    expect(applyReply![3]).toEqual({ result })
    // apply 成功 → 广播 provider 列表（让所有 panel 同步新增的 provider）
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(1)
    // apply 传入的参数：importId + selectedIds
    expect(ctx.configService.applyImportProviders).toHaveBeenCalledWith(importId, ['deepseek-router', 'existing-one'])
  })

  it('T8b: preview 返回 error（源未安装）→ reply config.providersPreviewed 含 error 字段，不报错', async () => {
    const ctx = mockContext()
    vi.mocked(ctx.configService.previewImportProviders).mockReturnValue({
      error: { code: 'SOURCE_NOT_INSTALLED', message: 'claude not installed' },
    })
    const handler = new SettingsMessageHandler(ctx)

    const handled = await handler.handleSettingsMessage(
      msg('config.previewImportProviders', { source: 'claude' }, 'err-id'),
      mockWs(),
    )

    expect(handled).toBe(true)
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'err-id',
      'config.providersPreviewed',
      { error: { code: 'SOURCE_NOT_INSTALLED', message: 'claude not installed' } },
    )
    // preview 失败不广播（无副作用）
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })

  it('T9b: apply 返回 error（缓存过期）→ reply config.providersImported 含 error，不广播', async () => {
    const ctx = mockContext()
    vi.mocked(ctx.configService.applyImportProviders).mockReturnValue({
      error: { code: 'PREVIEW_EXPIRED', message: '预览已过期' },
    })
    const handler = new SettingsMessageHandler(ctx)

    await handler.handleSettingsMessage(
      msg('config.applyImportProviders', { importId: 'expired-id', selectedIds: ['A'] }, 'apply-err-id'),
      mockWs(),
    )

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      'apply-err-id',
      'config.providersImported',
      { error: { code: 'PREVIEW_EXPIRED', message: '预览已过期' } },
    )
    // apply 失败不广播（result 不含 result 字段）
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })
})
