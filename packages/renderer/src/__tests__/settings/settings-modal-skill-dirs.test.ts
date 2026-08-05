/**
 * SettingsModal skill/agent 目录更新错误处理测试（W2 · D10，W4 壳接入适配）。
 *
 * bug 根因：onUpdateSkillDirs/onUpdateAgentDirs 调 settingsStore.setSkillDirs(...)
 * 未 await 未 catch。store 内 await 若 reject → unhandled rejection + 静默失败。
 *
 * W4 适配：setSkillDirs 经 core getSettingsTransport().setSkillDirs（不再直连 @/api config）。
 * 故本测试 provideSettingsTransport(stub)，stub.setSkillDirs reject，验证 toast 反馈。
 *
 * 验证（U5）：transport.setSkillDirs reject 时，onUpdateSkillDirs 触发的 toast 含 error 条目
 * （非静默吞，符合 CLAUDE.md 规则 #3：错误必须反馈）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/settings-modal-skill-dirs.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
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
import SettingsModal from '@/components/settings/SettingsModal.vue'
import SettingsResourcePage from '@/components/settings/resource/SettingsResourcePage.vue'
import type { SkillDirConfig } from '@xyz-agent/shared'
import { useToast } from '@/composables/useToast'

// lib/ipc mock（SystemPage/TerminalPage 读 systemSounds 等 ipc）
vi.mock('@/lib/ipc', () => ({
  listSystemSounds: vi.fn(async () => ({ sounds: [] })),
  getProxyConfig: vi.fn(async () => ({})),
  setProxyConfig: vi.fn(async () => undefined),
  testProxy: vi.fn(async () => ({ success: true })),
  // SettingsResourcePage forcedDirs 动态化调用（返回 undefined 走默认值兜底）
  getDataDir: vi.fn(async () => undefined),
}))

/** transport stub：setSkillDirs reject（测试核心），其余 resolve/noop。 */
function makeTransport(): SettingsTransport {
  const noop = (): void => {}
  return {
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    setProvider: vi.fn(async () => undefined),
    discoverModels: vi.fn(async () => ({ success: true, models: [] })),
    setSkillDirs: vi.fn(() => Promise.reject(new Error('network down'))),
    setAgentDirs: vi.fn(async () => undefined),
    setExtensionDirs: vi.fn(async () => undefined),
    onProviders: () => noop,
    onModels: () => noop,
    onSkills: () => noop,
    onAgents: () => noop,
    onExtensions: () => noop,
    onSkillDirs: () => noop,
    onAgentDirs: () => noop,
    onExtensionDirs: () => noop,
    onDefaults: () => noop,
    onSystemPrompt: () => noop,
    onTerminalConfig: () => noop,
  }
}

function inMemoryStorage() {
  const map = new Map<string, string>()
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v) },
    remove: async (k: string) => { map.delete(k) },
  }
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  __resetPlatformForTesting()
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
  providePlatform({ kind: 'mock', storage: inMemoryStorage(), webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) }, ipc: null })
  provideSettingsTransport(makeTransport())
  const { toasts } = useToast()
  toasts.value = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SettingsModal onUpdateSkillDirs 错误反馈（W2 D10）', () => {
  it('transport.setSkillDirs reject → 触发 error toast（非静默失败）', async () => {
    wrapper = mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
      global: {
        provide: {
          [SETTINGS_TOAST_KEY as symbol]: { error: (m: string) => useToast().error(m), info: (m: string) => useToast().info(m), warning: (m: string) => useToast().warning(m) },
          [USE_QUOTA_CONFIGURE_KEY as symbol]: () => ({ enabled: { value: false }, fetcherId: { value: undefined }, fetcherOptions: [], cookieInput: { value: '' }, apiKeyInput: { value: '' }, apiKeyConfigured: { value: false }, testStatus: { value: 'idle' }, testError: { value: '' }, quotaData: { value: null }, lastFetchAt: { value: null }, isCookieAuth: { value: false }, helpUrl: { value: undefined }, helpText: { value: undefined }, configuring: { value: false }, configureError: { value: '' }, toggleEnabled: vi.fn(), selectFetcher: vi.fn(), saveCookie: vi.fn(), saveApiKey: vi.fn(), testQuery: vi.fn(), reset: vi.fn() }),
          [SETTINGS_CONFIG_API_KEY as symbol]: { detectSources: vi.fn(async () => []) },
        },
      },
    })
    await flushPromises()

    // 切到 skill 菜单（SettingsResourcePage 在 skill 菜单下渲染）
    const skillBtn = document.body.querySelector('[data-testid="settings-nav-skill"]')
    expect(skillBtn).toBeTruthy()
    skillBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    const resourcePage = wrapper.findComponent(SettingsResourcePage)
    expect(resourcePage.exists()).toBe(true)
    const dirs: SkillDirConfig[] = [{ path: '/x', enabled: true }]
    resourcePage.vm.$emit('update-dirs', dirs)
    await flushPromises()

    // 断言：error toast 已产生（非静默吞）
    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'error')).toBe(true)
    expect(toasts.value.some((t) => t.message.includes('network down'))).toBe(true)
  })
})
