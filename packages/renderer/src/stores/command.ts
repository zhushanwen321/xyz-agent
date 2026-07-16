/**
 * Command store —— slash 命令（按 sessionId 分区）+ 全局应用命令（静态）。
 *
 * 职责：
 *  - slash 命令：持有 runtime 推送的扩展命令（session.commands 通道），按 sessionId 隔离。
 *    解决的问题：CommandPopover 曾把 slashCommands 存在局部 ref，组件被 v-if 销毁重建
 *    （landing→panel 切换 / isGenerating 变化）时数据丢失，且 session.commands 只在
 *    切换/创建时推一次（runtime 不重广播 active session），重建后无补拉机制 → slash 浮层空。
 *    归位 store 后，组件重建读 store 即有数据（与 chat store 的 messages 分区同构，AGENTS.md 规则 7）。
 *  - 应用命令：全局内置命令（新建/搜索等），静态、与 session 无关。D-016 物理隔离——
 *    appCommands 独立 ref，session 切换只动 commandsBySession，不触发 appCommands 重算。
 *    两区物理分离：slash 命令带 / 前缀，与应用命令天然不撞（D-009）。
 *
 * 依赖方向：无（stores 间禁止互相 import；跨 store 协调由 composables/features 做）。
 *
 * 数据流：
 *   runtime broadcast / RPC getCommands → CommandPopover 订阅 handler / useSidebar / useNewTaskFlow
 *     → commandStore.applyCommands(sid, cmds)
 *   CommandPopover.items / Turn.vue 用户气泡 chip → commandStore.getCommands(sid) 读取
 *   启动期 useCommandRegistry.registerApp → commandStore.registerApp(appCmds) 一次性写应用命令区
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AppCommand } from '@/lib/search-types'

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

/**
 * 一次性 slash 注入请求（SearchModal 写入 → Composer 消费 → clearPendingSlash 清除）。
 * 设计动机：SearchModal（Sidebar 中的全局浮层）无法直接拿到活跃 Panel 内 ComposerInput 的 DOM ref
 * （ref 链在 Composer 层终止，Composer 无 defineExpose 上抛 insertSlashChip）。
 * 用 store 作为一次性消息通道（写→消费→清），与现有 retryState/queueState 瞬时状态同构。
 * sessionId：注入目标 session（null = landing 态），消费侧 Composer 据此过滤，避免广播。
 * ts：时间戳，用于 watch 触发（同命令重复点击靠 ts 变化触发引用变化）。
 */
export interface PendingSlash {
  command: string
  icon?: string
  sessionId: string | null
  ts: number
}

/** runtime 原始命令 payload（protocol.ts ServerMessageMap['session.commands']） */
export interface RawCommand {
  name: string
  description?: string
  source: string
}

/** 从 localStorage 加载快捷键覆盖 */
function loadShortcutOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SHORTCUT_OVERRIDES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** source → icon key（extension→terminal, skill→star, 默认 wrench）。
 *  与 CommandPopover.iconForSource 同源逻辑，集中在此避免漂移。 */
function iconKeyForSource(source: string): string {
  if (source === 'extension') return 'terminal'
  if (source === 'skill') return 'star'
  return 'wrench'
}

/** localStorage key for shortcut overrides persistence */
const SHORTCUT_OVERRIDES_KEY = 'xyz-agent-shortcut-overrides'

export const useCommandStore = defineStore('command', () => {
  /** 按 sessionId 分区的命令表（UC-2 隔离，同 chat store messages 模式） */
  const commandsBySession = ref<Map<string, SessionCommand[]>>(new Map())

  /** 用户自定义快捷键覆盖（commandId → key，如 'new-session' → 'j'）。
   *  持久化到 localStorage，启动时恢复。 */
  const shortcutOverrides = ref<Record<string, string>>(loadShortcutOverrides())

  /**
   * 全局应用命令区（D-016 物理隔离）：静态、与 session 无关。
   * 独立 ref —— session 切换只动 commandsBySession，不触发 appCommands 重算（AC-2.2）。
   * 启动时 registerApp 一次性写入，组件重建读 store 即有数据（同 slash 命令归位动机）。
   */
  const appCommands = ref<AppCommand[]>([])

  /**
   * 一次性 slash 注入请求槽位（store 驱动模式）。
   * 写入方：useSearchJump.confirmCommand（slash 分支）。
   * 消费方：Composer watch(pendingSlash) 按 sessionId 过滤后调 insertSlashChip + clearPendingSlash。
   * null 表示无待消费请求。
   */
  const pendingSlash = ref<PendingSlash | null>(null)

  /**
   * 写入 slash 注入请求（幂等覆盖：连续调用以最后一次为准，非累加——与 registerApp 同语义）。
   * ts 由调用方不传，内部用 Date.now() 标记（供 watch 触发 + 重复点击同命令时引用变化）。
   */
  function requestSlashInjection(payload: Omit<PendingSlash, 'ts'>): void {
    pendingSlash.value = { ...payload, ts: Date.now() }
  }

  /** 消费清除（Composer 消费后立即调用，防重复注入 + 防 watch 残留触发） */
  function clearPendingSlash(): void {
    pendingSlash.value = null
  }

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

  /**
   * slash 命令响应式视图（同 commandsOf 语义，显式命名供 useCommandRegistry 调用，
   * 明确读的是 per-session slash 区而非全局应用命令区）。
   */
  function slashCommandsOf(sessionId: string) {
    return commandsOf(sessionId)
  }

  /**
   * 注册应用命令（启动期一次性）。幂等覆盖：重复调用以最后一次为准，非累加（AC-2.4）。
   * 不写 commandsBySession —— 应用命令与 session 无关（D-016 物理隔离）。
   */
  function registerApp(cmds: AppCommand[]): void {
    appCommands.value = cmds
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

  /** 设置快捷键覆盖（commandId → key）。null 清除自定义，恢复默认。持久化到 localStorage。 */
  function setShortcutOverride(commandId: string, key: string | null): void {
    const next = { ...shortcutOverrides.value }
    if (key === null) {
      delete next[commandId]
    } else {
      next[commandId] = key
    }
    shortcutOverrides.value = next
    try {
      localStorage.setItem(SHORTCUT_OVERRIDES_KEY, JSON.stringify(next))
    } catch (e) { /* localStorage quota exceeded — non-critical, overrides still in memory */ void e }
  }

  /** 清除指定 session 的命令（session 删除时） */
  function clearCommands(sessionId: string): void {
    if (!commandsBySession.value.has(sessionId)) return
    commandsBySession.value = new Map(commandsBySession.value)
    commandsBySession.value.delete(sessionId)
  }

  return {
    commandsBySession,
    appCommands,
    shortcutOverrides,
    pendingSlash,
    getCommands,
    findCommandByName,
    commandsOf,
    slashCommandsOf,
    registerApp,
    applyCommands,
    clearCommands,
    setShortcutOverride,
    requestSlashInjection,
    clearPendingSlash,
  }
})
