/**
 * UpdateCheckCard · 手动升级通道区测试（update-network-resilience D9 renderer 衔接）。
 *
 * 覆盖（三视角 · 使用者黑盒：每用例断言用户可见 DOM）：
 *  - 默认展开：DOM 含引导文案 + 「仅支持 app 已提示的新版本」限定语 + 目录路径展示
 *  - 路径推导：getDataDir('~ 缩写形态) + /update/manual 与 main 侧 MANUAL_ASSET_DIR 同源
 *  - 折叠交互：点折叠触发器 → 引导内容从 DOM 消失
 *  - 降级：getDataDir 无值（web/mock 环境）→ 展示「路径暂不可用」占位而非报错
 *
 * Mock 策略（同 update-page.test.ts 结构）：
 *  - vi.mock('@/composables/features/settings/useAppUpdate') 隔离单例 state
 *  - vi.mock('@/lib/ipc') 提供 getDataDir（UpdateCheckCard 手动通道区的唯一 IPC 依赖）
 *  - i18n 走 vitest-i18n-setup 全局 mock（zh-CN 真实文案，断言用户可见文本）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/update-manual-channel.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import type { UpdateState } from '@xyz-agent/shared'

// ── mock 层 ──

const getDataDirMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ipc', () => ({
  getDataDir: getDataDirMock,
}))

const testState = reactive({
  state: 'idle' as UpdateState,
  latestRelease: null as { version: string; htmlUrl: string; releaseNotes: string } | null,
  errorMessage: '',
  errorSuggestion: '',
  percent: 0,
  releaseNotesHtml: '',
})

vi.mock('@/composables/features/settings/useAppUpdate', () => ({
  useAppUpdate: () => ({
    state: testState,
    checkForUpdate: vi.fn(() => Promise.resolve()),
    performDownload: vi.fn(() => Promise.resolve()),
    performInstall: vi.fn(() => Promise.resolve()),
    openFallbackUrl: vi.fn(() => Promise.resolve()),
    initAutoCheck: vi.fn(),
    restorePendingUpdate: vi.fn(),
    restorePreloadedUpdate: vi.fn(),
  }),
}))

import UpdateCheckCard from '@/components/settings/UpdateCheckCard.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  getDataDirMock.mockReset()
  // 默认：dev 数据目录（~ 缩写展示形态，与 bridge-handlers get-data-dir 返回一致）
  getDataDirMock.mockResolvedValue('~/.xyz-agent-dev')
  Object.assign(testState, {
    state: 'idle',
    latestRelease: null,
    errorMessage: '',
    errorSuggestion: '',
    percent: 0,
    releaseNotesHtml: '',
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('UpdateCheckCard 手动升级通道区（D9）', () => {
  it('默认展开：DOM 含引导文案与「仅支持 app 已提示的新版本」限定语', async () => {
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 引导文案（用户可见）
    const hint = wrapper.find('[data-testid="settings-update-manual-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('从 release 页手动下载安装包')
    expect(hint.text()).toContain('重启应用或重试更新即可识别安装')
    // 限定语（D3 已知边界必须言明）
    const restriction = wrapper.find('[data-testid="settings-update-manual-restriction"]')
    expect(restriction.exists()).toBe(true)
    expect(restriction.text()).toContain('仅支持 app 已提示的新版本')
  })

  it('目录路径展示：getDataDir + /update/manual（与 main 侧 MANUAL_ASSET_DIR 同源）', async () => {
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    const dir = wrapper.find('[data-testid="settings-update-manual-dir"]')
    expect(dir.exists()).toBe(true)
    expect(dir.text()).toBe('~/.xyz-agent-dev/update/manual')
  })

  it('折叠交互：点触发器 → 引导内容从 DOM 消失（标题仍可见）', async () => {
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-update-manual-hint"]').exists()).toBe(true)
    await wrapper.find('[data-testid="settings-update-manual-toggle"]').trigger('click')
    // reka-ui CollapsibleContent 无 forceMount：关闭即卸载内容
    expect(wrapper.find('[data-testid="settings-update-manual-hint"]').exists()).toBe(false)
    // 折叠区标题（触发器文案）常驻
    expect(wrapper.find('[data-testid="settings-update-manual-toggle"]').text()).toContain('手动升级通道')
  })

  it('降级：getDataDir 无值（web/mock 环境）→ 展示「路径暂不可用」占位', async () => {
    getDataDirMock.mockResolvedValue(undefined)
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    const dir = wrapper.find('[data-testid="settings-update-manual-dir"]')
    expect(dir.exists()).toBe(true)
    expect(dir.text()).toBe('路径暂不可用')
  })
})
