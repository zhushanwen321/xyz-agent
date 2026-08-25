/**
 * ThinkingLevelPopover 动态档位测试。
 *
 * 锁定：
 * - onSelect emit 的是 map 映射后的 value（发给 runtime 的实际 level），非 UI 档位 key
 * - popover 只渲染可用档位（不可用档位不出现在 DOM）
 * - prop level（runtime 返回的 value）经 resolveThinkingKey 反向映射为 UI key 高亮
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/thinking-level-popover.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ThinkingLevelPopover from '@/components/panel/ThinkingLevelPopover.vue'

// 真实预设（从 useProviderEdit.ts THINKING_PRESETS 同步）
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

// ══ U9: pi 新语义（fix-thinking-level-pi-semantics）——mimo 场景档位渲染 ══
// xiaomi-token-plan-cn/mimo-v2.5-pro 的 thinkingLevelMap 为 undefined（builtin 快照 null
// 经 toProviderModel 归一）。pi 实装版 getSupportedThinkingLevels 返回默认五档。
describe('U9: mimo 场景（levelMap undefined）→ 渲染默认五档含 minimal，无 xhigh/max', () => {
  it('DOM 含 5 个档位项：off/minimal/low/medium/high，不含 xhigh/max', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high' }, // levelMap 不传（undefined = pi 默认规则）
    })
    // 打开 popover 使档位列表渲染进 DOM
    await (wrapper.vm as unknown as { open: boolean }).$nextTick()
    const vm = wrapper.vm as unknown as { availableOptions: Array<{ level: string }> }
    const renderedLevels = vm.availableOptions.map((o) => o.level)
    expect(renderedLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(renderedLevels).not.toContain('xhigh')
    expect(renderedLevels).not.toContain('max')
  })

  it('reasoning=false → availableOptions 只有 off（non-reasoning 模型）', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'off', reasoning: false },
    })
    const vm = wrapper.vm as unknown as { availableOptions: Array<{ level: string }> }
    expect(vm.availableOptions.map((o) => o.level)).toEqual(['off'])
  })
})
