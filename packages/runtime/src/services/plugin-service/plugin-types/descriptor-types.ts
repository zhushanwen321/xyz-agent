import type { PluginState } from '../plugin-types.js'

// ── Manifest 类型（解析自 package.json 的 xyzAgent 字段）──────────

/** 插件来源：随应用分发的内置插件 或 用户安装的外部插件 */
export type PluginSource = 'built-in' | 'external'

export interface XyzAgentManifest {
  manifestVersion: 1
  main: string
  activationEvents: string[]
  trustLevel?: 'trusted' | 'sandbox'
  permissions?: string[]
  contributes?: PluginContributes
  /** 插件来源，由 registry 扫描时自动设置，manifest 中声明无效 */
  source?: PluginSource
  /** 该插件依赖的其他插件 ID 列表 */
  extensionDependencies?: string[]
}

export interface XyzAgentPackageJson {
  name: string
  version: string
  description?: string
  displayName?: string
  xyzAgent: XyzAgentManifest
  engines?: { 'xyz-agent'?: string }
}

// ── Descriptor（扫描后产出的完整描述）──────────────────────────

export interface PluginDescriptor {
  pluginId: string
  version: string
  displayName: string
  description: string
  main: string
  activationEvents: string[]
  trustLevel: 'trusted' | 'sandbox'
  status: PluginState
  contributes: PluginContributes
  permissions: string[]
  engines: { 'xyz-agent': string }
  pluginPath: string
  /** 插件来源：built-in（随应用分发）或 external（用户安装） */
  source: PluginSource
  /** 该插件依赖的其他插件 ID 列表 */
  extensionDependencies: string[]
  /** 版本不兼容时的错误描述 */
  compatibilityError?: string
}

export interface PluginContributes {
  slashCommands?: Array<{ name: string; description: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks?: string[]
  views?: PluginContributesView[]
  menus?: PluginContributesMenu
  commands?: PluginContributesCommand[]
  configuration?: PluginContributesConfiguration
  statusBarItems?: PluginContributesStatusBarItem[]
}

/** schema v2：views 声明（panels 演进产物，placement 为开放字符串——挂载点由壳注册） */
export interface PluginContributesView {
  id: string
  title: string
  view?: string
  /** 挂载点名：'sidebar.tab' | 'panel.header' | 'composer.toolbar' | 'drawer.tab' | 'statusbar' 等，开放字符串（壳注册制） */
  placement: string
  viewType?: 'gui' | 'webview' | 'tree'
  activationEvent?: string
  initialVisibility?: 'visible' | 'hidden'
}

/** schema v2：menus 按挂载点名分组的命令菜单映射（VSCode contribution points 风格） */
export interface PluginContributesMenu {
  'composer.toolbar'?: PluginMenuItem[]
  'panel.header'?: PluginMenuItem[]
  'sidebar.footer'?: PluginMenuItem[]
}

export interface PluginMenuItem {
  command: string
  when?: string
  group?: string
}

/** schema v2：声明式命令表（与 api.commands.register 互补：声明提供元数据，register 提供 handler） */
export interface PluginContributesCommand {
  command: string
  title: string
  category?: string
  keybinding?: string
  when?: string
  icon?: string
}

/** schema v2：JSON Schema 子集（VSCode configuration 风格），驱动设置页表单 */
export interface PluginContributesConfiguration {
  title?: string
  properties: Record<string, PluginConfigurationProperty>
}

export interface PluginConfigurationProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  default?: unknown
  description?: string
  enum?: unknown[]
  enumDescriptions?: string[]
}

/** schema v2：旧三字段（id/text/priority）原样保留保证向后兼容，扩展字段全 optional */
export interface PluginContributesStatusBarItem {
  id: string
  text: string
  priority: number
  alignment?: 'left' | 'right'
  scope?: 'per-session' | 'global'
  commandId?: string
  tooltip?: string
}
