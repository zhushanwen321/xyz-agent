<template>
  <!--
    展示组件 · Markdown 渲染（W03）。
    shiki 代码高亮（VSCode 级）+ markdown-it 结构解析（标题/列表/表格/行内代码/链接）。

    渲染模式：renderMarkdownSegments 把 markdown 拆成 text 段（HTML，走 v-html）+ mermaid 段
    （源码，走 <MermaidRenderer> 组件）交替。mermaid 作为 template 里的正常 Vue 组件，
    无 Vue render 函数动态挂载（该模式不可靠，曾导致渲染失败）。

    代码块增强（fence 规则覆盖，markdown.ts）：语言标签 + 复制按钮（事件委托）。

    双主题（ADR-0021-B：暗为默认）：shiki defaultColor:false 产出 --shiki-dark(暗)/--shiki-light(亮)
    双套 span，由 :root(暗默认) / [data-theme="light"] 的 scoped 样式切换，走 design-tokens 体系。

    v-html：shiki + markdown-it(html:false) 的输出是 XSS 安全的——
    shiki codeToHtml 转义所有非 token 文本（只发 scoped <span>），markdown-it 不透传用户原始 HTML，
    代码源码经 base64 编码进 data 属性。故在此受控渲染点局部放开 taste-lint vue/no-v-html。仅此组件。
  -->
  <div class="md-render select-text" @click="onClick">
    <template v-for="(seg, i) in segments" :key="i">
      <!-- eslint-disable-next-line vue/no-v-html -- text 段是 shiki+markdown-it(html:false) 安全输出，仅此受控点放开。 -->
      <div v-if="seg.type === 'text'" v-html="seg.content" />
      <MermaidRenderer v-else :source="seg.content" />
    </template>
    <!-- 歧义文件选择浮层：裸 basename 多匹配时弹出（锚定到点击的 <a>，portal 到 body） -->
    <AmbiguousFilePopover
      :open="!!ambiguousState"
      :basename="ambiguousState?.basename ?? ''"
      :candidates="ambiguousCandidates"
      :anchor-el="ambiguousState?.anchorEl ?? null"
      @update:open="(v) => { if (!v) ambiguousState = null }"
      @select="onAmbiguousSelect"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Markdown 渲染器。
 * - 首次渲染需 await shiki 加载（异步），期间显示空（极短，highlighter 单例只建一次）。
 * - content 变化（流式增量）触发重新渲染；markdown-it 实例已缓存，后续渲染同步。
 * - 渲染为 segments 数组：text 段走 v-html，mermaid 段走 <MermaidRenderer> 组件（template v-for）。
 * - 代码块复制按钮/链接点击用事件委托（v-html 内不能绑 Vue 事件）→ useMarkdownInteractions。
 */
import { computed, ref, watch } from 'vue'
import { renderMarkdownSegments, type MarkdownSegment } from '@/composables/logic/markdown'
import { useMarkdownInteractions } from '@/composables/panel/useMarkdownInteractions'
import { useFileSearch } from '@/composables/features/useFileSearch'
import { useFileSearchStore } from '@/stores/fileSearch'
import { useFileTree } from '@/composables/features/useFileTree'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { collectBasenames, findByBasename } from '@/lib/file-basename'
import AmbiguousFilePopover from './AmbiguousFilePopover.vue'
import MermaidRenderer from './MermaidRenderer.vue'

const props = defineProps<{
  content: string
  /** 所属 session（文件路径打开 DetailPane 走 cwd 守门用）；命令文档等无 session 场景传 undefined */
  sessionId?: string | null
}>()

const segments = ref<MarkdownSegment[]>([])
let renderSeq = 0

/**
 * 当前 session 的本地文件 basename 集合（供 markdown 裸 basename 识别）。
 *
 * 数据源：useFileSearch.load（fileSearchStore per-session 全量递归缓存优先，否则 file.search RPC）。
 * 响应式 ref（非 store 直接派生——fileSearchStore.set 用 Map mutation 不触发 Vue 响应式，
 * 这里在 load 完成后手动赋值触发重渲染）。
 *
 * 首渲染时可能为空集（fileSearch 未加载）→ markdown 裸 basename 降级纯文本（与无 env 一致，无回归）。
 * load 完成后赋值 → watch 触发重渲染 → basename 变可点击链接。
 * sessionId 变化（切 session）→ 重新 load + 重渲染。
 */
const localFiles = ref<Set<string>>(new Set())
const { load: loadFileCandidates } = useFileSearch()
let loadedSessionId: string | null | undefined
async function refreshLocalFiles(sid: string | null | undefined): Promise<void> {
  if (!sid) {
    localFiles.value = new Set()
    return
  }
  // 缓存命中（fileSearchStore.get）走同步路径，否则 fire-and-forget RPC，完成后赋值触发重渲染
  const nodes = await loadFileCandidates(sid)
  localFiles.value = collectBasenames(nodes)
}

/** 歧义选择浮层状态（多匹配 basename 点击时弹出，见 AmbiguousFilePopover） */
const ambiguousState = ref<{ basename: string; anchorEl: HTMLElement } | null>(null)

/** 歧义浮层候选：从 fileSearchStore 缓存按 basename 反查（响应 ambiguousState + localFiles 变化） */
const ambiguousCandidates = computed(() => {
  if (!ambiguousState.value) return []
  // localFiles 是 basename Set，不含 path；需从原始 FileNode[] 反查 path
  // 复用 useFileSearch 缓存（refreshLocalFiles 已 load 过，get 命中同步返回）
  const sid = props.sessionId
  if (!sid) return []
  const { get } = useFileSearchStore()
  const nodes = get(sid)
  if (!nodes) return []
  return findByBasename(nodes, ambiguousState.value.basename)
})

const { selectFile } = useFileTree()
const drawer = useSideDrawer()

/** 歧义浮层选中 → selectFile + 打开 DetailPane + 清状态 */
function onAmbiguousSelect(path: string): void {
  selectFile(path)
  drawer.open('detail')
  ambiguousState.value = null
}

/**
 * v-html 内点击事件委托路由（代码块复制 / 文件路径 / 外链）。
 * 透传 sessionId + onAmbiguous：裸 basename 点击时，多匹配走歧义选择浮层（见 AmbiguousFilePopover）。
 * 复制反馈态由 useMarkdownInteractions 内的 useCodeblockCopy 管理（DOM-imperative，
 * 因 v-html 节点无 Vue 响应式——不复用 effects/useCopy 的 ref-based 版本）。
 */
const { onClick } = useMarkdownInteractions({
  get sessionId() { return props.sessionId },
  onAmbiguous: (basename, anchorEl) => {
    ambiguousState.value = { basename, anchorEl }
  },
})

watch(
  () => props.sessionId,
  (sid) => {
    if (sid === loadedSessionId) return
    loadedSessionId = sid
    void refreshLocalFiles(sid)
  },
  { immediate: true },
)

watch(
  () => [props.content, localFiles.value],
  async ([text]) => {
    if (!(text as string).trim()) {
      segments.value = []
      return
    }
    // 流式增量会高频触发：用序号守卫，只采纳最新一次的渲染结果（防旧渲染覆盖新内容）
    const seq = ++renderSeq
    const segs = await renderMarkdownSegments(text as string, { localFiles: localFiles.value })
    if (seq === renderSeq) {
      segments.value = segs
    }
  },
  { immediate: true },
)
</script>

<style scoped>
/* ── markdown 排版（design-tokens 语义色，不硬编码）──
   user-select:text 走 Tailwind select-text 类（template 的 .md-render div），
   覆盖 body 全局 user-select:none（style.css:165）—— 那条全局 none 是为让
   chrome/按钮区不可选，markdown 正文/代码是可读内容应允许框选。 */
.md-render :deep(h1),
.md-render :deep(h2),
.md-render :deep(h3),
.md-render :deep(h4) {
  font-weight: 600;
  line-height: 1.3;
  margin: 1em 0 0.5em;
  color: var(--fg);
}
.md-render :deep(h1) { font-size: 1.3em; }
.md-render :deep(h2) { font-size: 1.18em; }
.md-render :deep(h3),
.md-render :deep(h4) { font-size: 1.06em; }

.md-render :deep(p) {
  margin: 0.5em 0;
  line-height: 1.7;
}

.md-render :deep(ul),
.md-render :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}
/* 恢复 Tailwind preflight 清掉的 list-style-type（preflight 对 ol/ul 设 list-style:none）。
   不恢复则 <ol> 数字编号不可见——用户气泡里的编号列表会丢编号只剩换行。 */
.md-render :deep(ul) {
  list-style-type: disc;
}
.md-render :deep(ol) {
  list-style-type: decimal;
}
.md-render :deep(li) { margin: 0.2em 0; line-height: 1.6; }
.md-render :deep(li)::marker { color: var(--subtle); }

.md-render :deep(blockquote) {
  border-left: 2px solid var(--border-strong);
  padding-left: 0.85em;
  margin: 0.6em 0;
  color: var(--muted);
}

.md-render :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.md-render :deep(a:hover) { text-decoration: underline; }

/* 文件路径链接：等宽 + 下划线点示，区别于普通外链（提示是文件而非网页） */
.md-render :deep(.md-filepath) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--accent);
  text-decoration: underline dotted;
  text-underline-offset: 2px;
  cursor: pointer;
}
.md-render :deep(.md-filepath:hover) {
  text-decoration: underline;
}

/* 行内代码：弱底色 + 等宽，区分正文 */
.md-render :deep(code:not(pre code)) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--surface-2);
  padding: 0.1em 0.35em;
  border-radius: var(--radius-sm);
}

/* ── 代码块容器（fence 规则覆盖产出 .md-codeblock）──
   shiki 产出的 <pre class="shiki"> 被包在 .md-codeblock 内，外层统一控制圆角/边框/overflow。
   header 含语言标签（左）+ 复制按钮（右）。复制按钮 icon 用 CSS 伪元素 + .is-copied 切换。
   注：shiki 的 --shiki-dark-bg 定义在 pre 的 inline style（子元素），父容器读不到，
   故 .md-codeblock 不设 bg——代码区底色由 pre 的 shiki bg 提供，header 用 --surface-2。 */
.md-render :deep(.md-codeblock) {
  margin: 0.7em 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.md-render :deep(.md-codeblock__header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.25em 0.4em 0.25em 0.8em;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.md-render :deep(.md-codeblock__lang) {
  font-family: var(--font-mono);
  font-size: 0.72em;
  color: var(--subtle);
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.md-render :deep(.md-codeblock__copy) {
  appearance: none;
  border: 0;
  background: transparent;
  cursor: pointer;
  width: 20px;
  height: 20px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--muted);
  transition: color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
}
.md-render :deep(.md-codeblock__copy:hover) {
  color: var(--fg);
  background: var(--surface-hover);
}
/* 复制 icon：默认 Copy（用 inline SVG mask），已复制态用 .is-copied 切换为 Check。
   v-html 内不能用 Vue 组件 icon，用 CSS background + currentColor mask 实现 icon 着色。 */
.md-render :deep(.md-codeblock__copy::before) {
  content: '';
  display: block;
  width: 13px;
  height: 13px;
  background-color: currentColor;
  /* Copy icon（lucide copy path） */
  -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2' ry='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/></svg>") center / contain no-repeat;
  mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2' ry='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/></svg>") center / contain no-repeat;
}
.md-render :deep(.md-codeblock__copy.is-copied) {
  color: var(--success);
}
.md-render :deep(.md-codeblock__copy.is-copied::before) {
  /* Check icon（lucide check path） */
  -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'/></svg>") center / contain no-repeat;
  mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'/></svg>") center / contain no-repeat;
}

/* shiki <pre>：被容器包住后去掉自身 margin/圆角，仅保留内边距 + 横向滚动 */
.md-render :deep(.md-codeblock pre.shiki) {
  margin: 0;
  padding: 0.8em 1em;
  border-radius: 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.85em;
  line-height: 1.6;
}
.md-render :deep(.md-codeblock pre.shiki code) {
  font-family: inherit;
  background: transparent;
  padding: 0;
}

/* mermaid 容器：居中 + 内边距（MermaidRenderer 内的 .md-mermaid-wrap） */
.md-render :deep(.md-mermaid) {
  margin: 0.8em 0;
  text-align: center;
}

/* 表格 */
.md-render :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.7em 0;
  font-size: 0.92em;
}
.md-render :deep(th),
.md-render :deep(td) {
  border: 1px solid var(--border);
  padding: 0.35em 0.6em;
  text-align: left;
}
.md-render :deep(th) {
  background: var(--surface-2);
  font-weight: 600;
  color: var(--fg);
}

.md-render :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

/* ── shiki 双主题切换（defaultColor:false）──
   shiki 产出的 span 带 --shiki-dark(暗色 token) / --shiki-light(亮色 token)，
   pre.shiki 带 --shiki-dark-bg / --shiki-light-bg。暗为默认，亮主题经 [data-theme] 覆盖。
   走 design-tokens 的主题切换机制（style.css :root / [data-theme="light"]），不新增硬编码色。 */
.md-render :deep(.shiki) {
  background-color: var(--shiki-dark-bg) !important;
}
.md-render :deep(.shiki span) {
  color: var(--shiki-dark);
}

:global([data-theme="light"]) .md-render :deep(.shiki) {
  background-color: var(--shiki-light-bg) !important;
}
:global([data-theme="light"]) .md-render :deep(.shiki span) {
  color: var(--shiki-light);
}
</style>
