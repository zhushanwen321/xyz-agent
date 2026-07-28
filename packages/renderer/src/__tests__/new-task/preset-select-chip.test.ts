/**
 * PresetSelectChip 单测（pi-launch-presets wave2，TC-1~TC-5）。
 *
 * 覆盖三态 + 选择交互 + 设为默认：
 * - TC-1 landing 态：默认预设回显 + loadPresets 调用
 * - TC-2 landing 态：点预设项 → selectedPresetId 更新 + 触发按钮文案更新
 * - TC-3 landing 态：勾选「设为默认」→ setDefault 调用
 * - TC-4 已创建锁定态：锁图标 + 预设名 + HoverCard tooltip「不可更改」
 * - TC-5 历史 session 态：锁图标 + 「全工具模式」+ tooltip「历史 session」
 *
 * mock 策略：mock @/composables/features/usePiPresets（捕获 loadPresets/setDefault），
 * 真 pinia + 真 preset store（mount 前预填 presets/defaultPresetId 模拟 loadPresets 完成）。
 * Popover/HoverCard 用 stub 无条件渲染 slot（与 landing.test w3Stubs 同范式）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/preset-select-chip.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { PiLaunchPreset } from '@xyz-agent/shared'
import PresetSelectChip from '@/components/new-task/PresetSelectChip.vue'
import { usePresetStore } from '@/stores/preset'

// mock usePiPresets（捕获 loadPresets/setDefault 调用）
const piPresetsMock = vi.hoisted(() => ({
  loadPresets: vi.fn(),
  setDefault: vi.fn(),
}))
vi.mock('@/composables/features/usePiPresets', () => ({
  usePiPresets: () => piPresetsMock,
}))

// stub：Popover/HoverCard 无条件渲染 slot（聚焦事件路由 + 文案断言）
const stubs = {
  Popover: { template: '<div><slot /></div>' },
  PopoverTrigger: { template: '<div><slot /></div>' },
  PopoverContent: { template: '<div data-testid="popover-content"><slot /></div>' },
  HoverCard: { template: '<div><slot /></div>' },
  HoverCardTrigger: { template: '<div><slot /></div>' },
  HoverCardContent: { template: '<div data-testid="hover-content"><slot /></div>' },
}

const FIXTURE_PRESETS: PiLaunchPreset[] = [
  { id: 'builtin:full', name: '全工具模式', description: '所有工具可用', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
  { id: 'builtin:orchestrator', name: 'Orchestrator', description: '主 Agent 协调', builtin: true, order: 1, toolMode: 'denylist', deniedTools: ['read'], extensionMode: 'all' },
  { id: 'builtin:readonly', name: '只读模式', description: '只能查看代码', builtin: true, order: 2, toolMode: 'allowlist', allowedTools: ['read'], extensionMode: 'all' },
]

beforeEach(() => {
  setActivePinia(createPinia())
  piPresetsMock.loadPresets.mockReset()
  piPresetsMock.setDefault.mockReset()
  piPresetsMock.loadPresets.mockResolvedValue(undefined)
  piPresetsMock.setDefault.mockResolvedValue(undefined)
})

describe('PresetSelectChip landing 态（TC-1/TC-2/TC-3）', () => {
  it('TC-1 mount landing 态 → loadPresets 调用 + 触发按钮回显默认预设名', async () => {
    const store = usePresetStore()
    store.setPresets(FIXTURE_PRESETS)
    store.setDefaultPresetId('builtin:full')

    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, presetOpen: false },
      global: { stubs },
    })
    await flushPromises()

    expect(piPresetsMock.loadPresets).toHaveBeenCalledTimes(1)
    // 触发按钮回显默认预设名「全工具模式」
    const trigger = wrapper.find('[data-testid="chip-preset"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('全工具模式')
  })

  it('TC-2 点第 2 个预设项 → 触发按钮文案更新为「Orchestrator」', async () => {
    const store = usePresetStore()
    store.setPresets(FIXTURE_PRESETS)
    store.setDefaultPresetId('builtin:full')

    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, presetOpen: false },
      global: { stubs },
    })
    await flushPromises()

    // Popover stub 无条件渲染 slot，预设项在 DOM（PopoverListItem）。
    // 点第 2 个预设（Orchestrator）—— 用 preset-option testid 定位 PopoverListItem，
    // 触发其 click（PopoverListItem 是 Button，click 即选预设）。
    const orchestratorItem = wrapper.find('[data-testid="preset-option-builtin:orchestrator"]')
    expect(orchestratorItem.exists()).toBe(true)
    await orchestratorItem.trigger('click')
    await flushPromises()

    // 触发按钮文案更新为「Orchestrator」
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('Orchestrator')
    // emit select 事件
    expect(wrapper.emitted('select')).toBeTruthy()
    const lastSelect = wrapper.emitted('select')!.at(-1)!
    expect(lastSelect[0]).toEqual({ presetId: 'builtin:orchestrator' })
  })

  it('TC-3 勾选「设为默认」→ setDefault 被调 with selectedPresetId', async () => {
    const store = usePresetStore()
    store.setPresets(FIXTURE_PRESETS)
    store.setDefaultPresetId('builtin:full')

    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, presetOpen: false },
      global: { stubs },
    })
    await flushPromises()

    // 先选第 2 预设（Orchestrator），selectedPresetId 与默认不同
    const orchestratorItem = wrapper.find('[data-testid="preset-option-builtin:orchestrator"]')
    await orchestratorItem.trigger('click')
    await flushPromises()

    // 勾选 Checkbox（reka-ui Checkbox 渲染为 button[role=checkbox]，点击触发 update:model-value）
    const checkbox = wrapper.find('[data-testid="checkbox-set-default"]')
    expect(checkbox.exists()).toBe(true)
    await checkbox.trigger('click')
    await flushPromises()

    expect(piPresetsMock.setDefault).toHaveBeenCalledWith('builtin:orchestrator')
  })
})

describe('PresetSelectChip 已创建锁定态（TC-4）', () => {
  it('TC-4 sessionId 非空 + launchPresetId 有值 → 锁图标 + 预设名 + tooltip「不可更改」', async () => {
    const store = usePresetStore()
    store.setPresets(FIXTURE_PRESETS)

    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: 's1', launchPresetId: 'builtin:readonly', presetOpen: false },
      global: { stubs },
    })
    await flushPromises()

    // 锁定态用 chip-preset-locked testid（无 Popover）
    const locked = wrapper.find('[data-testid="chip-preset-locked"]')
    expect(locked.exists()).toBe(true)
    expect(locked.text()).toContain('只读模式')
    // 无 chip-preset（landing 态触发器）
    expect(wrapper.find('[data-testid="chip-preset"]').exists()).toBe(false)
    // HoverCard tooltip 文案
    const hover = wrapper.find('[data-testid="hover-content"]')
    expect(hover.exists()).toBe(true)
    expect(hover.text()).toContain('只读模式')
    expect(hover.text()).toContain('不可更改')
  })
})

describe('PresetSelectChip 历史 session 态（TC-5）', () => {
  it('TC-5 sessionId 非空 + launchPresetId undefined → 锁图标 + 「全工具模式」+ tooltip「历史 session」', async () => {
    const store = usePresetStore()
    store.setPresets(FIXTURE_PRESETS)

    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: 's1', presetOpen: false }, // launchPresetId 省略 = undefined = 历史 session
      global: { stubs },
    })
    await flushPromises()

    const locked = wrapper.find('[data-testid="chip-preset-locked"]')
    expect(locked.exists()).toBe(true)
    expect(locked.text()).toContain('全工具模式')
    // HoverCard tooltip 含历史 session 标注
    const hover = wrapper.find('[data-testid="hover-content"]')
    expect(hover.exists()).toBe(true)
    expect(hover.text()).toContain('历史 session')
    expect(hover.text()).toContain('未记录预设')
  })
})
