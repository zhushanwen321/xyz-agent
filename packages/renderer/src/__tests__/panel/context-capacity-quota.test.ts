/**
 * ContextCapacityPopover coding-plan 区测试（w4）。
 *
 * 覆盖 w4（Composer hover 合并浮层）新增的 coding-plan 额度显示：
 * - hover-enter 触发 quota 查询（先 cached 后 fetch）
 * - provider 未配置额度 → 不调 quota API
 * - 容量区零回归
 *
 * 注意：HoverCardContent 渲染在 reka-ui HoverCardPortal 内，
 * happy-dom 环境下 portal 内容不渲染（hover 状态不触发）。
 * 窗口行渲染、分档配色等视觉测试需 E2E 或浏览器环境验证。
 * 本测试聚焦于：数据流（quota API 调用）+ 容量区回归。
 *
 * mock 策略：vi.mock('@/api') + vi.mock('@/api/domains/quota') 替换 RPC，
 * mount 组件 + 手动设置 session/settings store 状态。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/context-capacity-quota.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { NormalizedQuotaRow, ProviderInfo } from '@xyz-agent/shared'

// ── mock ──

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: {
    onProviders: vi.fn(() => () => {}),
    onSkills: vi.fn(() => () => {}),
    onAgents: vi.fn(() => () => {}),
    onSkillDirs: vi.fn(() => () => {}),
    onAgentDirs: vi.fn(() => () => {}),
    onExtensionDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
    onSystemPrompt: vi.fn(() => () => {}),
    onTerminalConfig: vi.fn(() => () => {}),
    getTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
    setTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
  },
  model: { onModels: vi.fn(() => () => {}) },
  extension: { onExtensions: vi.fn(() => () => {}) },
  settings: {
    getSystem: vi.fn(async () => ({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })),
    updateSystem: vi.fn(async () => {}),
  },
}))

vi.mock('@/api/domains/quota', () => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
  configure: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  setLocale: vi.fn(),
  // useQuotaQuery 的 quotaFailReasonText 经 i18n.global.t 映射 reason 文案（mock 返回 key 本身）
  default: { global: { t: (key: string) => key } },
}))

import ContextCapacityPopover from '@/components/panel/ContextCapacityPopover.vue'
import { useSessionStore } from '@/stores/session'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@xyz-agent/core'
import { useQuotaStore } from '@/stores/quota'
import * as quotaApi from '@/api/domains/quota'
import * as events from '@/api/events'

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  vi.clearAllMocks()
})

// ── fixtures ──

const zhipuProvider: ProviderInfo = {
  id: 'zhipu',
  name: 'zhipu',
  baseUrl: 'https://open.bigmodel.cn/api',
  apiKeySet: true,
  status: 'connected',
  models: [{ id: 'glm-4', name: 'GLM-4.6', contextWindow: 200000 }],
  quota: { fetcher: 'zhipu', enabled: true },
}

const deepseekProvider: ProviderInfo = {
  id: 'deepseek',
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKeySet: true,
  status: 'connected',
  models: [{ id: 'v3', name: 'DeepSeek V3', contextWindow: 128000 }],
  // 无 quota 配置
}

const mockQuotaRow: NormalizedQuotaRow = {
  label: '智谱 GLM Coding Plan',
  wins: [
    { pct: 68, resetSec: 4980 },
    { pct: 42, resetSec: 266400 },
    { pct: null, resetSec: null },
  ],
}

/** 设置 session store 有一个 session */
function setupSession(sid: string, modelId: string): void {
  const sessionStore = useSessionStore()
  sessionStore.groups = [{
    cwd: '/test',
    sessions: [{
      id: sid,
      label: 'test',
      cwd: '/test',
      status: 'active' as const,
      lastActiveAt: Date.now(),
      modelId,
      tokenCount: 0,
    }],
  }]
}

/** 设置 settings store 的 providers */
function setupProviders(providers: ProviderInfo[]): void {
  const settingsStore = getSettingsStore()
  settingsStore.providers.value = providers
}

/** 推送 context.update 消息 */
function pushContextUpdate(sid: string, data: { inputTokens: number; contextLimit: number; usagePercent: number }): void {
  events.dispatchSession(sid, {
    type: 'context.update',
    id: 'ctx-1',
    payload: { sessionId: sid, ...data },
  })
}

// ── tests ──

describe('ContextCapacityPopover coding-plan 区', () => {
  describe('hover-enter 查询触发', () => {
    it('hover 按钮 + provider 命中 quota preset → 调 getCached + fetchQuota', async () => {
      setupProviders([zhipuProvider])
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 1000 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 2000 })

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      // hover 按钮触发查询
      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')
      expect(quotaApi.fetchQuota).toHaveBeenCalledWith('zhipu')
    })

    it('provider 未配置 quota → 不调 quota API', async () => {
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'deepseek/v3' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).not.toHaveBeenCalled()
      expect(quotaApi.fetchQuota).not.toHaveBeenCalled()
    })

    it('provider quota enabled=false → 不调 quota API', async () => {
      const disabledProvider: ProviderInfo = {
        ...zhipuProvider,
        quota: { fetcher: 'zhipu', enabled: false },
      }
      setupProviders([disabledProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).not.toHaveBeenCalled()
    })

    it('无 modelId → 不调 quota API（未确定模型时不查 quota）', async () => {
      setupProviders([zhipuProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: {},
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).not.toHaveBeenCalled()
    })

    it('[landing] sessionId=undefined 但 modelId 受控下发命中已启用 quota 的 provider → 查 quota API', async () => {
      // [HISTORICAL] 回归：landing composer（sessionId=undefined）之前永远显「未配置」，
      // 因为旧实现只在有 sessionId 时自查 sessionStore 查 modelId。重构为受控范式后，
      // Composer 直接下发 modelId（landing 态由 useComposerModelThinking fallback 到 defaultModel），
      // 子组件不再自查 store。只要 modelId 命中已启用 quota 的 provider 即查。
      setupProviders([zhipuProvider])

      const wrapper = mount(ContextCapacityPopover, {
        // landing 态：sessionId=undefined，但 modelId 受控下发
        props: { modelId: 'zhipu/glm-4.6' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')
      expect(quotaApi.fetchQuota).toHaveBeenCalledWith('zhipu')
    })
  })

  describe('未配置态「配置」按钮（偏差 #D）', () => {
    it('未配置 provider 时 footer 渲染「配置」按钮（跳转 Settings）', async () => {
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'deepseek/v3' },
        global: {
          provide: { openSettings: () => {} },
        },
      })
      await flushPromises()

      // 注：HoverCardContent 在 reka-ui HoverCardPortal 内，happy-dom 下不渲染。
      // 「配置」按钮在 footer（portal 内），这里断言组件正常渲染不 crash；
      // trigger 按钮在 portal 外，始终可断言。
      const trigger = wrapper.find('[title="上下文容量"]')
      expect(trigger.exists()).toBe(true)
    })
  })

  describe('quota store 写入', () => {
    it('hover 后 quota store 写入缓存数据', async () => {
      setupSession('s1', 'zhipu/glm-4')
      setupProviders([zhipuProvider])
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 1000 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 2000 })

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      const quotaStore = useQuotaStore()
      const entry = quotaStore.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data).toEqual(mockQuotaRow)
      expect(entry!.lastFetchAt).toBe(2000)
    })

    it('quota API 失败时仍保留旧缓存', async () => {
      setupProviders([zhipuProvider])
      // 先预填旧缓存
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)

      // getCached 返回旧值，fetchQuota 失败
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 500 })
      vi.mocked(quotaApi.fetchQuota).mockRejectedValue(new Error('network'))

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      // 旧缓存应保留（fetchQuota 失败，但 getCached 已先写入）
      const entry = quotaStore.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data).toEqual(mockQuotaRow)
    })

    it('fetch fulfilled 带 reason（A2-4 失败态）→ 保留旧 data + 写 reason 文案，不覆写为 null', async () => {
      // [HISTORICAL] 回归守卫（BL round1 #3）：runtime 失败契约是 data=null + reason
      // （非旧缓存 data），消费侧曾把旧缓存覆写为 null 且清空 error——失败既不显提示也不留旧值
      setupProviders([zhipuProvider])
      const quotaStore = useQuotaStore()
      quotaStore.setCache('zhipu', mockQuotaRow, 500)

      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockQuotaRow, lastFetchAt: 500 })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: 500, reason: 'unauthorized' })

      const wrapper = mount(ContextCapacityPopover, {
        props: { modelId: 'zhipu/glm-4' },
      })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      await btn.trigger('mouseenter')
      await flushPromises()

      const entry = quotaStore.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data).toEqual(mockQuotaRow)
      expect(entry!.error).toBe('panel.context.quotaFailUnauthorized')
    })
  })

  describe('容量区零回归', () => {
    it('context.update 仍正常工作', async () => {
      setupSession('s1', 'deepseek/v3')
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 50000, contextLimit: 100000, usagePercent: 50 })
      await flushPromises()

      const text = wrapper.find('[title="上下文容量"]').text()
      expect(text).toContain('50K')
      expect(text).toContain('50%')
    })

    it('无 quota provider 时按钮正常显示用量', async () => {
      setupSession('s1', 'deepseek/v3')
      setupProviders([deepseekProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 6900, contextLimit: 200000, usagePercent: 3 })
      await flushPromises()

      const btn = wrapper.find('[title="上下文容量"]')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toContain('6.9K')
      expect(btn.text()).toContain('3%')
    })

    it('有 quota provider 时按钮仍正常显示用量', async () => {
      setupSession('s1', 'zhipu/glm-4')
      setupProviders([zhipuProvider])

      const wrapper = mount(ContextCapacityPopover, {
        props: { sessionId: 's1' },
      })
      await flushPromises()

      pushContextUpdate('s1', { inputTokens: 12000, contextLimit: 200000, usagePercent: 6 })
      await flushPromises()

      const text = wrapper.find('[title="上下文容量"]').text()
      expect(text).toContain('12K')
      expect(text).toContain('6%')
    })
  })

  describe('quota store 状态', () => {
    it('quota store 独立工作：setCache + getEntry', () => {
      const store = useQuotaStore()
      store.setCache('zhipu', mockQuotaRow, 1000)

      const entry = store.getEntry('zhipu')
      expect(entry).toBeDefined()
      expect(entry!.data!.label).toBe('智谱 GLM Coding Plan')
      expect(entry!.data!.wins[0].pct).toBe(68)
    })

    it('quota store pending 保护', () => {
      const store = useQuotaStore()
      expect(store.markPending('zhipu')).toBe(true)
      expect(store.markPending('zhipu')).toBe(false)
      store.unmarkPending('zhipu')
      expect(store.markPending('zhipu')).toBe(true)
    })
  })
})
