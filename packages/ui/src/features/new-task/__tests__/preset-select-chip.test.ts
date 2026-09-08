/**
 * PresetSelectChip 组件测试（U2c：回显改读 resolveLaunchConfig 输出，废 B6 echo）。
 *
 * 覆盖面：
 * 1. 首屏冒烟（C-NT-5 沿袭）：landing 态 chip DOM 存在 + loadPresets 拉数据 + popover 展开选项 DOM。
 * 2. 回显语义（U2c 核心）：chip 显示 = createLaunchConfigView 对 preset 字段的解析输出——
 *    默认档回显（defaultPresetId 有值）、未设默认兜底 builtin:full（D3 默认链）、数据延迟
 *    到达响应式重算（P5①）、显式选择（用户点击 → emit select + 显示切 explicit 档）。
 *    同源性断言：组件外对相同输入直接调 resolveLaunchConfig，chip 文本 ≡ resolve 解析出的
 *    preset 名（「显示 ≡ 生效」在组件层的结构锁，L1 精神的组件实例）。
 *
 * 断言 DOM 结构（data-testid）+ preset.name 文案（不走 i18n，t() mock 返回 key）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/new-task
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PresetSelectChip from '../PresetSelectChip.vue'
import { NewTaskDepsKey, type NewTaskDeps } from '../new-task-deps'
import {
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  type PiLaunchPreset,
} from '@xyz-agent/shared'
import { resolveLaunchConfig } from '@xyz-agent/core'

/** 构造 mock NewTaskDeps（flow 用空鸭子对象，PresetSelectChip 不消费 flow） */
function makeDeps(overrides?: Partial<NewTaskDeps>): NewTaskDeps {
  const base: NewTaskDeps = {
    flow: {} as NewTaskDeps['flow'],
    recentWorkspaces: ref([]),
    listBranches: vi.fn(async () => ({ local: [], remote: [], defaultBranch: 'main' })),
    createWorktree: vi.fn(async () => ({ cwd: '', branch: '' })),
    detectWorkspace: vi.fn(async () => ({
      mode: 'not-repo' as const, wsRoot: '', barePath: '', repoRoot: '', defaultBranch: '',
    })),
    pickDirectory: vi.fn(async () => ({ canceled: true })),
    presets: ref<PiLaunchPreset[]>([]),
    defaultPresetId: ref(''),
    presetOpenRequest: ref(0),
    loadPresets: vi.fn(async () => {}),
    setDefaultPreset: vi.fn(async () => {}),
    toast: { error: vi.fn() },
  }
  return overrides ? { ...base, ...overrides } : base
}

/**
 * 样例预设：出厂 full 原样（isFactoryFullPreset 全等 → resolve 输出 presetId=undefined，
 * D3 不透传形态）+ 自定义预设（name「只读模式」，非出厂 → 正常透传 id）。
 */
function samplePresets(): PiLaunchPreset[] {
  const factoryFull = DEFAULT_PRESETS.find((p) => p.id === BUILTIN_PRESET_IDS.FULL)
  if (!factoryFull) throw new Error('DEFAULT_PRESETS 缺 builtin:full（shared 常量损坏）')
  return [
    factoryFull,
    {
      id: 'custom:read-only', name: '只读模式', description: '仅阅读', builtin: false, order: 9,
      toolMode: 'denylist', deniedTools: ['*'], extensionMode: 'none',
    },
  ]
}

/** 同源解析：与组件 displayPresetId 相同的输入调 resolveLaunchConfig，取显示语义 id。 */
function resolveDisplayPresetId(input: {
  pendingPreset?: string | null
  presets: PiLaunchPreset[]
  defaultPresetId?: string | null
}): string {
  const resolved = resolveLaunchConfig(input)
  return (
    resolved.presetId ??
    (input.presets.some((p) => p.id === BUILTIN_PRESET_IDS.FULL) ? BUILTIN_PRESET_IDS.FULL : '')
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('PresetSelectChip 首屏冒烟', () => {
  it('landing 态：chip-preset DOM 存在（loadPresets 拉数据，回显无手动写入）', async () => {
    const deps = makeDeps({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises() // onMounted → loadPresets（回显由 resolve 响应式视图自动完成）
    expect(wrapper.find('[data-testid="chip-preset"]').exists()).toBe(true)
    expect(deps.loadPresets).toHaveBeenCalled()
  })

  it('landing 态 Popover 展开：预设选项 DOM 存在（Teleport 到 body，断言 document.body）', async () => {
    const deps = makeDeps({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(document.querySelector('[data-testid="preset-option-builtin:full"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="preset-option-custom:read-only"]')).not.toBeNull()
  })
})

describe('PresetSelectChip 回显 = resolve 输出（U2c，D3 默认预设生效化）', () => {
  it('未显式选择：chip 显示默认预设解析档（displayPresetId = resolve 输出）', async () => {
    const presets = samplePresets()
    const deps = makeDeps({
      presets: ref(presets),
      defaultPresetId: ref('custom:read-only'),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    // 同源断言：resolve 输出的 preset 名 ≡ chip 文本（显示 ≡ 生效的结构锁）
    const displayId = resolveDisplayPresetId({ presets, defaultPresetId: 'custom:read-only' })
    const resolvedName = presets.find((p) => p.id === displayId)?.name ?? displayId
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain(resolvedName)
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })

  it('未设默认（defaultPresetId 空）：resolve 默认链兜底 builtin:full，chip 显示「全工具模式」', async () => {
    // D3 行为变化声明：现状（B6 echo）此场景 selectedPresetId 恒空 → 永显「加载中…」；
    // 改线后显示 = resolve 输出（builtin:full 默认档，出厂等价 presetId=undefined 不透传）
    const presets = samplePresets()
    const deps = makeDeps({
      presets: ref(presets),
      defaultPresetId: ref(''),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(resolveDisplayPresetId({ presets, defaultPresetId: '' })).toBe(BUILTIN_PRESET_IDS.FULL)
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
  })

  it('presets 延迟到达：resolve 响应式重算，chip 脱离「加载中…」（P5①）', async () => {
    const presetsRef = ref<PiLaunchPreset[]>([])
    const defaultRef = ref('')
    const deps = makeDeps({ presets: presetsRef, defaultPresetId: defaultRef })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain(
      'newTask.presetSelect.loadingPresets',
    )
    // 数据到达（loadPresets 写 deps 侧 store）：无任何手动回显，chip 自动重算
    presetsRef.value = samplePresets()
    defaultRef.value = 'custom:read-only'
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })

  it('用户点击：emit select { presetId } + 显示切 explicit 档（显式 > 默认，emit 契约不变）', async () => {
    const presets = samplePresets()
    const deps = makeDeps({
      presets: ref(presets),
      defaultPresetId: ref(''), // 默认档解析为 builtin:full
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    // 点击自定义项：显式选择（PopoverListItem Teleport 到 body）
    const option = document.querySelector<HTMLElement>('[data-testid="preset-option-custom:read-only"]')!
    option.click()
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([[{ presetId: 'custom:read-only' }]])
    // 显示切 explicit 档 = resolve 输出（pendingPreset=custom:read-only）
    const displayId = resolveDisplayPresetId({
      pendingPreset: 'custom:read-only', presets, defaultPresetId: '',
    })
    expect(displayId).toBe('custom:read-only')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })
})
