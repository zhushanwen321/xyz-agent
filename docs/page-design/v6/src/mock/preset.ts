/** Mock 数据层 — Settings 预设页（PresetPage）静态数据 */

/** 工具模式：all / allowlist / denylist / none（与 shared pi-preset.ts 对齐） */
export type ToolMode = 'all' | 'allowlist' | 'denylist' | 'none'
/** 扩展模式（denylist 由 runtime 转 allowlist 注入；builtin 文件型扩展永远注入） */
export type ExtensionMode = 'all' | 'allowlist' | 'denylist' | 'none'

/** Pi 启动参数预设（字段与 shared PiLaunchPreset 对齐；demo 只展示 name/id/description + 工具/扩展策略） */
export interface PiLaunchPreset {
  id: string
  name: string
  description?: string
  /** 内置预设：不可重命名/删除，可恢复出厂 */
  builtin: boolean
  /** 排序权重（越小越靠前） */
  order: number
  toolMode: ToolMode
  extensionMode: ExtensionMode
  allowedTools?: string[]
  deniedTools?: string[]
  allowedExtensions?: string[]
  deniedExtensions?: string[]
}

/** pi 内置工具全集（7 个，pi 硬编码） */
export const BUILTIN_TOOLS: string[] = ['read', 'write', 'bash', 'edit', 'grep', 'find', 'ls']

/** 核心 4 工具 —— UI「默认启用/默认禁用」徽章依据（read/write/bash/edit） */
export const DEFAULT_ENABLED_TOOLS: string[] = ['read', 'write', 'bash', 'edit']

/** 已安装扩展（mock 设置 store extensions；已排除 3 个 builtin 文件型扩展） */
export interface MockExtension {
  name: string
  displayName: string
}
export const AVAILABLE_EXTENSIONS: MockExtension[] = [
  { name: 'pi-goal', displayName: 'pi-goal' },
  { name: 'pi-todo', displayName: 'pi-todo' },
  { name: 'pi-subagent-workflow', displayName: 'pi-subagent-workflow' },
  { name: 'pi-ask-user', displayName: 'pi-ask-user' },
  { name: 'pi-scheduler', displayName: 'pi-scheduler' },
  { name: 'pi-rename-session', displayName: 'pi-rename-session' },
]

/** 内置预设原始定义（恢复出厂设置用） */
export const DEFAULT_PRESETS: PiLaunchPreset[] = [
  {
    id: 'builtin:full',
    name: '全工具模式',
    description: '所有工具和扩展可用，适合大部分任务',
    builtin: true,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
  },
  {
    id: 'builtin:orchestrator',
    name: 'Orchestrator',
    description: '主 Agent 只做协调，实际执行由 SubAgent 完成',
    builtin: true,
    order: 1,
    toolMode: 'denylist',
    deniedTools: ['read', 'write', 'bash', 'edit'],
    extensionMode: 'all',
  },
  {
    id: 'builtin:readonly',
    name: '只读模式',
    description: '只能查看代码，适合 Code Review',
    builtin: true,
    order: 2,
    toolMode: 'allowlist',
    allowedTools: ['read', 'grep', 'find', 'ls'],
    extensionMode: 'all',
  },
]

/** 页面初始预设（3 内置 + 2 自定义；含一个固定失败演示位） */
export const presets: PiLaunchPreset[] = [
  ...DEFAULT_PRESETS,
  {
    id: 'custom:review',
    name: '审查专用',
    description: '只读 + 目标扩展，用于代码审查会话',
    builtin: false,
    order: 3,
    toolMode: 'allowlist',
    allowedTools: ['read', 'grep', 'find', 'ls'],
    extensionMode: 'allowlist',
    allowedExtensions: ['pi-goal', 'pi-todo'],
  },
  {
    id: 'custom:fail',
    name: '演示预设',
    description: '固定演示保存/删除失败分支（demo）',
    builtin: false,
    order: 4,
    toolMode: 'all',
    extensionMode: 'all',
  },
]

/** 演示失败条件的自定义预设 id（保存/删除首次操作失败、重试成功） */
export const FAIL_PRESET_ID = 'custom:fail'

/** 4 种 mode 按钮文案（工具/扩展共用） */
export const MODE_LABELS: Record<ToolMode, string> = {
  all: '全部',
  allowlist: '白名单',
  denylist: '黑名单',
  none: '禁用',
}

/** 折叠态摘要：mode 概览文案（allowlist/denylist 带清单数量） */
export function modeSummary(mode: ToolMode | ExtensionMode, count: number): string {
  switch (mode) {
    case 'all':
      return '全部可用'
    case 'none':
      return '全部禁用'
    case 'allowlist':
      return '白名单 ' + count + ' 项'
    case 'denylist':
      return '黑名单 ' + count + ' 项'
  }
}

/** 3 个内置文件型扩展提示（真实组件 builtinExtensionHint 文案） */
export const BUILTIN_EXTENSION_HINT =
  '提示：3 个内置扩展（xyz-agent-extension / xyz-system-prompt-extension / xyz-client-msg-id-mapper）始终加载，不受扩展策略影响。'
