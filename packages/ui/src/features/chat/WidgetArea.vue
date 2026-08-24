<script setup lang="ts">
/**
 * WidgetArea（M17 → v1.1 meta head）—— 对话流 widget 面板。
 *
 * 消费 ViewHostStore 的 per-session widget 缓存（经注入 ViewHostSource）：
 * getViewIds 枚举该 session 全部 viewId（widgetKey），逐个 getView 拼装多卡视图。
 *
 * v1.1 单一 head 架构（双头重复修复）：
 * - 标题/状态点/进度计数由 extension 经 GuiRenderResult.meta 提供，本壳层渲染成
 *   唯一的 head（点击整行折叠/展开）——此前壳层 viewId 行 + payload card header
 *   双头信息重复，且 card header 与面板样式脱节。
 * - head 底色 bg-surface-2（系统 header 浮起层 token），排版对齐 PanelHeader 模式
 *   （状态点在左 + mono 标题 + 右侧计数，h-6 紧凑档）。
 * - 卡体 bg-bg-input（composer 同款凹陷底）——对话流面板底是 surface，卡体凹陷
 *   与 head 浮起形成两级层次（无 border，v6 靠 bg 层级分组裁决）。
 * - 卡体 select-text：全局 user-select:none（style.css）下恢复内容可选中复制；
 *   head 是折叠按钮保持 select-none。
 * - 无 meta（v1 旧 extension 裸 component）：fallback viewId 标题、无状态点/进度。
 *
 * 常驻语义：extension 推 extension:widget/widgetGui 即缓存（同 key 覆盖更新），
 * gui:null 清除后条目消失（entries 为空时整体零 DOM，不残留空容器）。
 *
 * 宽度对齐 composer：外层 band px-5（同 composer-band），内层 grid
 * content-col（同 Composer 内容列原语）——单卡/多卡联合宽度恒 ≤ composer。
 *
 * 数据源经 inject 注入（VIEW_HOST_SOURCE_KEY），壳层 provide 真实实现，单测
 * global.provide mock；无注入时静默空态不崩（inject(key, null) 兜底）。
 */
import { computed, inject, ref } from 'vue'
import { VIEW_HOST_SOURCE_KEY } from '../../extension-host'
import type { ViewCacheEntry } from '../../extension-host'
import type { WidgetMeta } from '@xyz-agent/extension-protocol'
import GuiComponentRenderer from '../../rendering-protocol/GuiComponentRenderer.vue'

const props = defineProps<{
  /** 所属 session */
  sessionId: string
}>()

const source = inject(VIEW_HOST_SOURCE_KEY, null)

/** 单张 widget 卡的装配结果（viewId + 命中的缓存条目）。 */
interface WidgetEntry {
  viewId: string
  entry: ViewCacheEntry
}

/**
 * 该 session 全部可渲染 widget 卡。
 *
 * getViewIds 与 getView 必须都在本 computed 内调用：壳层 reactive 桥的依赖追踪
 * 靠调用路径触碰 reactive Map（分区后建 trigger + partition keys 迭代追踪），
 * 拆到 computed 外会断链 → widget 推送后不重算。过滤 entry 缺失或 guiTree 空的
 * 条目（gui:null 清除语义 + 异常 payload 防护，不出空卡）。
 */
const entries = computed<WidgetEntry[]>(() => {
  if (!source) return []
  return source
    .getViewIds(props.sessionId)
    .map((viewId) => ({ viewId, entry: source.getView(props.sessionId, viewId) }))
    .filter((e): e is WidgetEntry => e.entry !== undefined && e.entry.guiTree.length > 0)
})

/** 已收起的 viewId 集合（纯 UI 偏好，跨推送/跨 session 保留；ref 包装的 Set 被 Vue 深层 reactive 化，add/delete 可追踪）。 */
const collapsed = ref(new Set<string>())

function toggleCollapsed(viewId: string): void {
  if (collapsed.value.has(viewId)) collapsed.value.delete(viewId)
  else collapsed.value.add(viewId)
}

// ── head 渲染辅助（meta → 类名/文本）──

/** 状态点 bg 色：running=accent / done=success / failed=danger / idle=弱中性点 */
function statusDotClass(status: WidgetMeta['status'] | undefined): string {
  switch (status) {
    case 'running': return 'bg-accent'
    case 'done': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'idle': return 'bg-neutral-dim'
    default: return 'bg-neutral-dim'
  }
}

/** 进度 mini bar fill 色：显式 severity 优先（预算阈值），否则 done→success、默认 accent */
function progressFillClass(meta: WidgetMeta | undefined): string {
  const severity = meta?.progress?.severity
  if (severity === 'danger') return 'bg-danger'
  if (severity === 'warn') return 'bg-warn'
  if (severity === 'ok') return 'bg-accent'
  return meta?.status === 'done' ? 'bg-success' : 'bg-accent'
}

/** 进度计数文本：extension 格式化值 ?? current/total */
function progressLabel(meta: WidgetMeta | undefined): string {
  const p = meta?.progress
  if (!p) return ''
  return p.label ?? `${p.current}/${p.total}`
}

/** 百分比换算因子（no-magic-numbers，同 useDrawerSplitWidth PCT_SCALE 模式） */
const PCT_SCALE = 100

/** 进度 fill 宽度（0-100 clamp，total<=0 防除零） */
function progressWidth(meta: WidgetMeta | undefined): string {
  const p = meta?.progress
  if (!p || p.total <= 0) return '0%'
  return `${Math.min(PCT_SCALE, Math.max(0, (p.current / p.total) * PCT_SCALE))}%`
}
</script>

<template>
  <!-- 外层 band：px-5 对齐 composer-band 侧距；内层 grid 才是卡片容器（宽度对齐 Composer） -->
  <div v-if="entries.length > 0" data-testid="widget-area" class="flex-shrink-0 px-5 py-2">
    <div
      data-testid="widget-area-grid"
      class="content-col flex flex-wrap items-stretch gap-2.5"
    >
      <!-- 卡壳：head(surface-2 浮起) + body(bg-input 凹陷) 两级 bg 层次，无 border（v6 裁决） -->
      <div
        v-for="w in entries"
        :key="w.viewId"
        data-testid="widget-card"
        :data-collapsed="collapsed.has(w.viewId)"
        class="flex min-w-0 flex-col overflow-hidden rounded-md bg-bg-input"
        :class="collapsed.has(w.viewId) ? 'flex-none self-start' : 'flex-1 basis-60 self-stretch'"
      >
        <!-- 唯一 head（meta 驱动）：状态点 + 标题 + 进度计数/mini bar + 折叠 chevron。
             点击整行切换折叠；hover 亮一档提示可点。 -->
        <div
          data-testid="widget-card-header"
          class="flex h-6 cursor-pointer select-none items-center gap-2 bg-surface-2 px-3 text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
          :title="w.entry.meta?.title ?? w.viewId"
          @click="toggleCollapsed(w.viewId)"
        >
          <span
            data-testid="widget-head-status-dot"
            class="size-[7px] shrink-0 rounded-full"
            :class="statusDotClass(w.entry.meta?.status)"
          />
          <span class="min-w-0 truncate font-mono text-[11px] font-medium">
            {{ w.entry.meta?.title ?? w.viewId }}
          </span>
          <template v-if="w.entry.meta?.progress">
            <span class="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-neutral-dim">
              {{ progressLabel(w.entry.meta) }}
            </span>
            <span class="h-[3px] w-10 shrink-0 overflow-hidden rounded-full bg-surface-hover">
              <span
                data-testid="widget-head-progress-fill"
                class="block h-full rounded-full transition-[width] duration-300"
                :class="progressFillClass(w.entry.meta)"
                :style="{ width: progressWidth(w.entry.meta) }"
              />
            </span>
          </template>
          <svg
            class="size-3 shrink-0 text-neutral-dim transition-transform"
            :class="[collapsed.has(w.viewId) ? '' : 'rotate-90', w.entry.meta?.progress ? 'ml-1.5' : 'ml-auto']"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </div>
        <!-- 卡体：guiTree 逐项交渲染协议。select-text 恢复内容可选中复制（全局
             user-select:none）；max-h 钳制防长列表 widget 撑高面板挤出 composer；
             index key 的前提是原语均 props-only 无内部状态，原语引入本地状态时需改稳定 key；
             v-show 保折叠切换不重挂原语树 -->
        <div
          v-show="!collapsed.has(w.viewId)"
          data-testid="widget-card-body"
          class="flex max-h-64 min-h-0 select-text flex-col gap-1.5 overflow-y-auto p-3"
        >
          <GuiComponentRenderer
            v-for="(component, i) in w.entry.guiTree"
            :key="i"
            :component="component"
          />
        </div>
      </div>
    </div>
  </div>
</template>
