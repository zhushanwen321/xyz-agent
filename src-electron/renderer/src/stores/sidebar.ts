/**
 * Sidebar store —— tab 切换 + 折叠态（UC-3 / P2）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * 骨架阶段：state 合法初始值。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type SidebarTab = 'sessions' | 'files'

export const useSidebarStore = defineStore('sidebar', () => {
  const activeTab = ref<SidebarTab>('sessions')
  const collapsed = ref(false)

  /** 切换折叠态（app-nav-controls 收起按钮 + 未来 ⌘B 调用） */
  function toggleCollapsed(): void {
    collapsed.value = !collapsed.value
  }

  return { activeTab, collapsed, toggleCollapsed }
})
