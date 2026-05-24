import { ref } from 'vue'
import type { SkillInfo, AgentInfo } from '@xyz-agent/shared'

// ── 类型定义 ────────────────────────────────────────────────────

export type SlashCommandSource = 'builtin' | 'skill' | 'agent' | 'extension' | 'native'

export type SlashCommandAction =
  | { type: 'local'; handler: (ctx: CommandContext) => void }
  | { type: 'protocol'; messageType: string }
  | { type: 'skill'; skillId: string }
  | { type: 'agent'; agentName: string }
  | { type: 'extension'; commandName: string }
  | { type: 'native'; commandName: string }

export interface SlashCommand {
  name: string
  description: string
  source: SlashCommandSource
  action: SlashCommandAction
  argumentHint?: string
}

export interface CommandContext {
  sessionId: string
  /** 执行时获取完整命令列表（help 命令延迟读取） */
  getAllCommands: () => SlashCommand[]
  /** 本地操作回调，由调用方注入 */
  onLocalAction: (action: 'clear' | 'help', data?: unknown) => void
}

// ── 单例状态 ────────────────────────────────────────────────────

const builtinCommands = ref<SlashCommand[]>([])
const extensionCommands = ref<SlashCommand[]>([])
const nativeCommands = ref<SlashCommand[]>([])
let defaultsInitialized = false

// ── composable ──────────────────────────────────────────────────

export function useSlashCommands() {
  function registerBuiltin(cmd: SlashCommand) {
    if (builtinCommands.value.some(c => c.name === cmd.name)) return
    builtinCommands.value = [...builtinCommands.value, cmd]
  }

  /** 将 enabled skills 映射为 SlashCommand，与内置命令合并后按 name 排序 */
  function mergeSkillCommands(skills: SkillInfo[], agents?: AgentInfo[]): SlashCommand[] {
    const skillCmds: SlashCommand[] = skills
      .filter(s => s.enabled)
      .map(s => ({
        name: s.name,
        description: s.description,
        source: 'skill' as const,
        action: { type: 'skill' as const, skillId: s.id },
        argumentHint: s.argumentHint,
      }))

    const agentCmds: SlashCommand[] = (agents ?? [])
      .filter(a => a.enabled)
      .map(a => ({
        name: `agent:${a.name}`,
        description: a.description,
        source: 'agent' as const,
        action: { type: 'agent' as const, agentName: a.name },
      }))

    const all = [...builtinCommands.value, ...nativeCommands.value, ...skillCmds, ...agentCmds, ...extensionCommands.value]
    // 去重（skill 可能与 builtin 同名）
    const seen = new Set<string>()
    return all
      .filter(cmd => {
        if (seen.has(cmd.name)) return false
        seen.add(cmd.name)
        return true
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 子串过滤（不区分大小写） */
  function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
    if (!filter) return commands
    const lower = filter.toLowerCase()
    return commands.filter(cmd => cmd.name.toLowerCase().includes(lower))
  }

  /** 注册 3 个内置命令（幂等） */
  function initDefaultCommands() {
    if (defaultsInitialized) return
    defaultsInitialized = true

    registerBuiltin({
      name: 'clear',
      description: '清空当前对话',
      source: 'builtin',
      action: {
        type: 'local',
        handler: (ctx) => ctx.onLocalAction('clear'),
      },
    })

    registerBuiltin({
      name: 'compact',
      description: '压缩上下文，减少 token 消耗',
      source: 'builtin',
      action: {
        type: 'protocol',
        messageType: 'session.compact',
      },
    })

    registerBuiltin({
      name: 'help',
      description: '显示可用命令列表',
      source: 'builtin',
      action: {
        type: 'local',
        handler: (ctx) => ctx.onLocalAction('help', ctx.getAllCommands()),
      },
    })
  }

  /** 将 pi get_commands 返回的命令转换为 SlashCommand 格式 */
  function setExtensionCommands(commands: Array<{ name: string; description?: string; source: string }>) {
    extensionCommands.value = commands.map(cmd => ({
      name: cmd.name,
      description: cmd.description ?? '',
      source: 'extension' as const,
      action: { type: 'extension' as const, commandName: cmd.name },
    }))
  }

  /** 注册 pi 原生内置 slash 命令（排除 xyz-agent 已有同名命令） */
  function initNativeCommands() {
    // xyz-agent 已有的 builtin 命令名，pi 原生命令中跳过这些
    const existingNames = new Set(builtinCommands.value.map(c => c.name))

    const piCommands: Array<{ name: string; description: string }> = [
      { name: 'model', description: '查看或切换模型' },
      { name: 'scoped-models', description: '管理 Ctrl+P 模型循环范围' },
      { name: 'export', description: '导出会话 (HTML/JSONL)' },
      { name: 'import', description: '导入 JSONL 会话并恢复' },
      { name: 'share', description: '分享会话为 GitHub Gist' },
      { name: 'copy', description: '复制最后一条 assistant 消息到剪贴板' },
      { name: 'name', description: '设置会话显示名称' },
      { name: 'session', description: '显示会话信息和统计' },
      { name: 'changelog', description: '显示变更日志' },
      { name: 'hotkeys', description: '显示所有快捷键' },
      { name: 'fork', description: '从历史消息创建分支' },
      { name: 'clone', description: '在当前位置复制会话' },
      { name: 'tree', description: '导航会话树（切换分支）' },
      { name: 'login', description: '配置 provider 认证' },
      { name: 'logout', description: '移除 provider 认证' },
      { name: 'resume', description: '恢复其他会话' },
      { name: 'reload', description: '重新加载配置和扩展' },
    ]

    nativeCommands.value = piCommands
      .filter(cmd => !existingNames.has(cmd.name))
      .map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        source: 'native' as const,
        action: { type: 'native' as const, commandName: cmd.name },
      }))
  }

  return {
    builtinCommands,
    registerBuiltin,
    mergeSkillCommands,
    filterCommands,
    initDefaultCommands,
    initNativeCommands,
    setExtensionCommands,
  }
}
