/**
 * SettingsTab 测试（P4-s4-w2 Settings tab 接入 shell）。
 *
 * 验收：渲染 MobileSettings（[data-testid=mobile-settings] 可见）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return { ...actual, settings: { ...actual.settings, updateSystem: vi.fn().mockResolvedValue(undefined) } }
})

import SettingsTab from '../SettingsTab.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SettingsTab（P4-s4-w2 Settings tab 接入）', () => {
  it('渲染 MobileSettings（[data-testid=mobile-settings] 可见）', () => {
    const wrapper = mount(SettingsTab)
    expect(wrapper.find('[data-testid="mobile-settings"]').exists()).toBe(true)
  })
})
