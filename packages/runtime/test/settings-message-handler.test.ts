/**
 * SettingsMessageHandler 单测 — 覆盖 config/model 分支路由 + 副作用广播（report #5）。
 *
 * 重点：
 * - setProvider/deleteProvider 带 newDefault 时广播 config.defaults（有副作用分支，最该补）
 * - discoverModels 三种错误翻译（ByteString / fetch failed / 原始）
 * - 基础路由：getProviders / model.list / model.switch / scanSkills / tool.approve
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/settings-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SettingsMessageHandler } from '../src/transport/settings-message-handler.js'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'

function makeHandler(overrides: { setProvider?: ReturnType<typeof vi.fn>; deleteProvider?: ReturnType<typeof vi.fn>; discover?: ReturnType<typeof vi.fn>; aggregate?: ReturnType<typeof vi.fn> } = {}) {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string; type: string; payload: Record<string, unknown> }[] = []
  const configService = {
    listProviders: vi.fn().mockReturnValue([{ id: 'p1' }]),
    setProvider: overrides.setProvider ?? vi.fn().mockReturnValue({}),
    deleteProvider: overrides.deleteProvider ?? vi.fn().mockReturnValue({}),
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
  }
  const modelService = {
    aggregateModels: overrides.aggregate ?? vi.fn().mockReturnValue([{ id: 'm1' }]),
    switchModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    discoverModelsFromApi: overrides.discover ?? vi.fn().mockResolvedValue([{ id: 'm1' }]),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string, type: string, payload: Record<string, unknown>) => replies.push({ id, type, payload })),
    sendError: vi.fn(),
    configService,
    sessionService: {},
    modelService,
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('p1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
  }
  const handler = new SettingsMessageHandler(ctx as unknown as ConstructorParameters<typeof SettingsMessageHandler>[0])
  return { ctx, replies, broadcasts, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}
const WS = {} as never

describe('SettingsMessageHandler', () => {
  describe('provider 副作用广播（最该补）', () => {
    it('setProvider 无 newDefault → 仅 reply + broadcastProviderList，不广播 config.defaults', async () => {
      const { ctx, broadcasts, handler } = makeHandler({ setProvider: vi.fn().mockReturnValue({}) })
      await handler.handleSettingsMessage(msg('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('setProvider 有 newDefault → 广播 config.defaults (source=provider-updated)', async () => {
      const { broadcasts, handler } = makeHandler({
        setProvider: vi.fn().mockReturnValue({ newDefault: { provider: 'p1', modelId: 'm1' } }),
      })
      await handler.handleSettingsMessage(msg('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d).toBeDefined()
      expect(d?.payload).toMatchObject({ defaultModel: 'p1/m1', source: 'provider-updated' })
    })

    it('deleteProvider 有 newDefault → 广播 config.defaults (source=provider-deleted)', async () => {
      const { broadcasts, handler } = makeHandler({
        deleteProvider: vi.fn().mockReturnValue({ newDefault: { provider: 'p2', modelId: 'm2' } }),
      })
      await handler.handleSettingsMessage(msg('config.deleteProvider', { providerId: 'p1' }), WS)
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d?.payload).toMatchObject({ defaultModel: 'p2/m2', source: 'provider-deleted' })
    })
  })

  describe('config.setDefaultModel（W3 默认模型持久化）', () => {
    it('调 configService.setDefaultModel(provider, modelId) + reply config.defaults + 广播给所有 panel', async () => {
      // W3：前端设置默认模型。handler 路由到 configService.setDefaultModel（已存在，写 settings.json），
      // 回发起端 reply config.defaults，并广播给所有 panel（与 setProvider/deleteProvider 的
      // newDefault 广播同构），让其它打开的设置面板同步默认模型下拉。
      const { ctx, replies, broadcasts, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setDefaultModel', { provider: 'p1', modelId: 'm1' }), WS)
      expect(ctx.configService.setDefaultModel).toHaveBeenCalledWith('p1', 'm1')
      // reply：回发起端，defaultModel 形如 "provider/modelId"
      expect(replies[0]).toMatchObject({ type: 'config.defaults', payload: { defaultModel: 'p1/m1' } })
      // 广播：推给所有 panel
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d).toBeDefined()
      expect(d?.payload).toMatchObject({ defaultModel: 'p1/m1' })
    })
  })

  describe('基础路由', () => {
    it('config.getProviders → reply config.providers', async () => {
      const { replies, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.getProviders', {}), WS)
      expect(replies[0]).toMatchObject({ type: 'config.providers', payload: { providers: [{ id: 'p1' }] } })
    })
    it('model.list → aggregateModels + reply', async () => {
      const { replies, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('model.list', {}), WS)
      expect(replies[0]).toMatchObject({ type: 'model.list', payload: { models: [{ id: 'm1' }] } })
    })
    it('model.switch → switchModel 调用 + reply model.switched', async () => {
      const { ctx, replies, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('model.switch', { sessionId: 's1', provider: 'p1', modelId: 'm1' }), WS)
      expect(ctx.modelService.switchModel).toHaveBeenCalledWith('s1', 'p1', 'm1')
      expect(replies[0]).toMatchObject({ type: 'model.switched' })
    })
    it('config.scanSkills → reply scannedSkills + 广播 config.skills（修裂缝①）', async () => {
      const { replies, ctx, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.scanSkills', { sources: ['/x'] }), WS)
      expect(replies[0]).toMatchObject({ type: 'config.scannedSkills', payload: { success: true } })
      // 裂缝①核心修复：扫描后必须广播，让前端 onSkills 订阅推回
      expect(ctx.broadcastSkillList).toHaveBeenCalledOnce()
    })
    it('config.scanAgents → 广播 config.agents（修裂缝①）', async () => {
      const { ctx, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.scanAgents', { sources: ['/x'] }), WS)
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
    })
    it('config.setSkillDirs → 写 discovery + 广播 skill 列表 + 目录配置', async () => {
      const { replies, ctx, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setSkillDirs', { dirs: ['~/.pi/agent/skills', '~/.claude/skills'] }), WS)
      expect(ctx.configService.setSkillDirs).toHaveBeenCalledWith(['~/.pi/agent/skills', '~/.claude/skills'])
      expect(replies[0]).toMatchObject({ type: 'config.skillDirs' })
      expect(ctx.broadcastSkillList).toHaveBeenCalledOnce()
      expect(ctx.broadcastSkillDirs).toHaveBeenCalledOnce()
    })
    it('config.setAgentDirs → 写 discovery + 广播 agent 列表 + 目录配置', async () => {
      const { ctx, handler } = makeHandler()
      await handler.handleSettingsMessage(msg('config.setAgentDirs', { dirs: ['~/.agents/agents'] }), WS)
      expect(ctx.configService.setAgentDirs).toHaveBeenCalledWith(['~/.agents/agents'])
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
      expect(ctx.broadcastAgentDirs).toHaveBeenCalledOnce()
    })
    it('tool.approve/deny/always_allow → 落入 default return false（no-op 已移除，由 server unknown_type 兜底）', async () => {
      // 工具审批实际走 pi extension_ui_request (confirm) 流 + config.setToolPermissions，
      // 这些 type 无真实 handler，故 return false → server 发 unknown_type（对未知 type 的正确兜底）。
      const { handler } = makeHandler()
      const okApprove = await handler.handleSettingsMessage(msg('tool.approve', {}), WS)
      const okDeny = await handler.handleSettingsMessage(msg('tool.deny', {}), WS)
      const okAlways = await handler.handleSettingsMessage(msg('tool.always_allow', {}), WS)
      expect(okApprove).toBe(false)
      expect(okDeny).toBe(false)
      expect(okAlways).toBe(false)
    })
  })

  describe('discoverModels（handler 只 reply，错误翻译已下沉 model-service）', () => {
    it('成功 → reply discoveredModels success:true', async () => {
      const { replies, handler } = makeHandler({ discover: vi.fn().mockResolvedValue([{ id: 'm1' }]) })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', apiKey: 'k' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(replies[0].payload).toMatchObject({ success: true, models: [{ id: 'm1' }] })
    })
    it('service 抛错 → handler 透传 error.message（不再做翻译）', async () => {
      // model-service 已把 ByteString/fetch failed 翻译成中文文案（见 model-service.test.ts）；
      // handler 只 reply service 给的 message，不硬编码中文。
      const { replies, handler } = makeHandler({ discover: vi.fn().mockRejectedValue(new Error('请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符')) })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(replies[0].payload.success).toBe(false)
      expect(replies[0].payload.error).toContain('不支持的字符')
    })
    it('其他错误 → 原始消息透传', async () => {
      const { replies, handler } = makeHandler({ discover: vi.fn().mockRejectedValue(new Error('rate limited')) })
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(replies[0].payload.error).toBe('rate limited')
    })
    it('providerId 解析 apiKey（resolvedApiKey 传给 service）', async () => {
      const { ctx, replies, handler } = makeHandler()
      ctx.configService.getProvider = vi.fn().mockReturnValue({ apiKey: 'resolved-key' }) as never
      await handler.handleSettingsMessage(msg('config.discoverModels', { baseUrl: 'http://x', providerId: 'p1' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'resolved-key', undefined)
    })
  })
})
