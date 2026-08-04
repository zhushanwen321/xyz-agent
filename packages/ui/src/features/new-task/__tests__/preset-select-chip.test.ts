/**
 * PresetSelectChip 首屏冒烟（C-NT-5，w4 new-task-search UI 迁移）。
 *
 * 首屏冒烟：mount PresetSelectChip（landing 态 sessionId=null）+ provide NewTaskDepsKey
 * （loadPresets resolve + presets 有值 + defaultPresetId 有值），断言 [data-testid=chip-preset]
 * DOM 存在；presetOpen=true 时 Popover 展开断言 [data-testid^=preset-option-] 选项 DOM 存在。
 * 断言 DOM 结构（data-testid），不断言文案（vitest.setup mock vue-i18n）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/new-task
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PresetSelectChip from '../PresetSelectChip.vue'
import { NewTaskDepsKey, type NewTaskDeps } from '../new-task-deps'
import type { PiLaunchPreset } from '@xyz-agent/shared'

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

function samplePresets(): PiLaunchPreset[] {
  return [
    { id: 'builtin:tools', name: '工具模式', description: '全部工具', builtin: true, order: 1, toolMode: 'all', extensionMode: 'all' },
    { id: 'builtin:read', name: '只读模式', description: '仅阅读', builtin: true, order: 2, toolMode: 'denylist', deniedTools: ['*'], extensionMode: 'none' },
  ]
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('PresetSelectChip 首屏冒烟', () => {
  it('landing 态：chip-preset DOM 存在（loadPresets 后回显默认预设）', async () => {
    const deps = makeDeps({
      presets: ref(samplePresets()),
      defaultPresetId: ref('builtin:tools'),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises() // onMounted → loadPresets → 回显 defaultPresetId
    expect(wrapper.find('[data-testid="chip-preset"]').exists()).toBe(true)
    expect(deps.loadPresets).toHaveBeenCalled()
  })

  it('landing 态 Popover 展开：预设选项 DOM 存在（Teleport 到 body，断言 document.body）', async () => {
    const deps = makeDeps({
      presets: ref(samplePresets()),
      defaultPresetId: ref('builtin:tools'),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').exists()).toBe(true)
    // PopoverContent 经 PopoverPortal Teleport 到 document.body（reka-ui 默认），
    // 对齐 useSearchModal.test.ts 的 Teleport 断言先例
    await flushPromises()
    expect(document.querySelector('[data-testid="preset-option-builtin:tools"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="preset-option-builtin:read"]')).not.toBeNull()
  })
})
