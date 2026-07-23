/**
 * SettingsMessageHandler system-prompt 路由单测（TDD 红灯）。
 *
 * 覆盖 2 个 WS case：
 * - config.getSystemPrompt
 * - config.setSystemPrompt（成功/失败两种回复路径）
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler } from '../src/transport/settings-message-handler.js'
import type { SettingsHandlerContext } from '../src/transport/settings-message-handler.js'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import type { IConfigService, IModelService, ISessionService } from '../src/interfaces.js'

interface SystemPromptConfig {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
}

const DEFAULT_CONFIG: SystemPromptConfig = {
  version: 1,
  replace: { enabled: false, prompt: '' },
  append: { enabled: false, prompt: '' },
}

function makeHandler() {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[] = []
  const sendErrorCalls: { code: string; message: string; id?: string }[] = []

  const configService = {
    listProviders: vi.fn().mockReturnValue([]),
    setProvider: vi.fn().mockReturnValue({}),
    deleteProvider: vi.fn().mockReturnValue({ removed: false }),
    setDefaultModel: vi.fn(),
    getProvider: vi.fn().mockReturnValue(undefined),
    updateToolPermissions: vi.fn(),
    loadSkills: vi.fn().mockReturnValue([]),
    scanSkills: vi.fn().mockReturnValue([]),
    upsertSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillDirs: vi.fn(),
    getSkillDirs: vi.fn().mockReturnValue([]),
    migrateSettingsSkillsToDiscovery: vi.fn(),
    loadAgents: vi.fn().mockReturnValue([]),
    scanAgents: vi.fn().mockReturnValue([]),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    setAgentDirs: vi.fn(),
    getAgentDirs: vi.fn().mockReturnValue([]),
    getSystemPromptConfig: vi.fn().mockReturnValue({ config: DEFAULT_CONFIG, corrupted: false }),
    setSystemPromptConfig: vi.fn().mockReturnValue({ ok: true }),
  }

  const modelService: IModelService = {
    aggregateModels: vi.fn().mockReturnValue([]),
    switchModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    discoverModelsFromApi: vi.fn().mockResolvedValue([]),
  }

  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      sendErrorCalls.push({ code, message, id })
    }),
    configService: configService as unknown as IConfigService,
    sessionService: {} as unknown as ISessionService,
    modelService,
    skillRegistry: { getGlobalSkills: () => [], getProjectSkills: vi.fn().mockResolvedValue([]) } as unknown as SettingsHandlerContext['skillRegistry'],
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
  }

  const handler = new SettingsMessageHandler(ctx)
  return { handler, ctx, configService, replies, broadcasts, sendErrorCalls }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('SettingsMessageHandler system-prompt routes', () => {
  it('config.getSystemPrompt → reply config.systemPrompt { config, corrupted }', async () => {
    const { handler, ctx, configService, replies } = makeHandler()
    configService.getSystemPromptConfig.mockReturnValue({ config: DEFAULT_CONFIG, corrupted: false })

    const handled = await handler.handleSettingsMessage(msg('config.getSystemPrompt', {}), WS)

    expect(handled).toBe(true)
    expect(configService.getSystemPromptConfig).toHaveBeenCalledTimes(1)
    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: DEFAULT_CONFIG, corrupted: false },
    })
    // 失败路径不应触发 error envelope
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('config.getSystemPrompt 读取损坏时 corrupted=true 仍正常回复', async () => {
    const { handler, configService, replies } = makeHandler()
    configService.getSystemPromptConfig.mockReturnValue({ config: DEFAULT_CONFIG, corrupted: true })

    await handler.handleSettingsMessage(msg('config.getSystemPrompt', {}), WS)

    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { corrupted: true },
    })
  })

  it('config.setSystemPrompt 成功 → 写盘 + reply + broadcast config.systemPrompt', async () => {
    const { handler, configService, replies, broadcasts } = makeHandler()
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'replace core' },
      append: { enabled: true, prompt: 'append extra' },
    }
    configService.setSystemPromptConfig.mockReturnValue({ ok: true })

    const handled = await handler.handleSettingsMessage(msg('config.setSystemPrompt', { config: cfg }), WS)

    expect(handled).toBe(true)
    expect(configService.setSystemPromptConfig).toHaveBeenCalledExactlyOnceWith(cfg)
    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: cfg, corrupted: false },
    })
    expect(broadcasts[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: cfg, corrupted: false },
    })
  })

  it('config.setSystemPrompt 失败 → 按 D10 错误信封回复，不广播', async () => {
    const { handler, configService, replies, broadcasts, sendErrorCalls } = makeHandler()
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'x'.repeat(16001) },
      append: { enabled: false, prompt: '' },
    }
    configService.setSystemPromptConfig.mockReturnValue({ ok: false, error: 'replace prompt exceeds max length' })

    const handled = await handler.handleSettingsMessage(msg('config.setSystemPrompt', { config: cfg }), WS)

    expect(handled).toBe(true)
    expect(configService.setSystemPromptConfig).toHaveBeenCalledExactlyOnceWith(cfg)
    expect(sendErrorCalls[0]).toMatchObject({
      code: 'set_system_prompt_failed',
      message: 'replace prompt exceeds max length',
      id: 'm1',
    })
    expect(replies).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })
})
