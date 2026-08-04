<!--
  容器组件 · Settings 全屏 overlay（v6 §6.4 D1 + §5.8 GroupCard）。
  数据来自 settings store（单一真相源：providers/skills/agents/extensions/system）。
  store 由 AppShell 应用级 init（常驻订阅），本组件只读 store + open 时刷新 providers。
  形态：fixed inset-0 z-modal bg-bg 全屏覆盖。左 nav 220px（bg-sunken）+ 右 content flex-1（内容列 max-w-720 左对齐）。
  nav 11 项（含 token-debug）。header 面包屑「设置 · <page>」+ 右侧 X 关闭。
-->
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fso"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.title')"
      @keydown="onKeydown"
    >
      <!-- 左 nav -->
      <nav ref="navRootEl" class="fs-nav" data-settings-nav>
        <div class="nav-brand">
          <span class="brand-label">{{ t('settings.title') }}</span>
        </div>
        <div class="nav-list">
          <button
            v-for="item in menus"
            :key="item.id"
            type="button"
            class="nav-item"
            :class="{ active: item.id === activeMenu }"
            :data-testid="`settings-nav-${item.id}`"
            :aria-current="item.id === activeMenu ? 'page' : undefined"
            @click="select(item.id)"
          >
            <component :is="item.icon" class="ico" />
            <span class="label">{{ t(item.labelKey) }}</span>
            <span v-if="getItemCount(item.id)" class="count">{{ getItemCount(item.id) }}</span>
          </button>
        </div>
      </nav>

      <!-- 右 content -->
      <div ref="contentEl" class="fs-content">
        <div class="fs-head">
          <span class="fs-title">{{ t('settings.title') }} · {{ t(currentMenu.labelKey) }}</span>
          <button
            type="button"
            class="xbtn"
            :title="t('settings.closeEsc')"
            :aria-label="t('settings.close')"
            data-testid="settings-close-btn"
            @click="close"
          >
            <X class="x-ico" />
          </button>
        </div>
        <div class="content-col-inner">
          <ProviderPage v-if="activeMenu === 'provider'" :providers="providers" />
          <SettingsResourcePage
            v-else-if="activeMenu === 'skill'"
            kind="skill"
            :items="skills"
            :dirs="skillDirs"
            @update-dirs="onUpdateSkillDirs"
          />
          <SettingsResourcePage
            v-else-if="activeMenu === 'agent'"
            kind="agent"
            :items="agents"
            :dirs="agentDirs"
            @update-dirs="onUpdateAgentDirs"
          />
          <ExtensionPage v-else-if="activeMenu === 'extension'" :extensions="extensions" />
          <SystemPage v-else-if="activeMenu === 'system'" :system="system" @update="onSystemUpdate" />
          <SystemPromptPage v-else-if="activeMenu === 'system-prompt'" />
          <TerminalPage v-else-if="activeMenu === 'terminal'" />
          <PiPresetsPage v-else-if="activeMenu === 'preset'" />
          <WorktreePage v-else-if="activeMenu === 'worktree'" />
          <UpdatePage v-else-if="activeMenu === 'update'" />
          <TokenDebugPage v-else-if="activeMenu === 'token-debug'" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Settings, Sparkles, Bot, Blocks, SlidersHorizontal, ScrollText, TerminalSquare, GitBranch, ClipboardList, X, Download, Bug } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { getSettingsStore, useSettings, type SystemSettings } from '@xyz-agent/core'
import { useToast } from '@/composables/useToast'
import type { SkillDirConfig } from '@xyz-agent/shared'
import ProviderPage from './ProviderPage.vue'
import SettingsResourcePage from './SettingsResourcePage.vue'
import ExtensionPage from './ExtensionPage.vue'
import SystemPage from './SystemPage.vue'
import SystemPromptPage from './SystemPromptPage.vue'
import TerminalPage from './TerminalPage.vue'
import WorktreePage from './WorktreePage.vue'
import PiPresetsPage from './PiPresetsPage.vue'
import UpdatePage from './UpdatePage.vue'
import TokenDebugPage from './TokenDebugPage.vue'

const menus = [
  { id: 'provider', labelKey: 'settings.menu.provider', icon: Settings },
  { id: 'skill', labelKey: 'settings.menu.skill', icon: Sparkles },
  { id: 'agent', labelKey: 'settings.menu.agent', icon: Bot },
  { id: 'extension', labelKey: 'settings.menu.extension', icon: Blocks },
  { id: 'system-prompt', labelKey: 'settings.menu.systemPrompt', icon: ScrollText },
  { id: 'terminal', labelKey: 'settings.menu.terminal', icon: TerminalSquare },
  { id: 'preset', labelKey: 'settings.menu.preset', icon: ClipboardList },
  { id: 'worktree', labelKey: 'settings.menu.worktree', icon: GitBranch },
  { id: 'update', labelKey: 'settings.menu.update', icon: Download },
  { id: 'system', labelKey: 'settings.menu.system', icon: SlidersHorizontal },
  { id: 'token-debug', labelKey: 'settings.menu.tokenDebug', icon: Bug },
] as const

type MenuId = (typeof menus)[number]['id']

const { t } = useI18n()

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const activeMenu = ref<MenuId>('provider')
const currentMenu = computed(() => menus.find((m) => m.id === activeMenu.value) ?? menus[0])

const settingsStore = getSettingsStore()
const { providers, skills, agents, extensions, system, skillDirs, agentDirs } = settingsStore
const { refreshProviders } = useSettings()

// 打开时刷新 providers + 聚焦首个 nav 项；关闭时还原焦点给触发元素
const triggerEl = ref<HTMLElement | null>(null)
const navRootEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    triggerEl.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
    refreshProviders()
    nextTick(() => {
      navRootEl.value?.querySelector<HTMLElement>('.nav-item')?.focus()
    })
  } else if (triggerEl.value) {
    triggerEl.value.focus()
    triggerEl.value = null
  }
})

function close(): void {
  emit('update:open', false)
}

function select(id: MenuId): void {
  activeMenu.value = id
  // 切 nav 时内容列滚动回顶部
  contentEl.value?.scrollTo({ top: 0 })
}

function getItemCount(id: string): number {
  switch (id) {
    case 'provider': return providers.value.length
    case 'skill': return skills.value.length
    case 'agent': return agents.value.length
    case 'extension': return extensions.value.length
    default: return 0
  }
}

/** 键盘：Tab 循环（焦点陷阱）+ nav 内 ↑↓/Home/End 移动切换 + Esc 关闭 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
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
    }
    return
  }
  const target = e.target
  if (!(target instanceof HTMLElement) || !target.classList.contains('nav-item')) return
  const items = Array.from(navRootEl.value?.querySelectorAll<HTMLElement>('.nav-item') ?? [])
  const i = items.indexOf(target)
  if (i === -1) return
  let next = -1
  if (e.key === 'ArrowDown') next = i + 1
  else if (e.key === 'ArrowUp') next = i - 1
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  if (next < 0 || next >= items.length) return
  e.preventDefault()
  items[next].focus()
  select(menus[next].id)
}

function getFocusables(): HTMLElement[] {
  // 整个 overlay（navRoot 的最近 dialog 容器）作为焦点陷阱范围
  const root = navRootEl.value?.closest('.fso') as HTMLElement | null
  if (!root) return []
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

/** SystemPage 偏好更新 → 走 store（写 localStorage + 同步 DOM + i18n）+ toast 反馈。 */
const { info: toastInfo, error: toastError } = useToast()
async function onSystemUpdate(patch: Partial<SystemSettings>): Promise<void> {
  try {
    await settingsStore.setSystem(patch)
    toastInfo(t('settings.applied'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

async function onUpdateSkillDirs(dirs: SkillDirConfig[]): Promise<void> {
  try {
    await settingsStore.setSkillDirs(dirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

async function onUpdateAgentDirs(dirs: SkillDirConfig[]): Promise<void> {
  try {
    await settingsStore.setAgentDirs(dirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

onBeforeUnmount(() => {
  if (props.open && triggerEl.value) triggerEl.value.focus()
})
// Button 仅用于类型兼容占位（避免未用 import 被 tree-shake 报错），实际 nav 用原生 button 以控焦点陷阱
void Button
</script>

<style>
/* ── v6 settings 页共享范式（v6 §6.4 + §5.8）──
   集中定义避免各页 scoped 重复；限定 .content-col-inner 作用域，不污染全局。
   page-head：各页顶部 H1 + 描述 block；gc-sub：GroupCard head slot 内副标题。 */
.content-col-inner .page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.content-col-inner .page-head .head-text { min-width: 0; }
.content-col-inner .page-head .title {
  font-size: 20px;
  font-weight: 600;
  color: var(--neutral-fg);
  letter-spacing: -0.01em;
}
.content-col-inner .page-head .desc {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.content-col-inner .page-head .head-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}
.content-col-inner .page-head .head-badge {
  height: 20px;
  padding: 0 var(--space-2);
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
}
.content-col-inner .gc-head-text { min-width: 0; }
.content-col-inner .gc-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.content-col-inner .gc-sub {
  margin-top: 2px;
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
  line-height: 1.4;
}
</style>

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
  height: 44px;
  display: flex;
  align-items: center;
  padding: 0 12px;
}
.brand-label {
  font-size: 11px;
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
.nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  font-size: var(--text-base);
  text-align: left;
  transition: all var(--duration-fast) var(--ease);
}
.nav-item:hover:not(.active) {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.nav-item.active {
  background: var(--surface);
  color: var(--accent);
}
.nav-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.ico {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  opacity: 0.85;
  transition: opacity var(--duration-fast) var(--ease);
}
.nav-item:hover:not(.active) .ico,
.nav-item.active .ico {
  opacity: 1;
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  height: 16px;
  min-width: 16px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--surface);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}

/* 右 content */
.fs-content {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.fs-head {
  height: 44px;
  flex-shrink: 0;
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
  width: 100%;
  max-width: var(--content-max-w);
  margin: 0;
  padding: var(--space-6) 24px var(--space-8);
}
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
.xbtn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.xbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.x-ico {
  width: 16px;
  height: 16px;
}
</style>
