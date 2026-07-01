/**
 * ThinkingLevelPopover 动态档位测试（W5 · Q3）。
 *
 * 锁定：组件按 props.levelMap（当前模型的 thinkingLevelMap）动态标记可用档位。
 * - 不可用档位（value 为 null）渲染 opacity-50 + cursor-not-allowed
 * - onSelect 不可用档位时不 emit
 * - 可用档位正常 emit + 关闭 popover
 *
 * 注意：重置逻辑（当前 level 不可用时 emit 重置到最高可用档）在 Composer 的 watch 里，
 * 不在 ThinkingLevelPopover 内。此测试只覆盖渲染 + onSelect 守卫。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/thinking-level-popover.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ThinkingLevelPopover from '@/components/panel/ThinkingLevelPopover.vue'

// 真实预设（从 ProviderEditModal.vue:312-316 复制）
const HIGH_MAX_MAP = { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' }
const ON_OFF_MAP = { minimal: null, low: null, medium: null, high: null, xhigh: 'xhigh' }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ThinkingLevelPopover 动态档位', () => {
  // 渲染层断言（opacity-50 / cursor-not-allowed）依赖 PopoverContent 渲染，
  // reka-ui Popover 在 happy-dom 下 portal/teleport 不稳定，故渲染正确性靠 E4 手动验证。
  // 以下测试覆盖 onSelect 行为守卫（availableLevels.has 判定）—— 逻辑层的可判定断言。

  it('U28: 点击不可用档位（off，high-max 预设下）不 emit select', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high', levelMap: HIGH_MAX_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'off', label: '关', en: 'off', available: true })
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('点击可用档位（max，high-max 预设下）正常 emit', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high', levelMap: HIGH_MAX_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'max', label: '最高', en: 'max', available: true })
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('max')
  })

  it('U26: on-off 预设下仅 xhigh 可用，点击 high（不可用）不 emit', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'xhigh', levelMap: ON_OFF_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'high', label: '高', en: 'high', available: true })
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('levelMap=undefined（all-levels）时全档可用，点击任意档位正常 emit', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'medium' },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'off', label: '关', en: 'off', available: true })
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('off')
  })
})
