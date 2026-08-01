<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { settingsPage, closeSettings, type SettingsPage } from '@/composables/useStore'
import { providers, extensions } from '@/mock/sessions'
import SettingsNavItem from './SettingsNavItem.vue'
import ProviderPage from './ProviderPage.vue'
import ExtensionPage from './ExtensionPage.vue'
import ResourcesPage from './ResourcesPage.vue'
import SystemPromptPage from './SystemPromptPage.vue'
import PlaceholderPage from './PlaceholderPage.vue'

/** SettingsOverlay：fixed inset-0 z-modal bg-bg 全屏覆盖。
 * 左 nav w-220 bg-sunken + 右 content flex-1 bg-bg（内容列 max-w-720 mx-0 左对齐）。*/

interface NavDef {
  key: SettingsPage
  label: string
  icon: string
  count?: number
}

const ic = (p: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`

const NAV: NavDef[] = [
  { key: 'provider', label: '供应商', count: providers.length, icon: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>') },
  { key: 'skill', label: '技能', count: 12, icon: ic('<path d="M12 3l1.9 5.8L20 10l-5 3.7L16.5 20 12 16.3 7.5 20 9 13.7 4 10l6.1-1.2z"/>') },
  { key: 'agent', label: '代理', count: 5, icon: ic('<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>') },
  { key: 'extension', label: '扩展', count: extensions.length, icon: ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>') },
  { key: 'system-prompt', label: '系统提示词', icon: ic('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M7 12h10"/>') },
  { key: 'terminal', label: '终端', icon: ic('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>') },
  { key: 'preset', label: '预设', icon: ic('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/>') },
  { key: 'worktree', label: '工作区', icon: ic('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>') },
  { key: 'update', label: '更新', icon: ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>') },
  { key: 'system', label: '系统', icon: ic('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>') },
]

function select(key: SettingsPage) {
  settingsPage.value = key
  // M5：切 nav 时内容列滚动回顶部（fs-content 是滚动容器）
  contentEl.value?.scrollTo({ top: 0 })
}

const currentPageTitle = computed(() => NAV.find((n) => n.key === settingsPage.value)?.label ?? '')

const navRoot = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)
/** 打开前的焦点元素（触发按钮）——关闭后还焦（spec §8） */
const triggerEl = ref<HTMLElement | null>(null)

function getFocusables(): HTMLElement[] {
  if (!navRoot.value) return []
  return Array.from(
    navRoot.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

/** §8 键盘：Tab 循环（焦点陷阱，不逃逸到背景）+ nav 内 ↑↓/Home/End 移动并切换 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab') {
    const list = getFocusables()
    if (list.length === 0) return
    const first = list[0]
    const last = list[list.length - 1]
    const active = document.activeElement
    if (active === last && !e.shiftKey) {
      e.preventDefault()
      first.focus()
    } else if (active === first && e.shiftKey) {
      e.preventDefault()
      last.focus()
    } else if (navRoot.value && active instanceof HTMLElement && !navRoot.value.contains(active)) {
      // 焦点已逃出 overlay（如落到 body）→ 拉回首项
      e.preventDefault()
      first.focus()
    }
    return
  }
  // ↑↓ / Home / End：仅当焦点在 nav 项上时处理（spec §8：↑↓ 只在 nav 内移动+切换，Tab 才跨区域）
  const t = e.target
  if (!(t instanceof HTMLElement) || !t.classList.contains('nav-item')) return
  const items = Array.from(navRoot.value?.querySelectorAll<HTMLElement>('.fs-nav .nav-item') ?? [])
  const i = items.indexOf(t)
  if (i === -1) return
  let next = -1
  if (e.key === 'ArrowDown') next = i + 1
  else if (e.key === 'ArrowUp') next = i - 1
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  if (next < 0 || next >= items.length) return
  e.preventDefault()
  items[next].focus()
  select(NAV[next].key)
}

onMounted(() => {
  // 记录触发元素（关闭后还焦给触发器，spec §8）
  triggerEl.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
  nextTick(() => {
    const first = navRoot.value?.querySelector<HTMLElement>('.fs-nav .nav-item')
    first?.focus()
  })
})
onUnmounted(() => {
  // 覆盖所有关闭路径（ESC / X / 快捷键）：焦点归还触发按钮
  triggerEl.value?.focus()
})
</script>

<template>
  <div class="fso" ref="navRoot" @keydown="onKeydown">
    <!-- 左 nav -->
    <nav class="fs-nav">
      <div class="nav-brand">
        <span class="brand-label">设置</span>
      </div>
      <div class="nav-list">
        <SettingsNavItem
          v-for="item in NAV"
          :key="item.key"
          :label="item.label"
          :icon="item.icon"
          :count="item.count"
          :active="settingsPage === item.key"
          @click="select(item.key)"
        />
      </div>
    </nav>

    <!-- 右 content -->
    <div class="fs-content" ref="contentEl">
      <div class="fs-head">
        <span class="fs-title">设置 · {{ currentPageTitle }}</span>
        <button class="xbtn" title="关闭设置（Esc）" aria-label="关闭设置" @click="closeSettings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="content-col-inner">
        <ProviderPage v-if="settingsPage === 'provider'" />
        <ExtensionPage v-else-if="settingsPage === 'extension'" />
        <ResourcesPage v-else-if="settingsPage === 'skill'" />
        <SystemPromptPage v-else-if="settingsPage === 'system-prompt'" />
        <PlaceholderPage v-else :page="settingsPage" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.fso {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--bg);
  display: flex;
}

/* 左 nav */
.fs-nav {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-sunken);
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 1px;
}
.nav-brand {
  height: 40px;
  display: flex;
  align-items: center;
  padding: 0 var(--space-3);
  margin-bottom: var(--space-2);
}
.brand-label {
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--neutral-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.nav-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 右 content */
.fs-content {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  overflow-y: auto;
}
.fs-head {
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
}
.fs-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--neutral-fg);
}
.content-col-inner {
  max-width: var(--content-max-w);
  margin: 0;
  padding: var(--space-6) 24px var(--space-8);
}

/* X 关闭按钮（fs-head 内右侧） */
.xbtn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  transition: all var(--duration-fast) var(--ease);
}
.xbtn svg {
  width: 16px;
  height: 16px;
}
.xbtn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.xbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
</style>
