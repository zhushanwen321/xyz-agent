<template>
  <!--
    容器组件 · Search Modal（overlays/spec.md · L0 Overlay 级）。
    ⌘K / Ctrl+K 唤起的全局搜索浮层：模糊遮罩 + 居中浮层，浮于所有 Region 之上。
    范围：全局·跨项目（命令/文件/符号/会话四类分组）。

    Wave3 重构：编排下沉至 composable（useSearch 编排聚合 / useSearchJump 跳转 / useRecents 持久化）。
    本组件只承担 UI：输入 → debounce 120ms → useSearch.query → 分组渲染 / ↑↓导航 → confirm。
    DEFERRED：⌘K toggle（Wave4 #10.1，现状监听在 Sidebar，本组件只处理 Esc/点遮罩关闭）。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      class="gap-0 overflow-hidden p-0 sm:max-w-[620px] sm:rounded-lg"
    >
      <div data-testid="search-modal-root">
      <DialogHeader class="sr-only">
        <DialogTitle>搜索</DialogTitle>
        <DialogDescription>搜索命令、文件、符号与会话</DialogDescription>
      </DialogHeader>

      <!-- 输入区：唤起即 focus（Dialog 默认聚焦首个可聚焦元素） -->
      <div class="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Search class="size-[18px] flex-shrink-0 text-subtle" />
        <Input
          v-model="query"
          data-testid="search-input"
          class="h-8 border-0 bg-transparent px-0 text-[14px] shadow-none focus-visible:ring-0"
          placeholder="搜索命令、文件、符号、会话…"
          @keydown="onKeydown"
        />
      </div>

      <!-- 结果区 -->
      <div ref="resultsRef" class="max-h-[380px] overflow-y-auto py-1.5">
        <!-- loading 态（AC-8.1 防闪烁：扫描 >200ms 才显，避免快速查询闪烁） -->
        <div
          v-if="loading"
          data-testid="search-loading"
          class="flex items-center justify-center gap-2 px-6 py-6 text-[12px] text-subtle"
        >
          <Loader2 class="size-3.5 animate-spin" />
          <span>搜索中…</span>
        </div>

        <!-- 有结果：分组渲染（空查询=最近+建议命令；有查询=按命中类型分组） -->
        <template v-else-if="total > 0">
          <div
            v-for="s in sections"
            :key="s.label"
            :data-testid="`search-section-${s.label}`"
            class="py-1"
          >
            <div
              class="flex items-center gap-2 px-4 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-subtle"
            >
              <span>{{ s.label }}</span>
              <span class="text-subtle">{{ s.items.length }}</span>
            </div>
            <div
              v-for="it in s.items"
              :key="it.idx"
              role="option"
              :aria-selected="it.idx === selIdx"
              :data-idx="it.idx"
              :data-testid="`search-item-${it.idx}`"
              class="flex w-full cursor-pointer items-center gap-3 px-4 py-2 transition-colors"
              :class="it.idx === selIdx ? 'bg-surface-hover' : 'hover:bg-surface-hover'"
              @mouseenter="selIdx = it.idx"
              @click="confirmSel"
            >
              <component
                :is="ICON[it.type]"
                class="size-4 flex-shrink-0"
                :class="it.idx === selIdx ? 'text-accent' : 'text-subtle'"
              />
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="truncate text-[13.5px] text-fg">
                  <template v-for="(seg, i) in segments(it.title, query.trim())" :key="i">
                    <mark v-if="seg.hit" class="bg-transparent font-semibold text-accent">{{ seg.text }}</mark>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
                <span class="truncate font-mono text-[11px] text-subtle">
                  <template v-for="(seg, i) in segments(it.sub, query.trim())" :key="i">
                    <mark v-if="seg.hit" class="bg-transparent font-semibold text-accent">{{ seg.text }}</mark>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
              </span>
              <Clock
                v-if="!query.trim()"
                class="size-[13px] flex-shrink-0 text-subtle"
              />
            </div>
          </div>
        </template>

        <!-- 空结果：区分 recents 库空（首用）vs 查询无结果（AC-7.13） -->
        <div
          v-else
          data-testid="search-empty"
          class="flex flex-col items-center gap-2 px-6 py-10 text-center"
        >
          <Search class="size-7 text-subtle" />
          <!-- recents 库空（空查询 + 无最近/建议）：首用引导 -->
          <p v-if="!query.trim()" class="text-[14px] text-fg">输入关键词开始搜索</p>
          <!-- 查询无结果（非空 query 无命中）：带引号提示 -->
          <template v-else>
            <p class="text-[14px] text-fg">
              未找到「{{ query.trim() }}」的相关结果
            </p>
            <p class="text-[12px] text-subtle">换个关键词试试</p>
          </template>
        </div>
      </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted, type Component } from 'vue'
import { Search, Terminal, FileText, Code, MessageSquare, Clock, Loader2 } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { type SearchItem } from '@/api'
import { useSearch } from '@/composables/features/useSearch'
import { useSearchJump } from '@/composables/features/useSearchJump'
import { useRecents } from '@/composables/features/useRecents'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { segments } from '@/lib/match-engine'
import { useToast } from '@/composables/useToast'

type SearchType = SearchItem['type']
interface IdxItem extends SearchItem { idx: number }

/** AC-7.15 查询防抖延迟（D-020，避免每次按键触发全量拉取） */
const DEBOUNCE_MS = 120
/** AC-8.1 loading 防闪烁延迟（扫描超过此时长才显示加载条，避免快速查询闪烁） */
const LOADING_DELAY_MS = 200

const props = defineProps<{ open: boolean; activeSessionId?: string | null }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const ICON: Record<SearchType, Component> = { command: Terminal, file: FileText, symbol: Code, session: MessageSquare }

/**
 * #9 Tab 切类：activeType ref（null=全部）。Tab/Shift+Tab 循环切换四类 + 全部。
 * AH-S3：空查询（recents 态）下 Tab 切类仍生效——「最近」分组恒显（recents 跨类型），其余按 activeType 过滤。
 */
const activeType = ref<SearchType | null>(null)

/** section label → SearchType 映射（#9 activeType 过滤用）；非四类 label（'最近'/'建议命令'）无对应→undefined */
const labelToType: Record<string, SearchType | undefined> = {
  命令: 'command',
  文件: 'file',
  符号: 'symbol',
  会话: 'session',
}

// Wave1/2 编排接线：useSearch 编排聚合 / useSearchJump 跳转分发 / useRecents 持久化
// activeSessionId 归一为 Ref<string|null>（props 可选 undefined → 统一 null，useSearch/useSearchJump 契约）
const activeSessionIdRef = computed(() => props.activeSessionId ?? null)
const { query: runQuery } = useSearch(activeSessionIdRef)
const { confirm } = useSearchJump()
void useRecents() // 接线触发 recents 读（useSearch 内部已用 useRecents，此行保留显式接线意图）
const { error: toastError } = useToast()
// file 跳转返 drawerTab:'detail'，confirmSel 据此打开 SideDrawer detail tab（与 FileTreeRow.onSelectFile 同构）
const { open: drawerOpen } = useSideDrawer()

const query = ref('')
const selIdx = ref(0)
const resultsRef = ref<HTMLElement | null>(null)

/** useSearch.query 返回的分组（四类 Section[]，符号占位恒在） */
const remoteSections = ref<Awaited<ReturnType<typeof runQuery>>>([])

/** loading 态（AC-8.1 防闪烁：200ms 后才显，快速查询不闪烁） */
const loading = ref(false)
/** error 态（AC-8.5 transient：仅编排层意外异常时设置，新查询/close 时重置；单源失败由分组空态表达 AH-S2） */
const errorMsg = ref('')
let loadingTimer: ReturnType<typeof setTimeout> | undefined
/** debounce 120ms（AC-7.15，D-020） */
let debounceTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 拉取结果（编排归 useSearch.query；BC-9 loadSeq 守卫在 query 内部，此处不重复守卫 AH-C1）。
 * AC-8.1：开扫 200ms 后显 loading（防闪烁），finally 清 timer+loading。
 * T5.4 容错：query 抛错 catch（不崩，清 loading，分组维持旧值/空态）。
 */
async function loadResults(): Promise<void> {
  const q = query.value.trim()
  loadingTimer = setTimeout(() => { loading.value = true }, LOADING_DELAY_MS)
  try {
    remoteSections.value = await runQuery(q, { activeSessionId: props.activeSessionId ?? null })
  } catch (e) {
    // T5.4：编排层意外异常不崩（useSearch 内部 allSettled 已兜底单源错误，此处仅防未预期抛出）
    // 分组维持原值供用户换词重试，设 error 态让用户感知（AH-S2：意外异常才进全局 error）
    console.error('[SearchModal] loadResults 意外异常', e)
    errorMsg.value = '搜索异常，请重试'
  } finally {
    clearTimeout(loadingTimer)
    loading.value = false
  }
}

/** 当前可见分组（每项带跨组扁平 idx，供键盘导航） */
const sections = computed<{ label: string; items: IdxItem[] }[]>(() => {
  const raw = remoteSections.value
  // #9 AC-9.2：activeType 非空时只显所选类分组。
  // AH-S3：label='最近' 分组恒显（recents 是跨类型最近项列表，与 type_filtered 正交非互斥）；
  // 其他非四类 label（如'建议命令'）按 activeType 过滤（activeType 选中时它们无对应类被隐藏）。
  const filtered = activeType.value
    ? raw.filter((s) => s.label === '最近' || labelToType[s.label] === activeType.value)
    : raw
  let base = 0
  return filtered.map((s) => ({ label: s.label, items: s.items.map((it) => ({ ...it, idx: base++ })) }))
})
const flatItems = computed<IdxItem[]>(() => sections.value.flatMap((s) => s.items))
const total = computed(() => flatItems.value.length)

function onKeydown(e: KeyboardEvent) {
  // #9 AC-9.1：Tab/Shift+Tab 循环切类（先于 total 守卫，使空过滤态仍可继续切换出空类型）。
  if (e.key === 'Tab') {
    e.preventDefault()
    const types: (SearchType | null)[] = [null, 'command', 'file', 'symbol', 'session']
    const cur = types.indexOf(activeType.value)
    activeType.value = e.shiftKey
      ? types[(cur - 1 + types.length) % types.length]
      : types[(cur + 1) % types.length]
    selIdx.value = 0 // AH-B4：切类时 selIdx 重置（避免选中被过滤隐藏的项）
    return
  }
  if (total.value === 0) return
  if (e.key === 'ArrowDown') { e.preventDefault(); selIdx.value = (selIdx.value + 1) % total.value; scrollToSel() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selIdx.value = (selIdx.value - 1 + total.value) % total.value; scrollToSel() }
  else if (e.key === 'Enter') { e.preventDefault(); void confirmSel() }
}

function scrollToSel() {
  nextTick(() => {
    const el = resultsRef.value?.querySelector(`[data-idx="${selIdx.value}"]`) as HTMLElement | null
    // #10.2 AC-10.2 / BC-7：scrollIntoViewIfNeeded 避免 spec 违规（scrollIntoView 会触发 OD 预览 iframe 滚动冲突）。
    // 非标准 API（Chrome/webview 支持，happy-dom/test 环境无），用 'in' 特性检测 + 类型断言，fallback 到 scrollIntoView。
    if (el && 'scrollIntoViewIfNeeded' in el) {
      ;(el as Element & { scrollIntoViewIfNeeded: (center?: boolean) => void }).scrollIntoViewIfNeeded(false)
    } else {
      el?.scrollIntoView({ block: 'nearest' })
    }
  })
}

/** 确认选中（AC-6.7 异常恢复：confirm {ok:true} 才关浮层，{ok:false} 保持打开 + toast） */
async function confirmSel(): Promise<void> {
  const cur = flatItems.value[selIdx.value]
  if (!cur) return
  const { type, title, sub, icon } = cur
  const result = await confirm({ type, title, sub, icon }, { activeSessionId: props.activeSessionId ?? null })
  if (result.ok) {
    // file 跳转返 drawerTab:'detail'：打开 SideDrawer detail tab 让 DetailPane 挂载渲染文件内容。
    // （DetailPane 只在 activeTab==='detail' 时挂载；useSearchJump 编排层不直接调 drawer，由本组件接线）
    if (result.drawerTab) drawerOpen(result.drawerTab)
    emit('update:open', false)
  } else {
    toastError(result.error)
  }
}

/** 查询变化 → debounce 120ms → 重置选中 + 拉新结果（AC-7.15） */
watch(query, () => {
  errorMsg.value = '' // AC-8.5：新查询清除上一次 error（transient）
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    selIdx.value = 0
    void loadResults()
  }, DEBOUNCE_MS)
})
/**
 * 打开/关闭切换（immediate 处理初始 open=true 挂载场景）：
 * - open=true：加载初始结果（recent + suggested）
 * - open=false：清查询 + 重置状态 + 清定时器（AC-7.14 资源清理，MR-7.1 孤儿查询守卫）
 */
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    void loadResults()
  } else {
    query.value = ''
    selIdx.value = 0
    activeType.value = null // #9：close 重置切类（跨查询保持，但 close 时回全部）
    errorMsg.value = '' // AC-8.5：close 重置 error（transient，不持久跨查询）
    clearTimeout(debounceTimer)
    clearTimeout(loadingTimer)
    loading.value = false
  }
}, { immediate: true })

/** 组件卸载清理定时器（AC-8.4 资源清理） */
onUnmounted(() => {
  clearTimeout(debounceTimer)
  clearTimeout(loadingTimer)
})
</script>
