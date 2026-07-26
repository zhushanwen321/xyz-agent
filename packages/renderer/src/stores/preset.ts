/**
 * Preset store —— pi 启动预设的「纯状态容器」。
 *
 * 设计文档：docs/design/pi-launch-presets.md
 *
 * 职责（与其他 store 同构，纯状态容器铁律）：
 * - 持有 presets（预设列表）+ defaultPresetId（全局默认预设 id）两份 state。
 * - setPresets / setDefaultPresetId：纯写入 actions，由 composable（usePiPresets）喂数据。
 *
 * 不职责（已下沉到 usePiPresets composable）：
 * - 不 import @/api（订阅 / RPC 编排归 features 层 composable）。
 * - 不挂订阅（preset 域无 server-push 广播，按需 load）。
 *
 * 依赖方向（stores 间禁止互相 import；跨域协调由 composables/features 做）：
 * - 无外部依赖（仅 vue ref + shared 类型）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PiLaunchPreset } from '@xyz-agent/shared'

export const usePresetStore = defineStore('preset', () => {
  // ── State ──
  /** 全部预设列表（内置 + 自定义）。loadPresets 后填充，初值 []。 */
  const presets = ref<PiLaunchPreset[]>([])
  /**
   * 全局默认预设 id（设计文档 §5.3，存 pi-presets.json defaultPresetId）。
   * loadPresets 时从 preset.getDefault RPC 拉取填充；初值 ''（未加载）。
   * 缺省 'builtin:full'（runtime 在无配置时返回全工具模式）。
   */
  const defaultPresetId = ref('')
  /**
   * Landing 态用户当前选中的预设 id（session.create 透传用）。
   * PresetSelectChip 选中时写入，Composer onSend 时读取传给 session.create。
   * startFlow 时重置为 ''（与 pendingCwd/pendingModel 范式对齐）。
   */
  const selectedPresetId = ref('')

  // ── Actions（纯写入；RPC 编排 + 订阅生命周期在 usePiPresets composable）──

  /** 覆盖预设列表（loadPresets 拉到数据后写）。 */
  function setPresets(list: PiLaunchPreset[]): void {
    presets.value = list
  }

  /** 覆盖全局默认预设 id（loadPresets 拉到 / setDefault 乐观更新后写）。 */
  function setDefaultPresetId(id: string): void {
    defaultPresetId.value = id
  }

  /** Landing 态选中预设（PresetSelectChip emit select 时调用）。 */
  function selectPreset(id: string): void {
    selectedPresetId.value = id
  }

  /** 乐观更新：upsert 预设（按 id 匹配替换，不存在则 push）。 */
  function upsertPreset(preset: PiLaunchPreset): void {
    const idx = presets.value.findIndex((p) => p.id === preset.id)
    if (idx >= 0) {
      presets.value = [...presets.value.slice(0, idx), preset, ...presets.value.slice(idx + 1)]
    } else {
      presets.value = [...presets.value, preset]
    }
  }

  /** 乐观更新：移除预设（按 id 过滤）。 */
  function removePreset(presetId: string): void {
    presets.value = presets.value.filter((p) => p.id !== presetId)
  }

  return {
    // state
    presets,
    defaultPresetId,
    selectedPresetId,
    // actions（纯写入）
    setPresets,
    setDefaultPresetId,
    selectPreset,
    upsertPreset,
    removePreset,
  }
})
