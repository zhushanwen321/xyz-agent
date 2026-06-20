/**
 * Sidebar store —— tab 切换 + 折叠态（UC-3 / P2）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * activeTab 持久化到 localStorage（同 i18n 的 xyz-agent-* 裸字符串模式），
 * 刷新 / 收起再展开均恢复上次 tab（spec §视图切换）。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type SidebarTab = 'sessions' | 'files'

const SIDEBAR_TAB_KEY = 'xyz-agent-sidebar'
const VALID_TABS: ReadonlySet<SidebarTab> = new Set<SidebarTab>(['sessions', 'files'])

/** 读取持久化 tab；缺失或被篡改为非法值时回退 'sessions' */
function loadActiveTab(): SidebarTab {
  const saved = localStorage.getItem(SIDEBAR_TAB_KEY)
  if (saved !== null && VALID_TABS.has(saved as SidebarTab)) {
    return saved as SidebarTab
  }
  return 'sessions'
}

export const useSidebarStore = defineStore('sidebar', () => {
  const activeTab = ref<SidebarTab>(loadActiveTab())
  const collapsed = ref(false)

  // 任意写入路径（SegmentedTab v-model / 直接赋值）都同步落盘
  watch(activeTab, (tab) => {
    localStorage.setItem(SIDEBAR_TAB_KEY, tab)
  })

  /** 切换折叠态（app-nav-controls 收起按钮 + 未来 ⌘B 调用） */
  function toggleCollapsed(): void {
    collapsed.value = !collapsed.value
  }

  return { activeTab, collapsed, toggleCollapsed }
})
