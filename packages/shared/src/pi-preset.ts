/**
 * Pi 启动参数预设数据模型。
 *
 * 设计文档：docs/design/pi-launch-presets.md
 *
 * 预设是一组 pi 启动参数的命名集合，用户可创建/编辑/删除。
 * 内置预设 3 个（builtin:true，不可删除），自定义预设任意编辑。
 */

/** 工具模式：决定如何处理工具列表 */
export type ToolMode = 'all' | 'allowlist' | 'denylist' | 'none'

/**
 * Extension 模式：决定如何处理 extension 列表。
 *
 * 注意：pi 无原生 extension 黑名单。denylist 由 runtime 先列出全部已启用 extension，
 * 排除用户指定的 deniedExtensions 后，作为 allowlist 注入（见设计文档 §2.4）。
 *
 * BUILTIN_EXTENSION_FILES 永远注入（不受 extensionMode 影响），见设计文档 §2.3。
 */
export type ExtensionMode = 'all' | 'allowlist' | 'denylist' | 'none'

/**
 * 思考级别。值域与 pi CLI --thinking 参数对齐（源码核实 args.ts:57）。
 * 注意：pi 参数名是 --thinking（不是 --thinking-level）。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** pi 内置工具列表（pi 硬编码 7 个，源码 core/tools/index.ts:83-84） */
export const BUILTIN_TOOLS = ['read', 'write', 'bash', 'edit', 'grep', 'find', 'ls'] as const

/**
 * 3 个 builtin 文件型 extension 的固定标识。
 *
 * 它们不在 ExtensionService.scanExtensions() 返回值里（仅在 getExtensionPaths 追加），
 * 因此对用户不可见、不可 exclude、不受 extensionMode 影响——见设计文档 §2.3。
 * 必须与 extension-service.ts 的 builtinExts 数组完全一致。
 */
export const BUILTIN_EXTENSION_FILES = [
  'xyz-agent-extension.js',
  'xyz-system-prompt-extension.js',
  'xyz-client-msg-id-mapper.js',
] as const

/** Pi 启动参数预设 */
export interface PiLaunchPreset {
  /** 预设唯一 ID（内置用 'builtin:xxx'，自定义用 UUID） */
  id: string
  /** 预设名称（显示用） */
  name: string
  /** 预设描述 */
  description?: string
  /** 是否内置（不可删除/重命名） */
  builtin: boolean
  /** 排序权重（越小越靠前） */
  order: number

  // ── 工具配置 ──
  /** 工具模式 */
  toolMode: ToolMode
  /** allowlist 模式下允许的工具名列表 */
  allowedTools?: string[]
  /** denylist 模式下禁用的工具名列表 */
  deniedTools?: string[]

  // ── Extension 配置 ──
  /** Extension 模式 */
  extensionMode: ExtensionMode
  /** allowlist 模式下允许的 extension 名列表 */
  allowedExtensions?: string[]
  /** denylist 模式下禁用的 extension 名列表 */
  deniedExtensions?: string[]

  // ── 模型配置（可选覆盖） ──
  /**
   * 覆盖默认模型（如 'anthropic/claude-sonnet-4'）。不设则用全局默认。
   * 优先级：Landing Model Chip > preset.modelOverride > 全局默认（见设计文档 §5.2）。
   */
  modelOverride?: string
  /**
   * 覆盖思考级别。
   * 优先级：Landing Thinking Chip > preset.thinkingLevel > 全局默认。
   */
  thinkingLevel?: ThinkingLevel

  // ── 其他配置 ──
  /** 禁用所有 skill（映射 --no-skills） */
  noSkills?: boolean
  /** 禁用 context files（AGENTS.md/CLAUDE.md，映射 --no-context-files） */
  noContextFiles?: boolean
}

/** 内置预设 ID 常量 */
export const BUILTIN_PRESET_IDS = {
  FULL: 'builtin:full',                // 全工具模式
  ORCHESTRATOR: 'builtin:orchestrator', // orchestrator 模式
  READONLY: 'builtin:readonly',         // 只读模式
} as const

/** 默认内置预设列表 */
export const DEFAULT_PRESETS: PiLaunchPreset[] = [
  {
    id: BUILTIN_PRESET_IDS.FULL,
    name: '全工具模式',
    description: '所有工具和扩展可用，适合大部分任务',
    builtin: true,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
  },
  {
    id: BUILTIN_PRESET_IDS.ORCHESTRATOR,
    name: 'Orchestrator',
    description: '主 Agent 只做协调，实际执行由 SubAgent 完成',
    builtin: true,
    order: 1,
    toolMode: 'denylist',
    deniedTools: ['read', 'write', 'bash', 'edit'],
    extensionMode: 'all',
  },
  {
    id: BUILTIN_PRESET_IDS.READONLY,
    name: '只读模式',
    description: '只能查看代码，适合 Code Review',
    builtin: true,
    order: 2,
    toolMode: 'allowlist',
    allowedTools: ['read', 'grep', 'find', 'ls'],
    extensionMode: 'all',
  },
]

/**
 * pi-presets.json 的持久化形状（~/.xyz-agent/pi-presets.json）。
 *
 * 存：用户自定义预设 + 内置预设的用户编辑副本（builtin 字段仍 true）+ 默认预设 id。
 * 位置由 getDataDir() 推导（设计文档 §1.4）。前后端共享形状故放 shared。
 */
export interface PiPresetsFile {
  /** 用户自定义预设 + 内置预设的用户编辑副本（builtin 字段仍 true） */
  presets: PiLaunchPreset[]
  /** 用户设置的「设为默认」preset id，全局生效（设计文档 §5.3）。缺省 'builtin:full'。 */
  defaultPresetId?: string
  /** schema 版本，便于未来迁移 */
  version: 1
}
