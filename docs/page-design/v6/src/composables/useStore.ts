import { reactive, ref } from 'vue'

/** 全局交互状态（非业务逻辑，纯 UI 状态驱动）*/

// 侧栏 tab
export type SidebarTab = 'sessions' | 'files' | 'subagents' | 'workflows' | 'plugin'
export const sidebarTab = ref<SidebarTab>('sessions')

// drawer
export const drawerOpen = ref(true)
export type DrawerTab = 'terminal' | 'browser' | 'git' | 'doc' | 'detail' | 'subagent' | 'workflow'
export const drawerTab = ref<DrawerTab>('terminal')

// 侧栏折叠
export const sidebarCollapsed = ref(false)

// overlay
export const searchModalOpen = ref(false)
export const settingsOpen = ref(false)
export const askUserOpen = ref(false)
export const confirmOpen = ref(false)
export type SettingsPage = 'provider' | 'extension' | 'system-prompt' | 'terminal' | 'preset' | 'worktree' | 'update' | 'system' | 'skill' | 'agent' | 'token-debug'
export const settingsPage = ref<SettingsPage>('provider')

// 选中 session
export const activeSessionId = ref<string>('session-1')

// 对话流 staging 动作（TurnSummary fork/handoff → +Q 变体，spec-content §12.6）
export type StagedAction = { type: 'fork' | 'handoff' }
export const stagedAction = ref<StagedAction | null>(null)
export function clearStagedAction() { stagedAction.value = null }

// drawer 二级 tab（多实例 tab 用）
export const detailFileTab = ref(0)
export const terminalInstanceTab = ref(0)
export const browserPageTab = ref(0)

// workflow → subagent 联动（spec §11：call 点击传 sessionId；§10 空态判定）
export const subagentSessionId = ref<string | null>(null)

// 选中 workflow（spec §11：未选中显示空态；入口 = 消息流 workflow block 点击）
export const workflowName = ref<string | null>(null)

// 配色/密度（可选展示用，不影响结构）
export type ColorScheme = 'a' | 'semantic' | 'legacy'
export const colorScheme = ref<ColorScheme>('a')
export type Density = 'lean' | 'default' | 'lift'
export const density = ref<Density>('default')

/** 打开 / 关闭 overlay */
export function openSearch() { searchModalOpen.value = true }
export function closeSearch() { searchModalOpen.value = false }
export function openSettings(page?: SettingsPage) {
  if (page) settingsPage.value = page
  settingsOpen.value = true
}
export function closeSettings() { settingsOpen.value = false }
export function openAskUser() { askUserOpen.value = true }
export function closeAskUser() { askUserOpen.value = false }
export function openConfirm() { confirmOpen.value = true }
export function closeConfirm() { confirmOpen.value = false }

/** ESC 关闭所有 overlay */
export function handleEscape() {
  searchModalOpen.value = false
  settingsOpen.value = false
  askUserOpen.value = false
  confirmOpen.value = false
}
