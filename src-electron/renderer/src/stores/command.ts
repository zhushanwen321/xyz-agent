/**
 * Command store —— slash 命令（按 sessionId 分区）。
 *
 * 职责：持有 runtime 推送的扩展命令（session.commands 通道），按 sessionId 隔离。
 * 解决的问题：CommandPopover 曾把 slashCommands 存在局部 ref，组件被 v-if 销毁重建
 * （landing→panel 切换 / isGenerating 变化）时数据丢失，且 session.commands 只在
 * 切换/创建时推一次（runtime 不重广播 active session），重建后无补拉机制 → slash 浮层空。
 * 归位 store 后，组件重建读 store 即有数据（与 chat store 的 messages 分区同构，AGENTS.md 规则 7）。
 *
 * 依赖方向：无（stores 间禁止互相 import；跨 store 协调由 composables/features 做）。
 *
 * 数据流：
 *   runtime broadcast / RPC getCommands → CommandPopover 订阅 handler / useSidebar / useNewTaskFlow
 *     → commandStore.applyCommands(sid, cmds)
 *   CommandPopover.items / Turn.vue 用户气泡 chip → commandStore.getCommands(sid) 读取
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** slash 命令项（runtime session.commands payload 归一化 + icon key 推断） */
export interface SessionCommand {
  id: string
  name: string
  /** source（extension/skill/builtin 等），用于 icon 推断与 kind 标签 */
  kind: string
  /** icon key（与 SLASH_ICON_COMPONENTS 同源：terminal/star/wrench/...） */
  icon: string
  description?: string
}

/** runtime 原始命令 payload（protocol.ts ServerMessageMap['session.commands']） */
export interface RawCommand {
  name: string
  description?: string
  source: string
}

/** source → icon key（extension→terminal, skill→star, 默认 wrench）。
 *  与 CommandPopover.iconForSource 同源逻辑，集中在此避免漂移。 */
function iconKeyForSource(source: string): string {
  if (source === 'extension') return 'terminal'
  if (source === 'skill') return 'star'
  return 'wrench'
}

export const useCommandStore = defineStore('command', () => {
  /** 按 sessionId 分区的命令表（UC-2 隔离，同 chat store messages 模式） */
  const commandsBySession = ref<Map<string, SessionCommand[]>>(new Map())

  /** 取指定 session 的命令（无则空数组，不写入 Map） */
  function getCommands(sessionId: string): SessionCommand[] {
    return commandsBySession.value.get(sessionId) ?? []
  }

  /** 按命令名查找（用于用户气泡 chip 解析：content 匹配已知命令） */
  function findCommandByName(sessionId: string, name: string): SessionCommand | undefined {
    return getCommands(sessionId).find((c) => c.name === name)
  }

  /** 响应式视图：指定 session 的命令（供 CommandPopover computed 订阅） */
  function commandsOf(sessionId: string) {
    return computed(() => commandsBySession.value.get(sessionId) ?? [])
  }

  /** 写入命令（runtime 推送 / RPC 拉取后调用）。不可变更新确保 Map 响应性触发 */
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

  /** 清除指定 session 的命令（session 删除时） */
  function clearCommands(sessionId: string): void {
    if (!commandsBySession.value.has(sessionId)) return
    commandsBySession.value = new Map(commandsBySession.value)
    commandsBySession.value.delete(sessionId)
  }

  return { commandsBySession, getCommands, findCommandByName, commandsOf, applyCommands, clearCommands }
})
