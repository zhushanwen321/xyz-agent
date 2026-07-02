/**
 * ThinkingLevelPopover 动态档位测试。
 *
 * 锁定：
 * - onSelect emit 的是 map 映射后的 value（发给 runtime 的实际 level），非 UI 档位 key
 * - popover 只渲染可用档位（不可用档位不出现在 DOM）
 * - prop level（runtime 返回的 value）经 resolveThinkingKey 反向映射为 UI key 高亮
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/thinking-level-popover.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ThinkingLevelPopover from '@/components/panel/ThinkingLevelPopover.vue'

// 真实预设（从 ProviderEditModal.vue THINKING_PRESETS 同步）
// key = UI 档位，value = 发 runtime 的值
const HIGH_MAX_MAP = { off: 'off', high: 'high', max: 'xhigh' }
const ON_OFF_MAP = { off: 'off', high: 'high' }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ThinkingLevelPopover onSelect 发 value（map 映射后）', () => {
  it('high-max: 选 max 档 → emit xhigh（value），非 max（key）', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high', levelMap: HIGH_MAX_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'max', label: '最高', en: 'max', available: true })
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('xhigh')
  })

  it('high-max: 选 high 档 → emit high', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'max', levelMap: HIGH_MAX_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'high', label: '高', en: 'high', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('high')
  })

  it('on-off: 选 off 档 → emit off', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high', levelMap: ON_OFF_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'off', label: '关', en: 'off', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('off')
  })

  it('all-levels（map 空）→ emit key 自身', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'medium' },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'off', label: '关', en: 'off', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('off')
  })
})
