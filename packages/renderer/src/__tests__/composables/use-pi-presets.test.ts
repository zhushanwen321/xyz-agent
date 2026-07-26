/**
 * usePiPresets 编排层单测（pi-launch-presets wave1，TC-4/TC-5）。
 *
 * 覆盖：
 * - loadPresets()：mock presetApi.list/getDefault 并行调用，结果写 store（TC-4）
 * - loadPresets 降级：getDefault 失败不阻断 list 写 store（allSettled，TC-4 边界）
 * - setDefault(id)：乐观更新 store + 调 RPC（TC-5）
 *
 * mock 策略：mock @/api 的 preset 域（vi.hoisted 捕获调用），真 pinia + 真 preset store。
 * 验证编排层「RPC 拉取 → store 写入」接线正确（不验 RPC 本身——那是 preset-domain.test 的职责）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-pi-presets.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PiLaunchPreset } from '@xyz-agent/shared'

// mock preset 域（捕获 list/getDefault/setDefault 调用 + 可控返回值）
const presetApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  getDefault: vi.fn(),
  setDefault: vi.fn(),
}))
vi.mock('@/api', () => ({
  preset: presetApiMock,
}))

import { usePresetStore } from '@/stores/preset'
import { usePiPresets } from '@/composables/features/usePiPresets'

const FIXTURE_PRESETS: PiLaunchPreset[] = [
  { id: 'builtin:full', name: '全工具模式', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
  { id: 'builtin:readonly', name: '只读模式', builtin: true, order: 2, toolMode: 'allowlist', allowedTools: ['read'], extensionMode: 'all' },
]

beforeEach(() => {
  setActivePinia(createPinia())
  presetApiMock.list.mockReset()
  presetApiMock.getDefault.mockReset()
  presetApiMock.setDefault.mockReset()
})

describe('usePiPresets.loadPresets（TC-4）', () => {
  it('loadPresets() → list 与 getDefault 并行调用，结果写 store', async () => {
    presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
    presetApiMock.getDefault.mockResolvedValueOnce('builtin:full')

    const store = usePresetStore()
    const { loadPresets } = usePiPresets()
    await loadPresets()

    expect(presetApiMock.list).toHaveBeenCalledTimes(1)
    expect(presetApiMock.getDefault).toHaveBeenCalledTimes(1)
    expect(store.presets).toEqual(FIXTURE_PRESETS)
    expect(store.defaultPresetId).toBe('builtin:full')
  })

  it('loadPresets 降级：getDefault reject 不阻断 list 写 store（allSettled）', async () => {
    presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
    presetApiMock.getDefault.mockRejectedValueOnce(new Error('rpc failed'))

    const store = usePresetStore()
    const { loadPresets } = usePiPresets()
    await loadPresets()

    // list 成功 → presets 写入；getDefault 失败 → defaultPresetId 保持初值 ''
    expect(store.presets).toEqual(FIXTURE_PRESETS)
    expect(store.defaultPresetId).toBe('')
  })

  it('loadPresets 降级：list reject 不阻断 getDefault 写 store（allSettled）', async () => {
    presetApiMock.list.mockRejectedValueOnce(new Error('rpc failed'))
    presetApiMock.getDefault.mockResolvedValueOnce('builtin:readonly')

    const store = usePresetStore()
    const { loadPresets } = usePiPresets()
    await loadPresets()

    expect(store.presets).toEqual([])
    expect(store.defaultPresetId).toBe('builtin:readonly')
  })
})

describe('usePiPresets.setDefault（TC-5）', () => {
  it('setDefault(id) → 乐观更新 store + 调 RPC', async () => {
    presetApiMock.setDefault.mockResolvedValueOnce(undefined)

    const store = usePresetStore()
    const { setDefault } = usePiPresets()
    await setDefault('builtin:readonly')

    expect(store.defaultPresetId).toBe('builtin:readonly')
    expect(presetApiMock.setDefault).toHaveBeenCalledWith('builtin:readonly')
  })
})
