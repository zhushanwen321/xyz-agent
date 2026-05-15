import { ref } from 'vue'
import type { SkillInfo } from '@xyz-agent/shared'

// ── 类型定义 ────────────────────────────────────────────────────

export type SlashCommandSource = 'builtin' | 'skill'

export type SlashCommandAction =
  | { type: 'local'; handler: (ctx: CommandContext) => void }
  | { type: 'protocol'; messageType: string }
  | { type: 'skill'; skillId: string }

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
let defaultsInitialized = false

// ── composable ──────────────────────────────────────────────────

export function useSlashCommands() {
  function registerBuiltin(cmd: SlashCommand) {
    if (builtinCommands.value.some(c => c.name === cmd.name)) return
    builtinCommands.value = [...builtinCommands.value, cmd]
  }

  /** 将 enabled skills 映射为 SlashCommand，与内置命令合并后按 name 排序 */
  function mergeSkillCommands(skills: SkillInfo[]): SlashCommand[] {
    const skillCmds: SlashCommand[] = skills
      .filter(s => s.enabled)
      .map(s => ({
        name: s.name,
        description: s.description,
        source: 'skill' as const,
        action: { type: 'skill' as const, skillId: s.id },
        argumentHint: s.argumentHint,
      }))

    const all = [...builtinCommands.value, ...skillCmds]
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

  return {
    builtinCommands,
    registerBuiltin,
    mergeSkillCommands,
    filterCommands,
    initDefaultCommands,
  }
}
