/**
 * ModelSelectPopover 纯受控化测试（W4 · Q2 修复）。
 *
 * 锁定：切换模型后 UI 不回退/消失。
 * - 纯受控：去掉本地 selected ref + watch（旧实现 onSelect 后本地态被旧 props 拉回，UI 闪退）
 * - currentName 解析复合串 "provider/modelId" → 裸 modelId → 查 ModelInfo.name
 *
 * mock 策略：vi.mock('@/api') 捕获 onModels 推入测试模型列表；mount ModelSelectPopover
 * （Popover 子组件默认 stub），断言触发器文案 + emit。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/model-select-popover.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ModelInfo } from '@xyz-agent/shared'

const { onModelsHandler } = vi.hoisted(() => ({
  onModelsHandler: { current: null as ((models: ModelInfo[]) => void) | null },
}))

vi.mock('@/api', () => ({
  model: {
    onModels: vi.fn((cb: (models: ModelInfo[]) => void) => {
      onModelsHandler.current = cb
      return () => { onModelsHandler.current = null }
    }),
  },
}))

import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  onModelsHandler.current = null
})

/** 推入模型列表（模拟 runtime model.list 推送） */
function pushModels(list: ModelInfo[]): void {
  onModelsHandler.current?.(list)
}

const MODELS: ModelInfo[] = [
  { id: 'claude-4', name: 'Claude 4', providerId: 'anthropic', providerName: 'Anthropic' },
  { id: 'gpt-4', name: 'GPT-4', providerId: 'openai', providerName: 'OpenAI' },
] as unknown as ModelInfo[]

describe('ModelSelectPopover 纯受控', () => {
  it('U18: props.selected 为复合串时，触发器显示对应模型名', async () => {
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
      global: { plugins: [] },
    })
    pushModels(MODELS)
    await wrapper.vm.$nextTick()
    // 触发器文案含模型名（title="切换模型" 的 Button 内 span）
    expect(wrapper.text()).toContain('Claude 4')
  })

  it('U18b: props.selected 变化时，触发器文案跟随更新（纯受控，不依赖本地副本）', async () => {
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    pushModels(MODELS)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Claude 4')

    // 父组件更新 selected（模拟 Composer 乐观更新后的 props 回传）
    await wrapper.setProps({ selected: 'openai/gpt-4' })
    expect(wrapper.text()).toContain('GPT-4')
    expect(wrapper.text()).not.toContain('Claude 4')
  })

  it('U19: onSelect 后 emit modelId+provider，不依赖本地态回写', async () => {
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    pushModels(MODELS)
    await wrapper.vm.$nextTick()

    // 直接调组件实例方法（绕过 Popover 交互）
    ;(wrapper.vm as unknown as { onSelect: (id: string, p: string) => void }).onSelect('gpt-4', 'openai')
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    // emitted('select')[0] = 第一次 emit 的参数数组，[0] = payload 对象
    expect(emitted![0][0]).toEqual({ modelId: 'gpt-4', provider: 'openai' })
  })

  it('U15: props.selected 为空串时，触发器显示空串对应的裸 id（空串场景由 Composer || 兜底处理）', async () => {
    // ModelSelectPopover 本身不兜底空串——它纯受控显示 selected。
    // 空串的裸 id 仍是空串，currentName fallback 到空串。
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: '' },
    })
    pushModels(MODELS)
    await wrapper.vm.$nextTick()
    // currentName = models.find(id==='')?.name ?? '' → ''
    expect(wrapper.find('[title="切换模型"]').exists()).toBe(true)
  })
})
