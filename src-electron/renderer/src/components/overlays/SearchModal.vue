<template>
  <!--
    容器组件 · Search Modal（overlays/spec.md · L0 Overlay 级）。
    ⌘K / Ctrl+K 唤起的全局搜索浮层：模糊遮罩 + 居中浮层，浮于所有 Region 之上。
    范围：全局·跨项目（命令/文件/符号/会话四类分组）。

    当前：本地 mock 数据 + 子串过滤 + 匹配高亮 + recents + ↑↓/Enter 键盘导航。
    DEFERRED：真实数据源（命令注册表 / 项目索引 LSP / 会话库）、scope 过滤条与 Tab 切类、
              确认后的真实跳转（emit('select') 已透出，父组件暂未接入）、recents 持久化。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      class="gap-0 overflow-hidden p-0 sm:max-w-[620px] sm:rounded-lg"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>搜索</DialogTitle>
        <DialogDescription>搜索命令、文件、符号与会话</DialogDescription>
      </DialogHeader>

      <!-- 输入区：唤起即 focus（Dialog 默认聚焦首个可聚焦元素） -->
      <div class="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Search class="size-[18px] flex-shrink-0 text-subtle" />
        <Input
          v-model="query"
          class="h-8 border-0 bg-transparent px-0 text-[14px] shadow-none focus-visible:ring-0"
          placeholder="搜索命令、文件、符号、会话…"
          @keydown="onKeydown"
        />
      </div>

      <!-- 结果区 -->
      <div ref="resultsRef" class="max-h-[380px] overflow-y-auto py-1.5">
        <!-- 有结果：分组渲染（空查询=最近+建议命令；有查询=按命中类型分组） -->
        <template v-if="total > 0">
          <div v-for="s in sections" :key="s.label" class="py-1">
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

        <!-- 空结果 -->
        <div v-else class="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <Search class="size-7 text-subtle" />
          <p class="text-[14px] text-fg">
            未找到「{{ query.trim() }}」的相关结果
          </p>
          <p class="text-[12px] text-subtle">换个关键词试试</p>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, type Component } from 'vue'
import { Search, Terminal, FileText, Code, MessageSquare, Clock } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type SearchType = 'command' | 'file' | 'symbol' | 'session'
interface MockItem { type: SearchType; title: string; sub: string }
interface IdxItem extends MockItem { idx: number }

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  'select': [item: MockItem]
}>()

/** 四类 mock 数据（移植自 v3-demo/overlays/draft-search-modal.html DATA） */
const MOCK: Record<SearchType, MockItem[]> = {
  command: [
    { type: 'command', title: '新建任务', sub: '创建一个新会话 · ⌘N' },
    { type: 'command', title: '切换分支', sub: 'git checkout' },
    { type: 'command', title: '收起侧栏', sub: 'toggle sidebar · ⌘B' },
    { type: 'command', title: '打开概览', sub: 'Mission Control' },
    { type: 'command', title: '提交并推送', sub: 'git commit && push' },
  ],
  file: [
    { type: 'file', title: 'auth/session.ts', sub: 'refactor-arch/src/auth' },
    { type: 'file', title: 'auth/token.ts', sub: 'refactor-arch/src/auth' },
    { type: 'file', title: 'use-auth.ts', sub: 'refactor-arch/src/composables' },
    { type: 'file', title: 'session-store.ts', sub: 'refactor-arch/src/stores' },
    { type: 'file', title: 'Sidebar.vue', sub: 'refactor-arch/src/components/sidebar' },
  ],
  symbol: [
    { type: 'symbol', title: 'authenticate()', sub: 'auth/session.ts:42' },
    { type: 'symbol', title: 'AuthToken', sub: 'auth/token.ts:8' },
    { type: 'symbol', title: 'SessionStore', sub: 'session-store.ts:12' },
    { type: 'symbol', title: 'useAuth()', sub: 'use-auth.ts:4' },
  ],
  session: [
    { type: 'session', title: 'Auth 重构 · token 轮转', sub: 'refactor-arch · main · 14:32' },
    { type: 'session', title: '搜索浮层设计', sub: 'refactor-arch · feat-search' },
    { type: 'session', title: 'Workspace 双 Panel', sub: 'agent-skeleton · main' },
    { type: 'session', title: 'git 工作流打磨', sub: 'feat-gitflow · dev' },
  ],
}
const LABEL: Record<SearchType, string> = { command: '命令', file: '文件', symbol: '符号', session: '会话' }
const TYPES: SearchType[] = ['command', 'file', 'symbol', 'session']
const ICON: Record<SearchType, Component> = { command: Terminal, file: FileText, symbol: Code, session: MessageSquare }

/** 空查询时的「最近」与「建议命令」（recents 持久化 DEFERRED，先用静态样本） */
const RECENTS: MockItem[] = [
  { type: 'file', title: 'auth/session.ts', sub: 'refactor-arch/src/auth' },
  { type: 'session', title: 'Auth 重构 · token 轮转', sub: 'refactor-arch · main' },
  { type: 'command', title: '切换分支', sub: 'git checkout' },
]
const SUGGESTED_COUNT = 3
const SUGGESTED: MockItem[] = MOCK.command.slice(0, SUGGESTED_COUNT)

const query = ref('')
const selIdx = ref(0)
const resultsRef = ref<HTMLElement | null>(null)

/** 当前可见分组（每项带跨组扁平 idx，供键盘导航） */
const sections = computed<{ label: string; items: IdxItem[] }[]>(() => {
  const q = query.value.trim()
  const raw: { label: string; items: MockItem[] }[] = !q
    ? [
      { label: '最近', items: RECENTS },
      { label: '建议命令', items: SUGGESTED },
    ]
    : TYPES.map((t) => ({ label: LABEL[t], items: MOCK[t].filter((it) => match(it, q.toLowerCase())) }))
      .filter((s) => s.items.length)
  let base = 0
  return raw.map((s) => ({ label: s.label, items: s.items.map((it) => ({ ...it, idx: base++ })) }))
})
const flatItems = computed<IdxItem[]>(() => sections.value.flatMap((s) => s.items))
const total = computed(() => flatItems.value.length)

function match(it: MockItem, ql: string): boolean {
  return it.title.toLowerCase().includes(ql) || it.sub.toLowerCase().includes(ql)
}

/** 把文本按查询拆成命中/未命中文本段，供模板渲染 <mark>（Vue 自动转义，无 XSS） */
function segments(text: string, q: string): { text: string; hit: boolean }[] {
  if (!q) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  const out: { text: string; hit: boolean }[] = []
  let i = 0
  while (i < text.length) {
    const at = lower.indexOf(ql, i)
    if (at < 0) { out.push({ text: text.slice(i), hit: false }); break }
    if (at > i) out.push({ text: text.slice(i, at), hit: false })
    out.push({ text: text.slice(at, at + ql.length), hit: true })
    i = at + ql.length
  }
  return out
}

function onKeydown(e: KeyboardEvent) {
  if (total.value === 0) return
  if (e.key === 'ArrowDown') { e.preventDefault(); selIdx.value = (selIdx.value + 1) % total.value; scrollToSel() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selIdx.value = (selIdx.value - 1 + total.value) % total.value; scrollToSel() }
  else if (e.key === 'Enter') { e.preventDefault(); confirmSel() }
}

function scrollToSel() {
  nextTick(() => {
    const el = resultsRef.value?.querySelector(`[data-idx="${selIdx.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function confirmSel() {
  const cur = flatItems.value[selIdx.value]
  if (!cur) return
  const { type, title, sub } = cur
  emit('select', { type, title, sub })
  emit('update:open', false)
}

/** 查询变化重置选中；关闭清空查询（恢复 recents 空查询态） */
watch(query, () => { selIdx.value = 0 })
watch(() => props.open, (isOpen) => { if (!isOpen) query.value = '' })
</script>
