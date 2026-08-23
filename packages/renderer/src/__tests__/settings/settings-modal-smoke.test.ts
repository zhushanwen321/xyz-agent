/**
 * SettingsModal 首屏冒烟（W4 · AC12 渲染 gate）。
 *
 * 验证 useSettingsShell 壳接入后 SettingsModal 能渲染关键 DOM（AGENTS.md 测试规范 §8）：
 * mount SettingsModal(open=true)，providePlatform(in-memory) + provideSettingsTransport(stub)
 * + provide 3 ui 注入 key stub + mock @/api 门面（避免 WS），断言：
 *   ① Dialog 内容渲染（标题 + 导航）
 *   ② provider 导航项存在（settings-nav-provider）
 *   ③ 默认 provider 页区渲染（ProviderPage 表单区）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/settings-modal-smoke.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { provide, ref } from 'vue'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  __resetSettingsStoreForTesting,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '@xyz-agent/core'
import {
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
  SETTINGS_CONFIG_API_KEY,
} from '@xyz-agent/ui/features/settings'

// @/api 门面 mock：所有 config/extension/model/settings 域返回空/resolved，避免 WS 调用。
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: {
    listProviders: vi.fn(async () => ({ providers: [] })),
    setProvider: vi.fn(async () => undefined),
    setSkillDirs: vi.fn(async () => undefined),
    setAgentDirs: vi.fn(async () => undefined),
    setExtensionDirs: vi.fn(async () => undefined),
    discoverModels: vi.fn(async () => ({ success: true, models: [] })),
    onProviders: vi.fn(() => () => {}),
    onModels: vi.fn(() => () => {}),
    onSkills: vi.fn(() => () => {}),
    onAgents: vi.fn(() => () => {}),
    onExtensions: vi.fn(() => () => {}),
    onSkillDirs: vi.fn(() => () => {}),
    onAgentDirs: vi.fn(() => () => {}),
    onExtensionDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
    // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
    onDefaultsWithSource: vi.fn(() => () => {}),
    onSystemPrompt: vi.fn(() => () => {}),
    onTerminalConfig: vi.fn(() => () => {}),
    detectSources: vi.fn(async () => []),
    // wave-oauth：SettingsModal → ProviderPage → useProviderOAuth onMounted 订阅 4 个 auth.* 事件（缺则 TypeError 崩 mount）
    onAuthDeviceCode: vi.fn(() => () => {}),
    onAuthAuthUrl: vi.fn(() => () => {}),
    onAuthSuccess: vi.fn(() => () => {}),
    onAuthError: vi.fn(() => () => {}),
  },
  model: { onModels: vi.fn(() => () => {}) },
  extension: { onExtensions: vi.fn(() => () => {}) },
  settings: {
    listProviders: vi.fn(async () => ({ providers: [] })),
    onProviders: vi.fn(() => () => {}),
    onExtensions: vi.fn(() => () => {}),
    getAutoRenameEnabled: vi.fn(async () => ({ enabled: false })),
    setAutoRenameEnabled: vi.fn(async () => ({ enabled: false })),
  },
}))

// lib/ipc mock：SystemPage/TerminalPage 读 systemSounds 等 ipc，避免 electronAPI 缺失报错。
vi.mock('@/lib/ipc', () => ({
  listSystemSounds: vi.fn(async () => ({ sounds: [] })),
  getProxyConfig: vi.fn(async () => ({})),
  setProxyConfig: vi.fn(async () => undefined),
  testProxy: vi.fn(async () => ({ success: true })),
}))

import SettingsModal from '@/components/settings/SettingsModal.vue'

/** 构造最小 SettingsTransport stub（订阅返回 noop 取消函数，请求返回空）。 */
function stubTransport(): SettingsTransport {
  const noopUnsub = (): void => {}
  return {
    listProviders: async () => ({ providers: [] }),
    listModels: async () => [],
    setProvider: async () => undefined,
    discoverModels: async () => ({ success: true, models: [] }),
    setSkillDirs: async () => undefined,
    setAgentDirs: async () => undefined,
    setExtensionDirs: async () => undefined,
    onProviders: () => noopUnsub,
    onModels: () => noopUnsub,
    onSkills: () => noopUnsub,
    onAgents: () => noopUnsub,
    onExtensions: () => noopUnsub,
    onSkillDirs: () => noopUnsub,
    onAgentDirs: () => noopUnsub,
    onExtensionDirs: () => noopUnsub,
    onDefaults: () => noopUnsub,
    onSystemPrompt: () => noopUnsub,
    onTerminalConfig: () => noopUnsub,
  }
}

/** 提供最小 in-memory KVStorage（满足 PlatformPort.storage 形状）。 */
function inMemoryStorage() {
  const map = new Map<string, string>()
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v) },
    remove: async (k: string) => { map.delete(k) },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetPlatformForTesting()
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
})

// 懒加载语义测试断言 document.activeElement，用例间必须卸载 teleport 到 body 的挂载件
enableAutoUnmount(afterEach)

describe('SettingsModal 首屏冒烟（AC12 渲染 gate）', () => {
  it('open=true 时渲染 Dialog 标题 + provider 导航项 + provider 页区', async () => {
    providePlatform({
      kind: 'mock',
      storage: inMemoryStorage(),
      webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
      ipc: null,
    })
    provideSettingsTransport(stubTransport())

    const wrapper = mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
      global: {
        provide: {
          [SETTINGS_TOAST_KEY as symbol]: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
          [USE_QUOTA_CONFIGURE_KEY as symbol]: () => ({
            fetcherId: ref(undefined), fetcherOptions: [], enabled: ref(false),
            cookieInput: ref(''), apiKeyInput: ref(''), apiKeyConfigured: ref(false),
            testStatus: ref('idle'), testError: ref(''), quotaData: ref(null),
            lastFetchAt: ref(null), isCookieAuth: ref(false), helpUrl: ref(undefined),
            helpText: ref(undefined), configuring: ref(false), configureError: ref(''),
            toggleEnabled: vi.fn(), selectFetcher: vi.fn(), saveCookie: vi.fn(),
            saveApiKey: vi.fn(), testQuery: vi.fn(), reset: vi.fn(),
          }),
          [SETTINGS_CONFIG_API_KEY as symbol]: { detectSources: vi.fn(async () => []) },
        },
      },
    })
    await flushPromises()

    // ① Dialog 标题渲染（settings.title → 中文「设置」）
    const body = document.body.textContent ?? ''
    expect(body).toContain('设置')
    // ② provider 导航项存在（Dialog 内容 teleport 到 document.body，用 DOM 查询）
    expect(document.body.querySelector('[data-testid="settings-nav-provider"]')).not.toBeNull()
    // ③ provider 页区渲染（ProviderPage「添加供应商」按钮，i18n 中文）
    expect(body).toContain('添加') // settings.provider.add 含「添加」
  })
})

describe('SettingsModal 懒加载挂载即 open 的 open 语义（W31 review major-1 回归防护）', () => {
  it('挂载即 open=true：refreshProviders 被调用 + 首个 nav 项获得焦点', async () => {
    providePlatform({
      kind: 'mock',
      storage: inMemoryStorage(),
      webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
      ipc: null,
    })
    // refreshProviders → getSettingsTransport().listProviders()（模块级单例）→ spy 在此
    const listProvidersSpy = vi.fn(async () => ({ providers: [] }))
    provideSettingsTransport({ ...stubTransport(), listProviders: listProvidersSpy })

    // 模拟 AppShell 懒加载场景：settingsOpen=true 与组件挂载同帧，props.open 初始即 true。
    // 修复前 watch 无 immediate，无变化沿 → 回调不执行 → refreshProviders/焦点初始化全部跳过。
    mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
      global: {
        provide: {
          [SETTINGS_TOAST_KEY as symbol]: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
          [USE_QUOTA_CONFIGURE_KEY as symbol]: () => ({
            fetcherId: ref(undefined), fetcherOptions: [], enabled: ref(false),
            cookieInput: ref(''), apiKeyInput: ref(''), apiKeyConfigured: ref(false),
            testStatus: ref('idle'), testError: ref(''), quotaData: ref(null),
            lastFetchAt: ref(null), isCookieAuth: ref(false), helpUrl: ref(undefined),
            helpText: ref(undefined), configuring: ref(false), configureError: ref(''),
            toggleEnabled: vi.fn(), selectFetcher: vi.fn(), saveCookie: vi.fn(),
            saveApiKey: vi.fn(), testQuery: vi.fn(), reset: vi.fn(),
          }),
          [SETTINGS_CONFIG_API_KEY as symbol]: { detectSources: vi.fn(async () => []) },
        },
      },
    })
    await flushPromises()

    // ① open 语义：providers 快照刷新被触发（settings-lifecycle「打开 modal 时刷新」契约）
    expect(listProvidersSpy).toHaveBeenCalledTimes(1)
    // ② 焦点语义：nextTick 后首个 nav 项（provider）获得焦点（键盘可达性）
    const firstNav = document.body.querySelector<HTMLElement>('[data-testid="settings-nav-provider"]')
    expect(firstNav).not.toBeNull()
    expect(document.activeElement).toBe(firstNav)
  })
})
