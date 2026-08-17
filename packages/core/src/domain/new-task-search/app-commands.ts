/**
 * app-commands —— 应用内置命令注册（core 域迁移版，IF6）。
 *
 * [归位] 迁自 renderer composables/features/useAppCommands.ts（76 行），逻辑不变。
 * C-W3-5：AppCommandActionsPort 四项 action 全注入（newSession/goOverview/toggleSidebar/
 * requestPresetOpen——原 toggleSidebar 直调 useSidebarStore、requestPresetOpen 直调
 * usePresetStore，收编端口去除 store 依赖）；navigator.platform isMac 改经注入标志（D8 收编）。
 *
 * 职责：构建应用级命令列表（新建/收起侧栏/概览/预设），注册到 commandStore.appCommands，
 * 供 useCommandRegistry 聚合进搜索命令源 + useSearchJump.confirmCommand 按 name 查找执行 action。
 *
 * 设计约束（spec G1.1 / D-004 / D-009）：
 *  - ⌘K（搜索本身）**不注册**为 appCommand：否则搜索结果出现「搜索」命令，逻辑自指（唤起搜索的命令
 *    出现在搜索结果里）。⌘K 的快捷键由 Sidebar keymap 兜底。
 *  - 命令按 name 唯一标识，pi slash 命令带 / 前缀（/commit）天然不与应用命令撞名（D-009）。
 *
 * 依赖方向：command-store（registerApp）+ 注入 actions/isMac/t。无 api/store 直连。
 */
import type { createCommandStore } from './command-store'
import type { AppCommand } from './types'
import type { AppCommandActionsPort } from './search-ports'
import type { TranslatePort } from './ports'

export interface RegisterAppCommandsDeps {
  commandStore: ReturnType<typeof createCommandStore>
  /** 应用命令 actions（C-W3-5 全注入，壳适配 useSidebarNew/useSidebarStore/usePresetStore） */
  actions: AppCommandActionsPort
  /** macOS 平台标志（壳适配 navigator.platform.includes('Mac')；D8 收编） */
  isMac: boolean
  /** 域内文案（壳适配 renderer i18n.global.t） */
  t: TranslatePort['t']
}

/**
 * 构建并注册应用内置命令。
 * @param deps commandStore/actions/isMac/t（C-W3-5 注入）
 */
export function registerAppCommands(deps: RegisterAppCommandsDeps): void {
  const { commandStore, actions, isMac, t } = deps

  /** 将存储的 key（如 'n' / 'shift+n'）转为显示用的修饰键符号 */
  function displayShortcut(key: string): string {
    const parts = key.split('+')
    const result: string[] = []
    for (const p of parts) {
      if (p === 'mod') result.push(isMac ? '⌘' : 'Ctrl')
      else if (p === 'shift') result.push(isMac ? '⇧' : 'Shift')
      else if (p === 'alt') result.push(isMac ? '⌥' : 'Alt')
      else result.push(p.toUpperCase())
    }
    return result.join(isMac ? '' : '+')
  }

  /** 构建快捷键显示文本：有 override 用 override，否则用默认修饰键 */
  function resolveShortcut(cmdId: string, defaultKey: string): string {
    const override = commandStore.shortcutOverrides.value[cmdId]
    if (override) return displayShortcut(override)
    // 默认格式：⌘+Key
    return `${isMac ? '⌘' : 'Ctrl+'}${defaultKey.toUpperCase()}`
  }

  const appCommands: AppCommand[] = [
    { id: 'new-session', name: t('settings.command.new-session'), shortcut: resolveShortcut('new-session', 'n'), action: actions.newSession },
    { id: 'toggle-sidebar', name: t('settings.command.toggle-sidebar'), shortcut: resolveShortcut('toggle-sidebar', 'b'), action: actions.toggleSidebar },
    { id: 'go-overview', name: t('settings.command.go-overview'), action: actions.goOverview },
    // FR-16：Cmd+Shift+P 打开预设选择 Popover
    { id: 'open-preset-select', name: t('settings.command.open-preset-select'), shortcut: resolveShortcut('open-preset-select', 'shift+p'), action: actions.requestPresetOpen },
  ]

  commandStore.registerApp(appCommands)
}
