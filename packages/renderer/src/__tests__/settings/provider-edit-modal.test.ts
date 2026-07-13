/**
 * ProviderEditModal 单测 —— api 类型 Select option 约束（W4 U7）。
 *
 * 锁定：pi 不支持 ollama 作为 api 标识（runtime 不做别名翻译，见 shared/constants PROVIDER_API_TYPES）。
 * 故 Select 的 option value 集合必须 ∈ PROVIDER_API_TYPES = ['anthropic-messages','openai-completions']，
 * 不得出现 'ollama'——否则保存时把 'ollama' 发给 runtime/pi，pi 不认。
 *
 * 验证方式：打开弹窗（provider=null 新增模式），从 teleport 到 body 的 SelectContent 读所有
 * SelectItem 的 data-value，断言无 'ollama' 且均为 PROVIDER_API_TYPES 成员。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/provider-edit-modal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PROVIDER_API_TYPES } from '@xyz-agent/shared'

/** config mock：useProviderEdit 调真实 transport 会挂起，全替掉。 */
const configMock = vi.hoisted(() => ({
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => []),
  setProvider: vi.fn(async () => {}),
  deleteProvider: vi.fn(async () => {}),
  testProvider: vi.fn(async () => ({ ok: true })),
  discoverModels: vi.fn(async () => ({ success: true, models: [], error: undefined })),
}))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

import ProviderEditModal from '@/components/settings/ProviderEditModal.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ProviderEditModal api 类型 Select option 约束', () => {
  it('U7: option 文案集合不含 Ollama，且提供 Anthropic Messages + OpenAI Compatible（与 PROVIDER_API_TYPES 对齐）', async () => {
    wrapper = mount(ProviderEditModal, {
      props: { open: true, provider: null },
      attachTo: document.body,
    })
    await flushPromises()

    // reka-ui Select 的 SelectContent 仅在 open 时挂载（SelectPortal teleport）。
    // 「类型」Select 的 trigger 即 SelectTrigger（[role=combobox"]）。
    // reka-ui SelectTrigger 在 pointerdown 时打开，happy-dom 下需显式 dispatch。
    const combo = document.body.querySelector('[role="combobox"]') as HTMLElement | null
    expect(combo).toBeTruthy()
    combo!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    combo!.click()
    await flushPromises()

    // SelectItem 渲染为 [role=option]。reka-ui 不把 value 暴露成 data-value 属性，
    // 故用 option 文案断言：必须出现两个 pi 支持类型，且不得出现 Ollama。
    const options = document.body.querySelectorAll('[role="option"]')
    expect(options.length).toBeGreaterThan(0)
    const labels = Array.from(options).map((el) => el.textContent ?? '')

    // 不含 ollama 文案（pi 不支持 ollama 作为 api 标识）
    const joined = labels.join('|')
    expect(joined).not.toContain('Ollama')
    expect(joined).not.toContain('ollama')
    // 提供与 PROVIDER_API_TYPES 对齐的两个 option（文案固定）
    expect(labels).toContain('Anthropic Messages')
    expect(labels).toContain('OpenAI Compatible')

    // 兜底：form.api 初始值也必须在白名单内（v-model 默认值合规）
    const apiVal = (wrapper!.vm as unknown as { form: { api: string } }).form.api
    expect(new Set<string>(PROVIDER_API_TYPES).has(apiVal)).toBe(true)
  })
})
