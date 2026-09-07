/**
 * UpdatePage · 更新来源三选控件测试（update-multi-source u-settings-ui）。
 *
 * 覆盖（更新来源行，自动更新卡内）：
 *  - testid 存在：DOM 含 select-update-source（SelectTrigger）
 *  - 三选项渲染：下拉打开后 option 文案含「自动（推荐）」「GitHub」「AtomGit」
 *  - 加载回填：getUpdateSettings.updateSource → trigger 显示对应选项；字段缺失 → 缺省「自动（推荐）」
 *  - 切换持久化：点选 GitHub → setUpdateSettings({ updateSource: 'github' }) 且 trigger 显示 GitHub
 *  - 不触发 force 检查：切换只写偏好，checkForUpdate 不被调用（D3：生效以缓存 TTL 为界）
 *  - 失败回滚：setUpdateSettings reject → trigger 保持原选项 + toast error（不抛错）
 *
 * Mock 策略（同 settings/update-page.test.ts）：
 *  - vi.mock('@/api/domains/settings') 捕获 getUpdateSettings/setUpdateSettings
 *  - vi.mock('@/composables/useToast') 隔离 toast
 *  - vi.mock('@/composables/features/settings/useAppUpdate')（UpdateCheckCard 唯一外部依赖）
 *  - Select 交互经 reka-ui 真实组件：pointerdown 打开下拉（SelectPortal teleport 到 body），
 *    在 document.body 找 [role="option"] 点选（同 settings/system-page-rename-model.test.ts）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/update-page-source.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import type { UpdateState } from '@xyz-agent/shared'

// __APP_VERSION__ 在 vitest-i18n-setup.ts 全局 stub（'0.0.0-test'）

// ── mock 捕获层（vi.hoisted 保证在 vi.mock 工厂执行前就绪） ──
const settingsMock = vi.hoisted(() => ({
  getProxyConfig: vi.fn(() => Promise.resolve({ mode: 'system', httpProxy: '', httpsProxy: '' })),
  setProxyConfig: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(() => Promise.resolve({ success: true, message: '' })),
  getUpdateSettings: vi.fn(() => Promise.resolve({ preDownload: false, autoUpdate: false })),
  setUpdateSettings: vi.fn(() => Promise.resolve()),
}))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@/api/domains/settings', () => ({
  getProxyConfig: settingsMock.getProxyConfig,
  setProxyConfig: settingsMock.setProxyConfig,
  testProxy: settingsMock.testProxy,
  getUpdateSettings: settingsMock.getUpdateSettings,
  setUpdateSettings: settingsMock.setUpdateSettings,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))

// UpdateCheckCard → useAppUpdate 单例 state（同 update-page.test.ts mock 结构）
const testState = reactive({
  state: 'idle' as UpdateState,
  latestRelease: null as { version: string; htmlUrl: string; releaseNotes: string } | null,
  errorMessage: '',
  percent: 0,
  releaseNotesHtml: '',
})

const checkForUpdateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock('@/composables/features/settings/useAppUpdate', () => ({
  useAppUpdate: () => ({
    state: testState,
    checkForUpdate: checkForUpdateMock,
    performDownload: vi.fn(() => Promise.resolve()),
    performInstall: vi.fn(() => Promise.resolve()),
    openFallbackUrl: vi.fn(() => Promise.resolve()),
    initAutoCheck: vi.fn(),
    restorePendingUpdate: vi.fn(),
    restorePreloadedUpdate: vi.fn(),
  }),
}))

import UpdatePage from '@/components/settings/update/UpdatePage.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  settingsMock.getProxyConfig.mockReset()
  settingsMock.setProxyConfig.mockReset()
  settingsMock.testProxy.mockReset()
  settingsMock.getUpdateSettings.mockReset()
  settingsMock.setUpdateSettings.mockReset()
  toastMock.info.mockReset()
  toastMock.error.mockReset()
  settingsMock.getProxyConfig.mockResolvedValue({ mode: 'system', httpProxy: '', httpsProxy: '' })
  settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
  settingsMock.setUpdateSettings.mockResolvedValue(undefined)
  Object.assign(testState, {
    state: 'idle',
    latestRelease: null,
    errorMessage: '',
    percent: 0,
    releaseNotesHtml: '',
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** 打开 select-update-source 的下拉（reka-ui：pointerdown 打开，SelectPortal teleport 到 body） */
async function openSourceDropdown(): Promise<HTMLOptionElement[]> {
  const trigger = wrapper!.find('[data-testid="select-update-source"]').element as HTMLElement
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  trigger.click()
  await flushPromises()
  return Array.from(document.body.querySelectorAll('[role="option"]')) as HTMLOptionElement[]
}

/** 在已打开的下拉中点选指定文案的 option */
async function pickOption(label: string): Promise<void> {
  const options = await openSourceDropdown()
  const target = options.find((el) => (el.textContent ?? '').includes(label))
  expect(target, `option "${label}" should exist in dropdown`).toBeTruthy()
  target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  target!.click()
  await flushPromises()
}

describe('UpdatePage 更新来源三选控件', () => {
  it('testid 存在：DOM 含 select-update-source trigger', async () => {
    wrapper = mount(UpdatePage)
    await flushPromises()
    expect(wrapper.find('[data-testid="select-update-source"]').exists()).toBe(true)
  })

  it('三选项渲染：下拉 option 含「自动（推荐）」「GitHub」「AtomGit」', async () => {
    wrapper = mount(UpdatePage)
    await flushPromises()
    const options = await openSourceDropdown()
    const labels = options.map((el) => el.textContent ?? '')
    expect(labels).toContain('自动（推荐）')
    expect(labels).toContain('GitHub')
    expect(labels).toContain('AtomGit')
    expect(labels).toHaveLength(3)
  })

  it('加载回填：updateSource=atomgit → trigger 显示 AtomGit', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({
      preDownload: false,
      autoUpdate: false,
      updateSource: 'atomgit',
    })
    wrapper = mount(UpdatePage)
    await flushPromises()
    expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('AtomGit')
  })

  it('加载回填：updateSource 缺失（旧 settings 文件）→ 缺省显示「自动（推荐）」', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
    wrapper = mount(UpdatePage)
    await flushPromises()
    expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('自动（推荐）')
  })

  it('切换持久化：点选 GitHub → setUpdateSettings({ updateSource: "github" }) + trigger 显示 GitHub', async () => {
    wrapper = mount(UpdatePage)
    await flushPromises()
    await pickOption('GitHub')
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ updateSource: 'github' })
    // 持久化成功后 trigger 显示更新
    expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('GitHub')
  })

  it('切换持久化：点选 AtomGit → setUpdateSettings({ updateSource: "atomgit" })', async () => {
    wrapper = mount(UpdatePage)
    await flushPromises()
    await pickOption('AtomGit')
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ updateSource: 'atomgit' })
  })

  it('切换后不触发 force 检查：checkForUpdate 不被调用（D3：生效以缓存 TTL 为界）', async () => {
    wrapper = mount(UpdatePage)
    await flushPromises()
    await pickOption('GitHub')
    expect(checkForUpdateMock).not.toHaveBeenCalled()
  })

  it('持久化失败：trigger 保持原选项 + toast error（不抛错）', async () => {
    settingsMock.setUpdateSettings.mockRejectedValue(new Error('write failed'))
    wrapper = mount(UpdatePage)
    await flushPromises()
    await pickOption('GitHub')
    // 失败回滚：trigger 仍显示初始选项「自动（推荐）」
    expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('自动（推荐）')
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('write failed')
  })
})
