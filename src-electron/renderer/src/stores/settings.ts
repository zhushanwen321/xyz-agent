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
import type { ProviderInfo, SkillInfo, AgentInfo, SkillDirConfig, ModelInfo } from '@xyz-agent/shared'
import { config, settings as settingsApi } from '@/api'
import type { SystemSettings } from '@/api'
import { setLocale } from '@/i18n'

/** 外观模式：暗色 / 亮色 / 跟随系统（与 api SystemSettings.theme 对齐） */
export type ThemeMode = SystemSettings['theme']

/** 配色主题：由 settings-shell spec §4 System 菜单定义，默认 cold-blue */
export type ColorTheme = string

export type { SystemSettings }

/**
 * Extension 本地桥接类型：shared ExtensionInfo 暂无 tools，
 * ExtensionPage 模板依赖 tools 字段；real 订阅实装时再与 shared 统一。
 * （与 SettingsModal 原本地 ExtensionItem 同构，上提到 store 作为单一类型。）
 */
export interface ExtensionItem {
  name: string
  version: string
  description: string
  enabled: boolean
  tools: string[]
}

const DEFAULT_SYSTEM: SystemSettings = {
  locale: 'zh-CN',
  theme: 'dark',
  themePreset: 'cold-blue',
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

  // ── Actions（纯写入；订阅生命周期在 useSettings composable）──

  /**
   * 更新 system 偏好：合并本地态 → 写 localStorage → 同步 DOM + i18n。
   * 消灭「死设置」：theme/locale 切换现在真正生效。
   * useSettings.init 初始化 system 时也走此 action（确保 DOM/i18n 同步）。
   */
  async function setSystem(patch: Partial<SystemSettings>): Promise<void> {
    system.value = { ...system.value, ...patch }
    await settingsApi.updateSystem(patch)
    applySystemToDom(system.value)
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
    // actions（纯写入）
    setSystem,
    setSkillDirs,
    setAgentDirs,
  }
})

// ── 内部工具 ──

/**
 * 把 system 偏好同步到运行时副作用：
 * - theme → <html data-theme>（style.css :root 暗默认 / [data-theme=light] 亮色槽位）
 * - locale → i18n.setLocale（切换实际语言）
 *
 * theme='system' 时按 prefers-color-scheme 解析为 light/dark 写入 data-theme
 * （避免 CSS 用 media query 又叠一层，统一走 data-theme 单一通道）。
 *
 * 注：themePreset（palette）暂未实装 CSS 切换（11 个配色 swatch 的 --accent 覆盖待做），
 * 故此处不写 data-theme-preset；store 仍持有 themePreset 状态供 SystemPage 选中态使用。
 */
function applySystemToDom(s: SystemSettings): void {
  if (typeof document === 'undefined') return

  const resolvedTheme = s.theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : s.theme
  document.documentElement.setAttribute('data-theme', resolvedTheme)

  if (s.locale) setLocale(s.locale)
}
