/**
 * Settings store —— 应用级配置的「纯状态容器」。
 *
 * 重构演进（2026-07-02 架构返工 G2）：
 * 原实现 store→api 直连 + 主动管理 7 个订阅生命周期（init/refreshProviders/dispose），
 * 是全项目唯一打破「store 不拉数据」铁律的 store。现订阅编排下沉到
 * useSettings composable（composables/features/useSettings.ts），本 store 退化为纯状态容器，
 * 与其他 store（session/chat/navigation…）同构：只持 state + 纯写入方法，由 composable 喂数据。
 *
 * 当前职责：
 * - 持有 providers / models / skills / agents / extensions / system / skillDirs / agentDirs / defaultModel 九份 state。
 * - setSystem(patch)：合并本地态 → 写 localStorage（settingsApi.updateSystem）→ 同步 DOM + i18n（applySystemToDom）。
 *   这是纯函数式副作用（无订阅、无跨 store 依赖），符合 store action 定位；订阅生命周期才必须归 composable。
 * - setSkillDirs / setAgentDirs：发请求持久化，靠后端广播推回权威值（订阅在 useSettings.init 注册）。
 *
 * 不再职责（已移至 useSettings composable）：
 * - init / refreshProviders / dispose（订阅生命周期编排）。
 *
 * 依赖方向（stores 间禁止互相 import；跨域协调由 composables/features 做）：
 * - 读 @/api settings（updateSystem 持久化）+ @/i18n（locale 切换）。
 * - 写 document.documentElement（data-theme 槽位）。
 * - 不再 import config / model / extension 订阅域（订阅编排移至 useSettings）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProviderInfo, SkillInfo, AgentInfo, SkillDirConfig, ModelInfo, ExtensionInfo, SystemPromptConfig } from '@xyz-agent/shared'
import { config, settings as settingsApi } from '@/api'
import type { SystemSettings } from '@/api'
import { setLocale } from '@/i18n'

/** 外观模式：暗色 / 亮色 / 跟随系统（与 api SystemSettings.theme 对齐） */
export type ThemeMode = SystemSettings['theme']

/** 配色主题：由 settings-shell spec §4 System 菜单定义，默认 cold-blue */
export type ColorTheme = string

export type { SystemSettings }

/**
 * Extension 类型：直接复用 shared ExtensionInfo（SSOT）。
 * 此前本地重复定义 ExtensionItem（tools 必填），但 shared ExtensionInfo 的 tools
 * 是可选（runtime 扫描到时才填），本地必填假设在真实 runtime 下导致 undefined.length 报错。
 * 现在 import ExtensionInfo 并 alias 为 ExtensionItem 保持现有 import 路径兼容。
 */
export type ExtensionItem = ExtensionInfo

const DEFAULT_SYSTEM: SystemSettings = {
  locale: 'zh-CN',
  theme: 'dark',
  themePreset: 'cold-blue',
  fontSize: 'medium',
}

export const useSettingsStore = defineStore('settings', () => {
  // ── State ──
  const providers = ref<ProviderInfo[]>([])
  /**
   * 聚合模型列表（runtime aggregateModels 产出，config.providers 解析后的扁平模型）。
   * 与 providers 同源（sendInitialState 同 step 推、broadcastProviderList 同步广播），
   * 故同样走常驻订阅（useSettings.init 注册，应用生命周期不断开）。
   * 放 store 而非 ModelSelectPopover 本地：组件随 Composer v-if 反复挂载卸载，
   * 本地 onMounted 订阅会错过 sendInitialState 一次性推送 → 列表空（2026-07-01 竞态修复）。
   */
  const models = ref<ModelInfo[]>([])
  const skills = ref<SkillInfo[]>([])
  const agents = ref<AgentInfo[]>([])
  const extensions = ref<ExtensionItem[]>([])
  const system = ref<SystemSettings>({ ...DEFAULT_SYSTEM })
  // ADR-0020 §1 加载路径配置（层 A 勾选/拖动用）：预设候选 + enabled 状态
  const skillDirs = ref<SkillDirConfig[]>([])
  const agentDirs = ref<SkillDirConfig[]>([])
  // 默认模型（"provider/modelId" 复合串，与 SessionSummary.modelId 同格式）。
  // runtime 在连接 / model.switch / provider 增删时经 config.defaults 推送；
  // landing 态（无 active session）的 composer 模型选择器取它作 fallback。
  const defaultModel = ref('')
  /** 系统提示词配置（FR-4，config.systemPrompt 广播同步）。null=尚未加载。 */
  const systemPromptConfig = ref<{ config: SystemPromptConfig; corrupted: boolean } | null>(null)

  // ── Actions（纯写入；订阅生命周期在 useSettings composable）──

  /**
   * 更新 system 偏好：合并本地态 → 写 localStorage → 同步 DOM + i18n。
   * 消灭「死设置」：theme/locale 切换现在真正生效。
   * useSettings.init 初始化 system 时也走此 action（确保 DOM/i18n 同步）。
   *
   * 乐观更新 + 失败回滚（W2 D9 修复）：
   *   原实现先乐观改 system.value，再 await updateSystem，失败时 system.value 已是新值不回滚、
   *   且 applySystemToDom 被跳过（await 抛错后不执行）→ store 说新主题 DOM 是旧主题，状态脱节。
   *   现顺序：存快照 → 改 state → apply DOM（即时响应）→ await 持久化 → 失败 catch 还原 state
   *   + 重 apply DOM（快照）→ throw（让调用方 toast 反馈）。
   */
  async function setSystem(patch: Partial<SystemSettings>): Promise<void> {
    const snapshot = { ...system.value }
    system.value = { ...system.value, ...patch }
    applySystemToDom(system.value)
    try {
      await settingsApi.updateSystem(patch)
    } catch (e) {
      // 持久化失败：回滚 state + 重 apply DOM 到快照，保持 state/DOM 一致
      system.value = snapshot
      applySystemToDom(snapshot)
      throw e
    }
  }

  /**
   * 覆盖 skill 加载路径（ADR-0020 §1 目录级管道）。
   * dirs 是启用的路径有序数组（靠前覆盖靠后）。
   * 只负责发请求持久化 + 让后端广播推回权威值（buildDirConfigs 补全预设候选）。
   * 拖拽的即时性由 LoadPaths 的本地状态保证，store 不做乐观更新（避免两套本地状态打架）。
   */
  async function setSkillDirs(dirs: string[]): Promise<void> {
    await config.setSkillDirs(dirs)
  }

  /** 覆盖 agent 加载路径（ADR-0020 §1 目录级管道），语义同 setSkillDirs。 */
  async function setAgentDirs(dirs: string[]): Promise<void> {
    await config.setAgentDirs(dirs)
  }

  // ── 乐观更新（toggle 级，区别于 setSkillDirs 的「靠广播推回」）──
  // Switch 受控于 store state，点 toggle 到 UI 动效需经历一次 WS 往返（几十~数百 ms），
  // 纯广播模式期间开关卡在原位 → 用户以为没反应。这些 action 立即改本地 state，
  // 组件「先调 action 再调 API、失败回滚」，广播回来时权威值自然覆盖（幂等调和）。

  /**
   * 乐观切换 provider enabled。
   * 立即改本地 providers 对应项的 enabled，组件负责随后调 API 持久化、失败时回滚。
   * @returns 旧值（供回滚用）
   */
  function setProviderEnabled(id: string, enabled: boolean): boolean {
    const idx = providers.value.findIndex((p) => p.id === id)
    if (idx === -1) return false
    const old = providers.value[idx].enabled ?? true
    providers.value[idx] = { ...providers.value[idx], enabled }
    return old
  }

  /**
   * 乐观切换 model 级 enabled（D6）。
   * 立即改本地 providers 中目标 provider 下目标 model 的 enabled，组件随后调 API 持久化、失败回滚。
   * @returns 旧值（供回滚用），找不到时返回 true（默认启用）
   */
  function setModelEnabled(providerId: string, modelId: string, enabled: boolean): boolean {
    const pIdx = providers.value.findIndex((p) => p.id === providerId)
    if (pIdx === -1) return true
    const provider = providers.value[pIdx]
    const mIdx = provider.models.findIndex((m) => m.id === modelId)
    if (mIdx === -1) return true
    const old = provider.models[mIdx].enabled ?? true
    const nextModels = provider.models.map((m, i) => i === mIdx ? { ...m, enabled } : m)
    providers.value[pIdx] = { ...provider, models: nextModels }
    return old
  }

  /**
   * 乐观切换 extension enabled。
   * @returns 旧值（供回滚用）
   */
  function setExtensionEnabled(name: string, enabled: boolean): boolean {
    const idx = extensions.value.findIndex((e) => e.name === name)
    if (idx === -1) return false
    const old = extensions.value[idx].enabled ?? true
    extensions.value[idx] = { ...extensions.value[idx], enabled }
    return old
  }

  /**
   * 乐观切换 extension autoUpgrade。
   * @returns 旧值（供回滚用）
   */
  function setExtensionAutoUpgrade(name: string, autoUpgrade: boolean): boolean {
    const idx = extensions.value.findIndex((e) => e.name === name)
    if (idx === -1) return false
    const old = extensions.value[idx].autoUpgrade ?? false
    extensions.value[idx] = { ...extensions.value[idx], autoUpgrade }
    return old
  }

  return {
    // state
    providers,
    models,
    skills,
    agents,
    extensions,
    system,
    skillDirs,
    agentDirs,
    defaultModel,
    systemPromptConfig,
    // actions（纯写入）
    setSystem,
    setSkillDirs,
    setAgentDirs,
    setProviderEnabled,
    setModelEnabled,
    setExtensionEnabled,
    setExtensionAutoUpgrade,
  }
})

// ── 内部工具 ──

/**
 * 把 system 偏好同步到运行时副作用：
 * - theme → <html data-theme>（style.css :root 暗默认 / [data-theme=light] 亮色槽位）
 * - themePreset → <html data-theme-preset>（style.css 11 套 [data-theme-preset] 覆盖 --accent）
 * - locale → i18n.setLocale（切换实际语言）
 *
 * theme='system' 时按 prefers-color-scheme 解析为 light/dark 写入 data-theme
 * （避免 CSS 用 media query 又叠一层，统一走 data-theme 单一通道）。
 */
function applySystemToDom(s: SystemSettings): void {
  if (typeof document === 'undefined') return

  const resolvedTheme = s.theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : s.theme
  document.documentElement.setAttribute('data-theme', resolvedTheme)

  // themePreset 写 data-theme-preset，触发 style.css 的 [data-theme-preset] 规则覆盖 --accent。
  // cold-blue 与 :root 默认一致；其他 preset 各自覆盖 accent/soft/ring。
  document.documentElement.setAttribute('data-theme-preset', s.themePreset ?? 'cold-blue')

  // fontSize 写 data-font-size（D17），触发 style.css [data-font-size] 规则调整基础字号。
  // 缺省 medium（与 DEFAULT_SYSTEM 一致），保证老数据无 fontSize 时回落中号。
  document.documentElement.dataset.fontSize = s.fontSize ?? 'medium'

  if (s.locale) setLocale(s.locale)
}
