<!--
  DrawerPanel —— 跨端共享 drawer 容器（W3 · p3-strangler-domains::drawer）。

  迁移自 renderer components/panel/SideDrawer.vue 的「跨端共享容器」部分（drawer 域归位
  第三步：W1 控制态/协同进 core、W2 widget 缓冲容器进 core、W3 容器组件进 ui 包）。
  桌面独占内容面板（GitPanel/TerminalView/BrowserPane/CommandDocPanel/DetailPane）
  留壳 slot 挂载（D5 硬编码占位，不走 contribution 路由）——本组件经默认 slot 接收，
  内置 widget 内容区（activeGuiComponent→activeLines→空态）作为 slot fallback（C2）。

  状态/数据契约（IF2 + clarify C1）：
  - props{isOpen, activeTab, docked, sessionId} 为控制态（父组件 PanelContainer 管理），
    本组件只接收 + emit close/set-tab/toggle-dock，不持有状态（§6.3 点5 架构解耦）
  - widget 缓冲数据（activeGuiComponent/activeLines/activeLinesMeta/statusEntries）
    经 props 注入（D3 壳层 useDrawerWidgetBuffers computed 传入，core widget-buffers 为 SSOT）
  - [P4 s5 w2] hasTasksData 条件 tab（tasks store 壳裁剪）已随 tasks 域删除移除

  不纳入（C3 clarify）：ESC 关闭（window keydown 桌面副作用）+ AC-13 unread badge
  （chatStore 壳层状态）——均为壳层职责，W4 shell-integration 在 PanelContainer 侧处理
  （经可选具名 slot header-extra 注入 badge，本组件零 chatStore 依赖）。
-->
<template>
  <Transition name="drawer-slide-right">
    <aside
      v-if="isOpen"
      class="relative flex h-full min-w-0 flex-col bg-surface"
      :aria-label="t('panel.sideDrawer.title')"
      data-testid="drawer-panel"
    >
      <!-- L1 tab 栏：drawer 内部子区（D2 一体化后不再作独立 header）。
           与 main 共享统一 surface 外壳，去 bg-surface-2 浮起分层，改用 border-b hairline 与内容区分隔（对齐 demo SideDrawer .sd-l1）。
           escape hatch scoped（见文件底部）：aside 投影构成 D2 一体化生长的弱分隔语义。 -->
      <div class="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div class="flex flex-1 gap-0.5">
          <Button
            v-for="tab in tabs"
            :key="tab.key"
            variant="ghost"
            class="size-7 shrink-0 justify-center rounded-sm p-0"
            :class="activeTab === tab.key ? 'bg-surface-hover text-neutral-fg' : 'text-neutral-mid'"
            :title="tab.label"
            :data-testid="`drawer-tab-${tab.key}`"
            @click="emit('set-tab', tab.key)"
          >
            <component :is="tab.icon" class="size-3.5" />
          </Button>
        </div>

        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0"
          :class="docked ? 'text-accent' : 'text-neutral-dim'"
          :title="docked ? t('panel.sideDrawer.unpin') : t('panel.sideDrawer.pin')"
          data-testid="drawer-pin"
          @click="emit('toggle-dock')"
        >
          <PinOff v-if="docked" class="size-3" />
          <Pin v-else class="size-3" />
        </Button>
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
          :title="t('panel.sideDrawer.close')"
          data-testid="drawer-close"
          @click="emit('close')"
        >
          <X class="size-3" />
        </Button>
        <!-- header-extra：壳层注入点（W4）——unread badge 等桌面形态壳状态经此挂载（C3：壳层职责）。
             可选具名 slot，无默认内容；ui 容器零 chatStore 感知（D3 纯净性）。 -->
        <slot name="header-extra" />
      </div>

      <!-- 内容区：壳按 tab 经默认 slot 注入桌面独占面板（Git/Terminal/Browser 等）；
           slot 无有效内容时（v-if chain 全 false / 跨端不传 slot）回退内置 widget 内容区（gui→lines→空态）。
           用 hasDesktopPanelContent() 而非 `<slot>` fallback：父组件提供 slot 函数但运行时为空时，
           Vue 的 slot fallback 不生效，需显式判断渲染结果。 -->
      <div class="min-h-0 flex-1 overflow-auto" data-testid="drawer-content">
        <!-- 内容区四支（slot 面板 / gui / lines / 空态）tab 切换瞬时互切 → out-in 淡入淡出。
             条件链分支包在 Transition 内（非外层恒存 div）：同一时刻仅单根渲染，满足 Transition 单根约束。 -->
        <Transition name="drawer-content-fade" mode="out-in">
          <slot v-if="hasDesktopPanelContent()" />
          <!-- active tab 有结构化 GUI widget（extension:widgetGui）→ 优先 GuiComponentRenderer 渲染 -->
          <div
            v-else-if="activeGuiComponent"
            class="flex h-full flex-col gap-0 overflow-auto p-2"
            data-testid="drawer-widget-gui"
          >
            <GuiComponentRenderer :component="activeGuiComponent" />
          </div>
          <!-- active tab 有 widget 内容 → 渲染等宽文本输出（每行一个 div，font-mono + pre-wrap） -->
          <div
            key="widget-lines"
            v-else-if="activeLines.length"
            class="flex h-full flex-col gap-0 overflow-auto p-2"
            :class="activeLinesMeta.unknown ? 'opacity-80' : ''"
            data-testid="drawer-widget-lines"
          >
            <div
              v-if="activeLinesMeta.unknown"
              class="mb-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] text-neutral-mid"
              data-testid="drawer-unknown-badge"
            >
              {{ t('panel.sideDrawer.unknownWidget') }}：{{ activeLinesMeta.key }}
            </div>
            <code
              v-for="(line, i) in activeLines"
              :key="i"
              class="block whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.45] text-neutral-fg/90"
              >{{ line }}</code
            >
          </div>
          <!-- active tab 无 widget 内容 → 空态占位 -->
          <div
            key="widget-empty"
            v-else
            class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
            data-testid="drawer-widget-empty"
          >
            <component :is="activeTabMeta.icon" class="size-6 text-neutral-dim opacity-40" />
            <p class="text-[12px] text-neutral-dim opacity-70">{{ activeTabMeta.emptyText }}</p>
            <p class="text-[11px] text-neutral-dim opacity-50">{{ activeTabMeta.emptyHint }}</p>
          </div>
        </Transition>
      </div>

      <!-- extension status 底栏（按 statusKey 聚合最新 text）。
           无 status 推送时不占位，避免空态挤压内容区。 -->
      <footer
        v-if="statusEntries.length"
        class="flex flex-col gap-0.5 border-t border-border px-2 py-1"
        data-testid="drawer-status-footer"
      >
        <div
          v-for="entry in statusEntries"
          :key="entry.statusKey"
          class="flex items-center gap-1.5 font-mono text-[10px]"
        >
          <span class="shrink-0 text-neutral-dim">{{ entry.statusKey }}</span>
          <!-- textRaw 有 ANSI 着色 → AnsiText 渲染保留颜色；否则纯文本兜底。
               容器承载 truncate（min-w-0 + overflow-hidden + ellipsis），避免与 AnsiText 内部 whitespace-pre-wrap 冲突。 -->
          <div v-if="entry.textRaw" class="min-w-0 flex-1 overflow-hidden">
            <AnsiText :content="entry.textRaw" class="block truncate text-neutral-mid" />
          </div>
          <span v-else class="min-w-0 flex-1 truncate text-neutral-mid">{{ entry.text }}</span>
        </div>
      </footer>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { Comment, computed, useSlots } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, FileText, GitBranch, Globe, Pin, PinOff, Terminal as TerminalIcon, X } from '@lucide/vue'
import { Button } from '@xyz-agent/ui'
import { AnsiText, GuiComponentRenderer } from '../../rendering-protocol'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { SideDrawerTab } from '@xyz-agent/core/domain/drawer'

const slots = useSlots()

/**
 * 默认 slot 是否有有效内容（非注释节点）。
 * C2 契约：桌面壳按 tab 经默认 slot 注入独占面板（Git/Doc/Detail/Browser/Terminal），
 * 无匹配面板时（如 browser 无 url）不注入 → 应回退内置 widget 内容区。但 Vue `<slot>` 的
 * fallback 只在「父组件未提供 slot 函数」时生效——PanelContainer 的 v-if chain 使 slot 函数
 * 始终存在（运行时渲染为空/注释节点），故需在此显式判断渲染结果，空则走 widget 区。
 * 非 computed：slots.default() 返回的 VNode 无响应式依赖，computed 缓存不失效；
 * 模板表达式每次渲染求值才能反映 tab 切换后的 slot 内容。
 */
function hasDesktopPanelContent(): boolean {
  const children = slots.default?.() ?? []
  return children.some((v) => v && (v.type as unknown) !== Comment)
}

const props = withDefaults(
  defineProps<{
    isOpen: boolean
    activeTab: SideDrawerTab
    docked: boolean
    /** widget 订阅的 session 标识（壳层透传，为 null 不订阅） */
    sessionId: string | null
    /** active tab 的结构化 GUI 组件（extension:widgetGui，壳 useDrawerWidgetBuffers 传入） */
    activeGuiComponent?: GuiComponent | null
    /** active tab 的文本行（extension:widget，terminal/browser/unknownWidget fallback） */
    activeLines?: string[]
    /** active 文本行的元信息（unknown 徽章） */
    activeLinesMeta?: { unknown: boolean; key: string }
    /** status footer 条目（extension:status，statusKey 维度聚合） */
    statusEntries?: Array<{ statusKey: string; text: string; textRaw?: string }>
  }>(),
  {
    activeGuiComponent: null,
    activeLines: () => [],
    activeLinesMeta: () => ({ unknown: false, key: '' }),
    statusEntries: () => [],
  },
)

const emit = defineEmits<{
  close: []
  'set-tab': [tab: SideDrawerTab]
  'toggle-dock': []
}>()

const { t } = useI18n()

interface TabMeta {
  key: SideDrawerTab
  label: string
  icon: Component
  emptyText: string
  emptyHint: string
}

/** tab 元信息（§6.3 点2：Terminal/Browser/Git/Doc/Detail）。
 *  Git tab 内容为 GitPanel（壳 slot 注入，inject 数据）。
 *  [P4 s5 w2] Tasks 条件 tab（T3 壳裁剪）已随 tasks 域删除移除。 */
const tabs = computed<TabMeta[]>(() => {
  const base: TabMeta[] = [
    {
      key: 'terminal',
      label: t('panel.sideDrawer.tabTerminal'),
      icon: TerminalIcon,
      emptyText: t('panel.sideDrawer.noTerminal'),
      emptyHint: t('panel.sideDrawer.terminalHint'),
    },
    {
      key: 'browser',
      label: t('panel.sideDrawer.tabBrowser'),
      icon: Globe,
      emptyText: t('panel.sideDrawer.noBrowser'),
      emptyHint: t('panel.sideDrawer.browserHint'),
    },
    {
      key: 'git',
      label: t('panel.sideDrawer.tabGit'),
      icon: GitBranch,
      emptyText: t('panel.sideDrawer.noGit'),
      emptyHint: t('panel.sideDrawer.gitHint'),
    },
    {
      key: 'doc',
      label: t('panel.sideDrawer.tabDoc'),
      icon: BookOpen,
      emptyText: t('panel.sideDrawer.noDoc'),
      emptyHint: t('panel.sideDrawer.docHint'),
    },
    {
      key: 'detail',
      label: t('panel.sideDrawer.tabDetail'),
      icon: FileText,
      emptyText: t('panel.sideDrawer.noFileSelected'),
      emptyHint: t('panel.sideDrawer.detailHint'),
    },
  ]
  return base
})

const activeTabMeta = computed<TabMeta>(() => tabs.value.find((tab) => tab.key === props.activeTab) ?? tabs.value[0])
</script>

<style scoped>
/* 抽屉淡入/淡出（panel/spec.md v2）。
   内容 opacity 淡入足够柔和（布局瞬时切换配合 opacity 淡入）。
   escape hatch：Vue Transition 类无法用 Tailwind 表达（需 enter-from/leave-to 同时设 opacity）。 */
.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to {
  opacity: 0;
}
.drawer-slide-right-enter-active,
.drawer-slide-right-leave-active {
  transition: opacity var(--duration-slow) var(--ease);
}
/* 内容区四支互切（slot 面板 / gui / lines / 空态）淡入淡出。
   mode="out-in"：旧支 leave 完成才 enter 新支，避免双渲染重叠。 */
.drawer-content-fade-enter-active,
.drawer-content-fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease);
}
.drawer-content-fade-enter-from,
.drawer-content-fade-leave-to {
  opacity: 0;
}
</style>
