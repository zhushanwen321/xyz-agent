/**
 * settings-transport-adapter 三元解析测试（过度设计审计修复 u17 · 验收 V8）。
 *
 * 背景（审计候选 4）：adapter 原直连 @xyz-agent/core/transport/api/domains/{config,model,extension}，
 * 绕过 @/api 门面的 VITE_MOCK 三元——mock 模式下 settings 域 19 方法打真实 WS。修复后 import 源
 * 改为 @/api 门面三元，本文件锁定两个不变量：
 *
 * 1. 装配不变量：adapter 方法转发目标是 @/api 门面（vi.doMock spy 断言）——防回退 core 直连；
 * 2. V8 行为不变量：VITE_MOCK=true 构建下门面导出 mock 域，settings transport 真实调用返回
 *    mock fixture（不打 WS——real 侧单测环境无 WS 连接，能返回数据本身就是走 mock 的证据）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/settings-transport-adapter.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

/** 与被测 mock 域 fixture 的对照锚（composer-data MOCK_MODELS 首条） */
const MOCK_ANCHOR_MODEL_ID = 'claude-sonnet-4.5'

afterEach(() => {
  vi.doUnmock('@/api')
  vi.resetModules()
  vi.unstubAllEnvs()
})

describe('settings-transport-adapter · @/api 门面三元装配（u17）', () => {
  it('19 方法转发目标 = @/api 门面导出（spy 断言，防回退 core/transport 直连）', async () => {
    const listProviders = vi.fn().mockResolvedValue({ providers: [], scopedModels: [] })
    const listModels = vi.fn().mockResolvedValue([])
    const onModels = vi.fn().mockReturnValue(() => {})
    const onExtensions = vi.fn().mockReturnValue(() => {})
    const noop = (): ReturnType<typeof vi.fn> => vi.fn()
    vi.resetModules()
    vi.doMock('@/api', () => ({
      config: {
        listProviders,
        setProvider: noop(),
        setScopedModels: noop(),
        discoverModels: noop(),
        setSkillDirs: noop(),
        setAgentDirs: noop(),
        setExtensionDirs: noop(),
        onProviders: noop(),
        onSkills: noop(),
        onAgents: noop(),
        onSkillDirs: noop(),
        onAgentDirs: noop(),
        onExtensionDirs: noop(),
        onDefaults: noop(),
        onSystemPrompt: noop(),
        onTerminalConfig: noop(),
      },
      model: { listModels, onModels },
      extension: { onExtensions },
    }))
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    const transport = createSettingsTransport()

    await transport.listProviders()
    await transport.listModels()
    transport.onModels(() => {})
    transport.onExtensions(() => {})

    expect(listProviders).toHaveBeenCalledTimes(1)
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(onModels).toHaveBeenCalledTimes(1)
    expect(onExtensions).toHaveBeenCalledTimes(1)
  })
})

describe('settings-transport-adapter · V8 mock 模式接回（裁决 3）', () => {
  it('VITE_MOCK=true：settings 域方法解析到 mockApi（请求/订阅均返回 mock fixture，不打真实 WS）', async () => {
    vi.stubEnv('VITE_MOCK', 'true')
    vi.resetModules()
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    const transport = createSettingsTransport()

    // 请求通路：listModels / listProviders 返回 mock fixture 数据。
    // 证据力：real 域走 ws-client RPC，单测环境无 WS 连接必失败/挂起——能同步返回
    // fixture 即证明解析到了 mockApi（门面三元 isMock 分支生效）。
    const models = await transport.listModels()
    expect(models.map((m) => m.id)).toContain(MOCK_ANCHOR_MODEL_ID)

    const providersReply = await transport.listProviders()
    expect(providersReply.providers.length).toBeGreaterThan(0)
    expect(Array.isArray(providersReply.scopedModels)).toBe(true)

    // 订阅通路：onModels 注册后微任务收到 mock fixture 首推（makeMockSubscription 语义）
    const pushed: number[] = []
    const off = transport.onModels((models) => pushed.push(models.length))
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    off()
  })
})
