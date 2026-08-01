<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { searchCommands, type SearchCommand } from '../../mock/sessions'
import { closeSearch } from '../../composables/useStore'

/**
 * §4.6 SearchModal · ⌘K 手写浮层（非 reka Dialog）。
 * z-modal(1000) + bg-black/80 backdrop-blur 遮罩，居中 sm-dialog（max 620px，bg-surface，radius-lg，shadow-2）。
 * v6 去除 AI slop：分组 header 去 uppercase tracking；高亮去彩色改 font-semibold；选中态走 §3.2 列表项型（bg-surface + accent）。
 * ESC 关闭在 App.vue 全局 keydown 已处理（handleEscape），本组件仅自管理 focus 与上下箭头导航。
 */

const query = ref('')
const selIdx = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)

/** query 非空时的 loading 态（spec §2 LOADING_DELAY_MS=200：开扫 200ms 后才显，防连续输入闪 spinner）*/
const loading = ref(false)
let loadingTimer: ReturnType<typeof setTimeout> | null = null
/** mock 搜索时长：加载态可见一段后自动完成（真实实现由搜索 RPC resolve 时清除）*/
const SEARCH_DURATION_MS = 500
let doneTimer: ReturnType<typeof setTimeout> | null = null
watch(query, (q) => {
  if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null }
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null }
  if (!q.trim()) {
    loading.value = false
    return
  }
  // 200ms 后才显 loading（快速连续输入不闪 spinner）；随后 mock 搜索完成 → 隐藏
  loadingTimer = setTimeout(() => {
    loading.value = true
    loadingTimer = null
  }, 200)
  doneTimer = setTimeout(() => {
    loading.value = false
    doneTimer = null
  }, 200 + SEARCH_DURATION_MS)
})
onUnmounted(() => {
  if (loadingTimer) clearTimeout(loadingTimer)
  if (doneTimer) clearTimeout(doneTimer)
})

/** 按 query 过滤命令（匹配 name / desc）*/
function matchCmd(cmd: SearchCommand, q: string): boolean {
  if (!q) return true
  return cmd.name.toLowerCase().includes(q.toLowerCase())
    || cmd.desc.toLowerCase().includes(q.toLowerCase())
}

/** 过滤后的命令（query 为空时返回全量）*/
const filtered = computed<SearchCommand[]>(() => {
  const q = query.value.trim()
  if (!q) return searchCommands
  return searchCommands.filter((cmd) => matchCmd(cmd, q))
})

/** 按 group 字段聚合（保持 mock 顺序，去重 group key）*/
const groups = computed<{ name: string; items: SearchCommand[] }[]>(() => {
  const order: string[] = []
  const map = new Map<string, SearchCommand[]>()
  for (const cmd of filtered.value) {
    if (!map.has(cmd.group)) { map.set(cmd.group, []); order.push(cmd.group) }
    map.get(cmd.group)!.push(cmd)
  }
  return order.map((name) => ({ name, items: map.get(name)! }))
})

/** 跨分组扁平项（带全局 idx，供键盘导航）*/
const flatItems = computed<{ cmd: SearchCommand; idx: number }[]>(() => {
  let base = 0
  return groups.value.flatMap((g) => g.items.map((cmd) => ({ cmd, idx: base++ })))
})

const total = computed(() => flatItems.value.length)

/** 过滤结果变化时重置选中 idx，避免越界 */
watch(total, () => {
  if (selIdx.value >= total.value) selIdx.value = 0
})

/** 命中高亮：把命中 query 的文字用 <span class="sm-hit"> 包裹（返回 HTML 片段）*/
function highlight(text: string): string {
  const q = query.value.trim()
  if (!q) return escapeHtml(text)
  const escQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escaped = escapeHtml(text)
  // 大小写不敏感替换，保留原大小写
  return escaped.replace(new RegExp(`(${escapeRegexHtml(escQ)})`, 'gi'), '<span class="sm-hit">$1</span>')
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
// escapeHtml 之后再做正则匹配，需对 q 的 HTML 特殊字符也转义
function escapeRegexHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function onKeydown(e: KeyboardEvent) {
  if (total.value === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selIdx.value = (selIdx.value + 1) % total.value
    scrollToSel()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selIdx.value = (selIdx.value - 1 + total.value) % total.value
    scrollToSel()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    confirmSel()
  }
}

function scrollToSel() {
  nextTick(() => {
    const el = document.querySelector(`[data-sm-idx="${selIdx.value}"]`) as HTMLElement | null
    if (el && 'scrollIntoViewIfNeeded' in el) {
      ;(el as Element & { scrollIntoViewIfNeeded: (c?: boolean) => void }).scrollIntoViewIfNeeded(false)
    } else {
      el?.scrollIntoView({ block: 'nearest' })
    }
  })
}

function confirmSel() {
  const cur = flatItems.value[selIdx.value]
  if (!cur) return
  // demo：仅关闭（真实跳转编排不在此实现）
  closeSearch()
}

function onBackdropClick() {
  closeSearch()
}

onMounted(() => {
  nextTick(() => inputRef.value?.focus())
})
onUnmounted(() => {
  query.value = ''
  selIdx.value = 0
})

type IconKind = 'terminal' | 'file' | 'symbol' | 'session' | 'command'
function iconKind(cmd: SearchCommand): IconKind {
  if (cmd.icon === 'terminal' || cmd.icon === 'command') return 'terminal'
  if (cmd.icon === 'file') return 'file'
  if (cmd.icon === 'symbol') return 'symbol'
  if (cmd.icon === 'session') return 'session'
  return 'file'
}
</script>

<template>
  <div class="sm-overlay" @click.self="onBackdropClick">
    <div class="sm-dialog" role="dialog" aria-modal="true" aria-label="搜索命令、文件、符号、会话" tabindex="-1">
      <!-- 输入区：去 border-b 靠 padding 分层 -->
      <div class="sm-input">
        <svg class="sm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref="inputRef"
          v-model="query"
          class="sm-field"
          type="text"
          placeholder="搜索命令、文件、符号、会话…"
          @keydown="onKeydown"
        />
        <kbd class="sm-kbd">esc</kbd>
      </div>

      <!-- 结果区：loading（200ms 后显，居中 spinner 14px accent + 正在搜索…）/ 分组 / 空态 -->
      <div v-if="loading" class="sm-loading">
        <svg class="sm-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12a9 9 0 1 1-6.2-8.5" />
        </svg>
        <span>正在搜索…</span>
      </div>
      <div v-else-if="total > 0" class="sm-results">
        <div v-for="g in groups" :key="g.name" class="sm-group">
          <div class="sm-group-hd">
            <span>{{ g.name }}</span>
            <span class="sm-gcount">{{ g.items.length }}</span>
          </div>
          <button
            v-for="entry in g.items.map(cmd => ({ cmd, idx: flatItems.findIndex(f => f.cmd === cmd) }))"
            :key="entry.cmd.name"
            :data-sm-idx="entry.idx"
            class="sm-item"
            :class="{ sel: entry.idx === selIdx }"
            @click="selIdx = entry.idx; confirmSel()"
            @mouseenter="selIdx = entry.idx"
          >
            <!-- terminal icon (default for 命令类) -->
            <svg v-if="iconKind(entry.cmd) === 'terminal'" class="sm-i-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <!-- file icon -->
            <svg v-else-if="iconKind(entry.cmd) === 'file'" class="sm-i-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <!-- symbol icon -->
            <svg v-else-if="iconKind(entry.cmd) === 'symbol'" class="sm-i-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            <!-- session icon -->
            <svg v-else class="sm-i-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>

            <span class="sm-i-body">
              <span class="sm-i-title" v-html="highlight(entry.cmd.name)"></span>
              <span class="sm-i-sub" v-html="highlight(entry.cmd.desc)"></span>
            </span>
            <!-- default 态（无 query）：尾部 12px clock，表最近/历史项 -->
            <svg
              v-if="!query.trim()"
              class="sm-i-clock"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 空结果（loading 时不显空态）-->
      <div v-else class="sm-empty">
        <svg class="sm-e-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <p v-if="!query.trim()" class="sm-e-main">开始搜索命令、文件或会话</p>
        <template v-else>
          <p class="sm-e-main">未找到「<span class="sm-q">{{ query.trim() }}</span>」相关结果</p>
          <p class="sm-e-sub">试试更换关键词，或搜索命令 / 文件 / 符号 / 会话</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sm-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 10vh 16px 16px;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(4px);
}
.sm-dialog {
  position: relative;
  width: 100%;
  max-width: 620px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}

/* 输入区 */
.sm-input {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}
.sm-ico {
  width: 18px;
  height: 18px;
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.sm-field {
  flex: 1;
  min-width: 0;
  font-size: var(--text-md);
  line-height: 1.4;
  color: var(--neutral-fg);
}
.sm-field::placeholder {
  color: var(--neutral-dim);
}
.sm-kbd {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  padding: 2px 6px;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
}

/* 结果区 */
.sm-results {
  max-height: 380px;
  overflow-y: auto;
  padding: 4px 0 6px;
}
.sm-group {
  padding: 2px 0;
}
/* v6 分组 header：去 uppercase / tracking，普通大小写 11px */
.sm-group-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px 2px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.sm-gcount {
  color: var(--neutral-dim);
  font-size: var(--text-2xs);
}

.sm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 16px;
  text-align: left; /* 覆盖 button UA 默认的 text-align:center */
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.sm-item:hover {
  background: var(--surface-hover);
}
.sm-item:hover .sm-i-ico {
  color: var(--neutral-fg); /* hover icon 提亮一档（dim→fg），增强 hover 反馈 */
}
.sm-item:hover .sm-i-sub {
  color: var(--neutral-mid); /* hover 副标题提亮（dim→mid） */
}
/* §3.2 列表项型选中：bg-surface + accent 文字/icon（与 hover 实色块区分）*/
.sm-item.sel {
  background: var(--surface);
}
.sm-item.sel .sm-i-title {
  color: var(--accent);
}
.sm-i-ico {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--neutral-dim);
}
.sm-item.sel .sm-i-ico {
  color: var(--accent);
}
/* default 态尾部 clock（13px，最近/历史项标记）*/
.sm-i-clock {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--neutral-dim);
}
.sm-i-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sm-i-title {
  font-size: var(--text-md);
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-i-sub {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* loading 态（spec §2：结果区居中，spinner 14px accent + 文案）*/
.sm-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  font-size: var(--text-sm);
  color: var(--neutral-dim);
}

/* loading spinner */
.sm-spinner {
  width: 14px;
  height: 14px;
  color: var(--accent);
  animation: sm-spin 1s linear infinite;
}
@keyframes sm-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .sm-spinner { animation: none; }
}

/* 空态 */
.sm-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 32px;
  text-align: left;
}
.sm-e-ico {
  width: 28px;
  height: 28px;
  color: var(--neutral-dim);
}
.sm-e-main {
  font-size: var(--text-md);
  color: var(--neutral-fg);
}
.sm-q {
  color: var(--accent);
  font-family: var(--font-mono);
}
.sm-e-sub {
  font-size: var(--text-sm);
  color: var(--neutral-dim);
}
</style>

<!--
  全局（非 scoped）样式块。
  .sm-hit 由 v-html 注入到 .sm-i-title / .sm-i-sub 内，
  Vue scoped 不给 v-html 后代打 data-v-xxx 标记，匹配不到，故放此全局块。
  只加粗、不染蓝：颜色继承父元素（.sm-i-title / 选中态 .sm-item.sel .sm-i-title）。
-->
<style>
.sm-hit {
  font-weight: 600;
}
</style>
