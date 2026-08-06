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
      class="fso fixed inset-0 z-[var(--z-modal)] flex bg-bg"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.title')"
      @keydown="onKeydown"
    >
      <!-- 左 nav -->
      <nav ref="navRootEl" class="flex w-[220px] shrink-0 flex-col bg-[var(--bg-sunken)] p-[8px] gap-[1px]" data-settings-nav>
        <!-- traffic light 安全区：pl-[80px] 让位红黄绿（三平台统一，全屏态保留无害）。
             本 overlay 是 fixed inset:0 全屏覆盖，不继承 AsideRegion 的 pt-[52px]，故显式让位 -->
        <div class="flex h-[44px] items-center pl-[80px] pr-[12px]">
          <span class="text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-dim">{{ t('settings.title') }}</span>
        </div>
        <div class="flex flex-col gap-[1px]">
          <Button
            v-for="item in menus"
            :key="item.id"
            type="button"
            variant="ghost"
            class="nav-item group h-auto w-full flex items-center gap-[8px] py-[8px] px-[10px] rounded-[var(--radius-sm)] text-[length:var(--text-base)] font-normal leading-[1.5] text-left text-neutral-mid whitespace-normal transition-all duration-[var(--duration-fast)] ease-[var(--ease)] [&:hover:not(.active)]:bg-surface-hover [&:hover:not(.active)]:text-neutral-fg [&.active]:!bg-surface [&.active]:text-accent"
            :class="{ active: item.id === activeMenu }"
            :data-testid="`settings-nav-${item.id}`"
            :aria-current="item.id === activeMenu ? 'page' : undefined"
            @click="select(item.id)"
          >
            <component :is="item.icon" class="!w-[16px] !h-[16px] shrink-0 opacity-[0.85] transition-opacity duration-[var(--duration-fast)] ease-[var(--ease)] group-hover:opacity-100 group-[.active]:opacity-100" />
            <span class="flex-1 min-w-0 truncate">{{ t(item.labelKey) }}</span>
            <span v-if="getItemCount(item.id)" class="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-surface px-[5px] font-mono text-[10px] font-semibold text-neutral-dim shrink-0">{{ getItemCount(item.id) }}</span>
          </Button>
        </div>
      </nav>

      <!-- 右 content -->
      <div ref="contentEl" class="flex min-w-0 flex-1 flex-col bg-bg overflow-auto">
        <div class="flex h-[44px] shrink-0 items-center justify-between px-[14px] border-b border-border">
          <span class="text-[14px] font-semibold text-neutral-fg">{{ t('settings.title') }} · {{ t(currentMenu.labelKey) }}</span>
          <Button
            type="button"
            variant="ghost"
            class="xbtn flex h-[28px] w-[28px] p-0 items-center justify-center rounded-[var(--radius-sm)] text-[length:var(--text-base)] font-normal leading-[1.5] text-neutral-mid whitespace-normal transition-all duration-[var(--duration-fast)] ease-[var(--ease)] hover:bg-surface-hover hover:text-neutral-fg"
            :title="t('settings.closeEsc')"
            :aria-label="t('settings.close')"
            data-testid="settings-close-btn"
            @click="close"
          >
            <X class="!w-[16px] !h-[16px]" />
          </Button>
        </div>
        <div class="content-col-inner w-full max-w-[var(--content-max-w)] m-0 pt-[var(--space-6)] px-[24px] pb-[var(--space-8)]">
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
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { Settings, Sparkles, Bot, Blocks, SlidersHorizontal, ScrollText, TerminalSquare, GitBranch, ClipboardList, X, Download, Bug } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { getSettingsStore, useSettings, type SystemSettings } from '@xyz-agent/core'
import { useToast } from '@/composables/useToast'
import type { SkillDirConfig } from '@xyz-agent/shared'
import ProviderPage from './provider/ProviderPage.vue'
import SettingsResourcePage from './resource/SettingsResourcePage.vue'
import ExtensionPage from './extension/ExtensionPage.vue'
import SystemPage from './system/SystemPage.vue'
import SystemPromptPage from './system/SystemPromptPage.vue'
import TerminalPage from './terminal/TerminalPage.vue'
import WorktreePage from './worktree/WorktreePage.vue'
import PiPresetsPage from './preset/PiPresetsPage.vue'
import UpdatePage from './update/UpdatePage.vue'
import TokenDebugPage from './system/TokenDebugPage.vue'

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

/** window 级 ESC 兜底：焦点逃逸到 body（不在 .fso 内）时，.fso 的 @keydown 收不到事件，
 *  需 window 监听兜底。open=true 时注册、false 时自动卸载（reactive target）。
 *  与 .fso 的 onKeydown 并存：焦点在 .fso 内时 onKeydown 先 fire（preventDefault），
 *  本监听检查 defaultPrevented 跳过，避免重复 close。 */
useEventListener(
  () => (props.open ? window : null),
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (e.defaultPrevented) return
    e.preventDefault()
    close()
  },
)

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
    await settingsStore.setSkillDirs(dirs)
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

async function onUpdateAgentDirs(dirs: SkillDirConfig[]): Promise<void> {
  try {
    await settingsStore.setAgentDirs(dirs)
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

onBeforeUnmount(() => {
  if (props.open && triggerEl.value) triggerEl.value.focus()
})
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
/* [HISTORICAL] 本文件保留 <style scoped> 的原因：.nav-item:focus-visible / .xbtn:focus-visible
   的双环 box-shadow `0 0 0 2px var(--accent), 0 0 0 4px rgba(0,0,0,0.4)` 是多值叠加（内环
   accent + 外环半透明黑），Tailwind 单个 box-shadow 工具类无法表达多值叠加，属 AGENTS.md §3
   明确允许的 escape hatch（与 MainPanel.vue 多值 shadow 同类）。其余几何/颜色/布局/过渡均已
   迁移至 Tailwind 工具类（见 template 各元素 class）。 */
.nav-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.xbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
</style>
