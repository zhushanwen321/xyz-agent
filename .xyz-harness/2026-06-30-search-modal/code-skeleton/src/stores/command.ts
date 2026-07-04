/**
 * Command store（#2 扩展）—— slash 命令（per-session）+ 应用命令（全局静态）。
 *
 * 扩展点（D-016 两区物理隔离）：
 *  - 新增 appCommands: Ref<AppCommand[]>（静态，启动时一次性注册，session 切换不触发响应式）
 *  - 新增 registerApp(cmds)（幂等覆盖）
 *  - 新增 slashCommandsOf(sessionId) computed（沿用 commandsOf 语义，供 useCommandRegistry）
 *  - 现有 commandsBySession / getCommands / findCommandByName / commandsOf / applyCommands / clearCommands 不变
 *
 * 依赖方向：无（stores 间禁止 import，与现有 chat/fileTree/fileSearch 一致）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AppCommand } from '@/lib/search-types'

/** slash 命令项（runtime session.commands payload 归一化 + icon key 推断）—— 现有，不变 */
export interface SessionCommand {
  id: string
  name: string
  kind: string
  icon: string
  description?: string
}

/** runtime 原始命令 payload —— 现有，不变 */
export interface RawCommand {
  name: string
  description?: string
  source: string
}

function iconKeyForSource(source: string): string {
  if (source === 'extension') return 'terminal'
  if (source === 'skill') return 'star'
  return 'wrench'
}

export const useCommandStore = defineStore('command', () => {
  /** [现有] 按 sessionId 分区的 slash 命令表 */
  const commandsBySession = ref<Map<string, SessionCommand[]>>(new Map())

  /** [新增 #2 D-016] 全局应用命令区（静态，session 切换不触发响应式） */
  const appCommands = ref<AppCommand[]>([])

  /** [现有] 取指定 session 的 slash 命令（无则空数组） */
  function getCommands(sessionId: string): SessionCommand[] {
    return commandsBySession.value.get(sessionId) ?? []
  }

  function findCommandByName(sessionId: string, name: string): SessionCommand | undefined {
    return getCommands(sessionId).find((c) => c.name === name)
  }

  /** [现有] 响应式视图：指定 session 的 slash 命令 */
  function commandsOf(sessionId: string) {
    return computed(() => commandsBySession.value.get(sessionId) ?? [])
  }

  /** [新增 #2] useCommandRegistry 用：当前 session 的 slash 命令（与 commandsOf 同义，显式命名） */
  function slashCommandsOf(sessionId: string) {
    return commandsOf(sessionId)
  }

  /** [现有] 写入 slash 命令（runtime 推送/RPC 拉取后）。不可变更新确保 Map 响应性触发 */
  function applyCommands(sessionId: string, raw: RawCommand[]): void {
    const normalized = raw.map((c) => ({
      id: c.name,
      name: c.name,
      kind: c.source,
      icon: iconKeyForSource(c.source),
      description: c.description,
    }))
    commandsBySession.value = new Map(commandsBySession.value).set(sessionId, normalized)
  }

  function clearCommands(sessionId: string): void {
    if (!commandsBySession.value.has(sessionId)) return
    commandsBySession.value = new Map(commandsBySession.value)
    commandsBySession.value.delete(sessionId)
  }

  /** [新增 #2 D-016] 注册应用命令（启动时一次性，幂等覆盖，无 session 关联） */
  function registerApp(cmds: AppCommand[]): void {
    appCommands.value = cmds
  }

  return {
    commandsBySession,
    appCommands,
    getCommands,
    findCommandByName,
    commandsOf,
    slashCommandsOf,
    applyCommands,
    clearCommands,
    registerApp,
  }
})
