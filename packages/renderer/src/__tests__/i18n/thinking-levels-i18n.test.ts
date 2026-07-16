/**
 * i18n-frontend-p2 U3 + U4: thinking-levels 数据源 i18n 化（W2）。
 *
 * U3：thinking-levels 数据源加 labelKey，getDisplayLabel 走 t()。
 *     en-US + on-off 模式下 high 显示 'On'，6 个 labelKey 完整。
 * U4：ProviderEditModal 模板 thinkingStrategies 在 en-US 下显示英文策略名。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ThinkingLevelPopover from '@/components/panel/ThinkingLevelPopover.vue'
import ProviderEditModal from '@/components/settings/ProviderEditModal.vue'
import i18n, { setLocale } from '@/i18n'
import {
  THINKING_LEVELS,
  getDisplayLabel,
  type ThinkingLevel,
} from '@/components/panel/thinking-levels'
import { THINKING_STRATEGIES } from '@/composables/features/useProviderEdit'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('U3: thinking-levels 数据源 i18n 化', () => {
  it('THINKING_LEVELS 6 档全部带 labelKey 字段', () => {
    expect(THINKING_LEVELS).toHaveLength(6)
    for (const opt of THINKING_LEVELS) {
      expect(opt.labelKey).toBeDefined()
      expect(typeof opt.labelKey).toBe('string')
      expect(opt.labelKey).toMatch(/^composable\.thinkingLevel\./)
    }
  })

  it('en-US + on-off map 时 high 档 currentLabel === \'On\'', () => {
    setLocale('en-US')
    // on-off 模式：map 只有 off + high
    const map = { off: 'off', high: 'high' }
    const label = getDisplayLabel('high', map)
    expect(label).toBe('On')
  })

  it('zh-CN + 全档 map 时 high 档 currentLabel === \'高\'', () => {
    setLocale('zh-CN')
    const map = { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }
    const label = getDisplayLabel('high', map)
    expect(label).toBe('高')
  })
})

describe('U4: ProviderEditModal en-US 下显示英文策略名', () => {
  it('THINKING_STRATEGIES 3 项全部带 labelKey 字段', () => {
    expect(THINKING_STRATEGIES).toHaveLength(3)
    for (const s of THINKING_STRATEGIES) {
      expect(s.labelKey).toBeDefined()
      expect(typeof s.labelKey).toBe('string')
      expect(s.labelKey).toMatch(/^composable\.thinkingStrategy\./)
    }
  })

  it('en-US locale 下 THINKING_STRATEGIES 翻译为 All Levels / On / Off / High / Max', () => {
    setLocale('en-US')
    const labels = THINKING_STRATEGIES.map((s) => i18n.global.t(s.labelKey!))
    expect(labels).toEqual(['All Levels', 'On / Off', 'High / Max'])
  })
})
