<template>
  <!--
    容器组件 · trace-view（session-trace §3.1 终态：占满 main 区的全量 entry 台账）。
    结构：TraceToolbar（状态行 + chips + 搜索 + context toggle）+ 行列表 + context 分界行。
    加载/空态/失败路径（§3.1）：loading 转圈 / empty（未落盘）文案 / error 重试 / 过滤空态。
    虚拟滚动（D9）：>500 item 启用 virtua Virtualizer（MessageStream 同族设施），
    ≤500 直接 v-for（短列表免测量开销）。两路径共用 TraceRowItem。
    数据不重建（A42）：rows 从 store 分区派生（mapSessionTraceRows 纯函数重算），
    视图切换/组件卸载不碰 store 分区，切回状态保留。
  -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- 加载态 -->
    <div
      v-if="partition.status === 'loading'"
      class="flex flex-1 flex-col items-center justify-center gap-2 text-center"
      data-testid="trace-loading"
    >
      <Loader2 class="size-5 animate-spin text-neutral-dim opacity-60" />
      <p class="text-[12px] text-neutral-dim">{{ t('panel.trace.loading') }}</p>
    </div>
    <!-- 失败路径：加载失败（§3.1 失败路径，文案 t() 占位收口 trace-i18n） -->
    <div
      v-else-if="partition.status === 'error'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="trace-error"
    >
      <AlertCircle class="size-6 text-danger opacity-60" />
      <p class="text-[12px] text-neutral-fg">{{ t('panel.trace.loadFailed') }}</p>
      <p class="max-w-[420px] text-[11px] leading-relaxed text-neutral-dim">{{ t('panel.trace.loadFailedHint') }}</p>
      <p class="font-mono text-[10px] text-neutral-faint">{{ partition.errorCode }}</p>
      <Button variant="ghost" size="sm" data-testid="trace-retry" @click="retry(props.sessionId)">
        <RotateCcw class="mr-1 size-3" />
        {{ t('panel.trace.retry') }}
      </Button>
    </div>
    <!-- 失败路径：session 未落盘（pi 延迟写入窗口，规则 6——不创建文件，落盘后自动加载） -->
    <div
      v-else-if="partition.source === 'empty'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="trace-empty-not-persisted"
    >
      <Hourglass class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[12px] text-neutral-dim">{{ t('panel.trace.emptyNotPersisted') }}</p>
      <Button variant="ghost" size="sm" data-testid="trace-retry" @click="retry(props.sessionId)">
        <RotateCcw class="mr-1 size-3" />
        {{ t('panel.trace.retry') }}
      </Button>
    </div>
    <!-- 台账主体 -->
    <template v-else>
      <!-- RPC 降级 banner（§3.1 失败路径：pi RPC 失败/非活跃 session 走文件直读，无实时增量）。
           source='file' 涵盖两种情形，语义统一：凡文件路径均无实时更新（增量腿只随 RPC 建立）。 -->
      <div
        v-if="partition.source === 'file'"
        class="flex flex-shrink-0 items-center gap-1.5 border-b border-hairline px-3.5 py-1 text-[11px] text-neutral-dim"
        data-testid="trace-degraded-banner"
      >
        <FileWarning class="size-3 shrink-0 opacity-70" />
        <span>{{ t('panel.trace.degradedFileSource') }}</span>
      </div>
      <TraceToolbar
        :rows="rows"
        :context-only="partition.contextOnly"
        :active-groups="partition.activeGroups"
        :search-text="partition.searchText"
        @toggle-group="onToggleGroup"
        @toggle-context="onToggleContext"
        @update:search-text="(v) => setFilter(props.sessionId, { searchText: v })"
      />
      <div
        ref="scrollEl"
        class="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-1 [overflow-anchor:none]"
        data-testid="trace-list"
      >
        <!-- 空态：过滤后无匹配 -->
        <div
          v-if="items.length === 0"
          class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="trace-empty"
        >
          <ListTree class="size-6 text-neutral-dim opacity-40" />
          <p class="text-[12px] text-neutral-dim">
            {{ rows.length === 0 ? t('panel.trace.emptyNoRows') : t('panel.trace.emptyFiltered') }}
          </p>
        </div>
        <!-- >500 启用虚拟滚动（D9）。slot 内仅单一 TraceListItem vnode + 稳定 key
             （virtua 从 slot vnode 取 key，注释/多 vnode 会破坏 stable-key）。 -->
        <Virtualizer
          v-else-if="virtualized"
          ref="vlistRef"
          :data="items"
          :item-size="ESTIMATED_ROW_HEIGHT"
          :key="props.sessionId"
        >
          <template #default="{ item }">
            <TraceListItem
              :key="item.kind === 'row' ? item.row.key : 'ctx-divider'"
              :item="item"
              :selected="item.kind === 'row' && item.row.key === partition.selectedKey"
              @select="onSelectRow"
            />
          </template>
        </Virtualizer>
        <!-- ≤500 直接渲染（短列表免 virtua 测量开销） -->
        <template v-else>
          <TraceListItem
            v-for="item in items"
            :key="item.kind === 'row' ? item.row.key : 'ctx-divider'"
            :item="item"
            :selected="item.kind === 'row' && item.row.key === partition.selectedKey"
            @select="onSelectRow"
          />
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Trace 视图主体。rows 派生链：store 分区（header/entries/malformed/sessionEnd/leafId）
 * → mergeTraceLines → core mapSessionTraceRows（12 kind + context 边界 + 影子化）。
 * 过滤链：core filterTraceRows（contextOnly + chips）+ 文本搜索（UI 层，demo 语义不匹配隐藏）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Virtualizer } from 'virtua/vue'
import type { VirtualizerHandle } from 'virtua/vue'
import { AlertCircle, FileWarning, Hourglass, ListTree, Loader2, RotateCcw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  filterTraceRows,
} from '@xyz-agent/core/domain/session-trace'
import type { TraceKindGroup, TraceRow } from '@xyz-agent/core/domain/session-trace'
import { useTraceRows } from '@/composables/features/trace/useTraceRows'
import {
  ensureTraceLoaded,
  retryTraceLoad,
  selectTraceEntry,
  setTraceFilter,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'
import TraceToolbar from './TraceToolbar.vue'
import TraceListItem from './TraceListItem.vue'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const { partition } = useSessionTrace()
const retry = retryTraceLoad
const setFilter = setTraceFilter

const scrollEl = ref<HTMLElement | null>(null)
const vlistRef = ref<VirtualizerHandle | null>(null)

/** 虚拟滚动启用阈值（D9：>500 entry）与行高估计。 */
const VIRTUAL_SCROLL_THRESHOLD = 500
const ESTIMATED_ROW_HEIGHT = 28

/** 列表项：台账行或 context 分界行（demo .tr-divider）。 */
type TraceListItemSpec = { kind: 'row'; row: TraceRow } | { kind: 'divider' }

/** store 分区 → core TraceRow[]（useTraceRows 共享派生，TraceInspector 同源）。 */
const rows = useTraceRows()

/** 行可搜索文本（kind + headline + meta 值拼接，demo data-text 同源语义）。 */
function searchableText(row: TraceRow): string {
  const metaText = Object.values(row.meta)
    .filter((v) => v !== undefined)
    .join(' ')
  return `${row.kind} ${row.headline} ${metaText}`.toLowerCase()
}

/** 过滤管道：core filterTraceRows（contextOnly + chips）+ 文本搜索（UI 层）。 */
const filteredRows = computed<TraceRow[]>(() => {
  const p = partition.value
  const byState = filterTraceRows(rows.value, {
    contextOnly: p.contextOnly,
    activeGroups: p.activeGroups,
  })
  const q = p.searchText.trim().toLowerCase()
  if (!q) return byState
  return byState.filter((row) => searchableText(row).includes(q))
})

/** 渲染项：过滤后行 + context 分界行（最后一个 COMPACTED 之后；contextOnly 态隐藏——demo 行为）。 */
const items = computed<TraceListItemSpec[]>(() => {
  const list: TraceListItemSpec[] = filteredRows.value.map((row) => ({ kind: 'row', row }))
  if (partition.value.contextOnly) return list
  let lastCompactionIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item.kind === 'row' && item.row.kind === 'COMPACTED') {
      lastCompactionIdx = i
      break
    }
  }
  if (lastCompactionIdx >= 0 && lastCompactionIdx < list.length - 1) {
    list.splice(lastCompactionIdx + 1, 0, { kind: 'divider' })
  }
  return list
})

const virtualized = computed(() => items.value.length > VIRTUAL_SCROLL_THRESHOLD)

function onToggleGroup(group: 'all' | TraceKindGroup): void {
  const current = partition.value.activeGroups
  let next: TraceKindGroup[]
  if (group === 'all') {
    next = [] // 全部 = 无 chips 激活（白名单语义）
  } else if (current.includes(group)) {
    next = current.filter((g) => g !== group)
  } else {
    next = [...current, group]
  }
  setFilter(props.sessionId, { activeGroups: next })
}

function onToggleContext(): void {
  setFilter(props.sessionId, { contextOnly: !partition.value.contextOnly })
}

function onSelectRow(row: TraceRow): void {
  selectTraceEntry(props.sessionId, row.key)
}

onMounted(() => {
  ensureTraceLoaded(props.sessionId)
})
// session 切换（split/换绑场景）：确保新分区加载（幂等）
watch(
  () => props.sessionId,
  (sid) => ensureTraceLoaded(sid),
)
</script>
