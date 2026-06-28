/**
 * Settings store —— 应用级配置的「单一真相源」。
 *
 * 重构前问题（2026-06-27 架构返工）：
 * 1. SettingsModal 自管 ref + onMounted 订阅 5 域 + props 下传，是全项目唯一的「组件内状态孤岛」
 *    （其余特性如 sidebar/session/navigation 均为 Pinia 单向流）。settings 数据无法被外部消费。
 * 2. SystemPage 调 settings.updateSystem 只写 localStorage，从不写 DOM → 主题/locale 切换是死设置。
 * 3. i18n 用独立 key 持久化 locale，与 system 偏好分裂成两份真相源。
 *
 * 重构后职责：
 * - 持有 providers / skills / agents / extensions / system 五份状态，统一对外。
 * - init()：幂等挂载 5 域订阅（去重），同步 system 偏好到 DOM + i18n。
 * - setSystem(patch)：写 localStorage + 同步 data-theme + 调 i18n.setLocale。
 *   （themePreset 状态保留供 SystemPage 选中态，CSS 切换暂未实装）
 *
 * 依赖方向（stores 间禁止互相 import；跨域协调由 composables/features 做）：
 * - 读 @/api（config / extension / settings 域订阅与请求）+ @/i18n（locale 切换）。
 * - 写 document.documentElement（data-theme 槽位）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProviderInfo, SkillInfo, AgentInfo, SkillDirConfig } from '@xyz-agent/shared'
import { config, extension as extensionApi, settings as settingsApi } from '@/api'
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

  /** 订阅句柄（init 幂等去重用） */
  const unsubs: Array<() => void> = []
  let initialized = false

  // ── Actions ──

  /**
   * 幂等初始化：挂载 5 域常驻订阅 + 同步 system 偏好到 DOM / i18n。
   * 由 AppShell（应用级，常驻）调用一次即可；多次调用安全（initialized 去重）。
   * 订阅常驻不随 modal 关闭断开，保证 settings 数据全局可消费。
   */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true

    unsubs.push(config.onProviders((p) => { providers.value = p }))
    unsubs.push(config.onSkills((s) => { skills.value = s }))
    unsubs.push(config.onAgents((a) => { agents.value = a }))
    unsubs.push(config.onSkillDirs((d) => { skillDirs.value = d }))
    unsubs.push(config.onAgentDirs((d) => { agentDirs.value = d }))
    unsubs.push(config.onDefaults((m) => { defaultModel.value = m }))
    unsubs.push(extensionApi.onExtensions((e) => { extensions.value = e as ExtensionItem[] }))

    // system 是纯前端偏好（localStorage），初始化时读并同步到 DOM + i18n
    system.value = await settingsApi.getSystem()
    applySystemToDom(system.value)
  }

  /**
   * 打开 modal 时刷新 providers（拿最新快照）；skills/agents 靠订阅，不主动拉。
   * 失败时不阻塞 UI：onProviders 订阅会兜底推回最新数据。
   */
  async function refreshProviders(): Promise<void> {
    try {
      providers.value = await config.listProviders()
    // eslint-disable-next-line taste/no-silent-catch -- 拉取失败不阻塞 UI：onProviders 订阅会兜底推回最新数据，无需打扰用户
    } catch (e) {
      console.warn('[settings] listProviders 失败，依赖订阅兜底', e)
    }
  }

  /**
   * 更新 system 偏好：合并本地态 → 写 localStorage → 同步 DOM + i18n。
   * 消灭「死设置」：theme/locale 切换现在真正生效。
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

  /** 销毁订阅（AppShell 卸载时调用，应用生命周期内通常不触发）。 */
  function dispose(): void {
    unsubs.splice(0).forEach((u) => u())
    initialized = false
  }

  return {
    // state
    providers,
    skills,
    agents,
    extensions,
    system,
    skillDirs,
    agentDirs,
    defaultModel,
    // actions
    init,
    refreshProviders,
    setSystem,
    setSkillDirs,
    setAgentDirs,
    dispose,
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
