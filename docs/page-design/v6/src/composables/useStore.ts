import { reactive, ref } from 'vue'

/** 全局交互状态（非业务逻辑，纯 UI 状态驱动）*/

// 侧栏 tab
export type SidebarTab = 'sessions' | 'files' | 'subagents' | 'workflows' | 'plugin'
export const sidebarTab = ref<SidebarTab>('sessions')

// drawer
export const drawerOpen = ref(true)
export type DrawerTab = 'terminal' | 'browser' | 'git' | 'doc' | 'detail' | 'subagent' | 'workflow'
export const drawerTab = ref<DrawerTab>('detail')

// 侧栏折叠
export const sidebarCollapsed = ref(false)

// overlay
export const searchModalOpen = ref(false)
export const settingsOpen = ref(false)
export type SettingsPage = 'provider' | 'extension' | 'resources' | 'system-prompt' | 'terminal' | 'preset' | 'worktree' | 'update' | 'system' | 'skill'
export const settingsPage = ref<SettingsPage>('provider')

// 选中 session
export const activeSessionId = ref<string>('session-1')

// drawer 二级 tab（多实例 tab 用）
export const detailFileTab = ref(0)
export const terminalInstanceTab = ref(0)
export const browserPageTab = ref(0)

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

/** ESC 关闭所有 overlay */
export function handleEscape() {
  searchModalOpen.value = false
  settingsOpen.value = false
}
