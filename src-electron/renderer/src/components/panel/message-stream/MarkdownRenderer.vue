<template>
  <!--
    展示组件 · Markdown 渲染（W03）。
    shiki 代码高亮（VSCode 级）+ markdown-it 结构解析（标题/列表/表格/行内代码/链接）。

    代码块增强（fence 规则覆盖，markdown.ts）：语言标签 + 复制按钮（事件委托）。
    mermaid 块：v-html 注入占位 <div class="md-mermaid" data-source>，watch html 后
    动态挂载 MermaidRenderer 子实例（render 函数模式）到占位点，实现异步渲染 + 全屏 Dialog。

    双主题（ADR-0021-B：暗为默认）：shiki defaultColor:false 产出 --shiki-dark(暗)/--shiki-light(亮)
    双套 span，由 :root(暗默认) / [data-theme="light"] 的 scoped 样式切换，走 design-tokens 体系。

    v-html：shiki + markdown-it(html:false) 的输出是 XSS 安全的——
    shiki codeToHtml 转义所有非 token 文本（只发 scoped <span>），markdown-it 不透传用户原始 HTML，
    代码/mermaid 源码经 base64 编码进 data 属性。故在此受控渲染点局部放开 taste-lint vue/no-v-html。仅此组件。
  -->
  <div class="md-render" @click="onClick">
    <!-- eslint-disable-next-line vue/no-v-html -- shiki+markdown-it(html:false) 输出 XSS 安全：shiki 转义所有非 token 文本（只发 scoped span），markdown-it 不透传用户原始 HTML，code/mermaid 经 base64 编码。仅此受控渲染点放开。 -->
    <div ref="contentEl" v-html="html" />
  </div>
</template>

<script setup lang="ts">
/**
 * Markdown 渲染器。
 * - 首次渲染需 await shiki 加载（异步），期间显示空（极短，highlighter 单例只建一次）。
 * - content 变化（流式增量）触发重新渲染；markdown-it 实例已缓存，后续渲染同步。
 * - 代码块复制按钮用事件委托（v-html 内不能绑 Vue 事件），mermaid 占位动态挂载 MermaidRenderer。
 */
import { ref, watch, onUpdated, onBeforeUnmount, nextTick, h, render, type VNode } from 'vue'
import { renderMarkdown } from '@/composables/logic/markdown'
import MermaidRenderer from './MermaidRenderer.vue'

const props = defineProps<{
  content: string
}>()

const html = ref('')
const contentEl = ref<HTMLElement | null>(null)
let renderSeq = 0

/** 复制反馈持续时长（ms）—— 与 useCopy composable 保持一致（事件委托场景无法复用 ref，用同等常量） */
const COPY_FEEDBACK_MS = 1200

/** base64 解码（UTF-8 安全，与 markdown.ts encodeBase64 对称） */
function decodeBase64(b64: string): string {
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/* ── 代码块复制按钮：事件委托 ── */
let copyResetTimer: ReturnType<typeof setTimeout> | null = null
/** 当前处于"已复制"反馈态的按钮（同时只有一个） */
let copiedBtn: HTMLElement | null = null

function clearCopiedState(): void {
  if (copiedBtn) {
    copiedBtn.classList.remove('is-copied')
    copiedBtn = null
  }
}

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  const btn = target.closest('.md-codeblock__copy') as HTMLElement | null
  if (!btn) return
  const dataCode = btn.dataset.code
  if (!dataCode) return
  const code = decodeBase64(dataCode)
  navigator.clipboard.writeText(code).catch(() => {
    /* 剪贴板失败静默：非关键路径 */
  })
  // 反馈态：切换为"已复制"（CSS 控制 icon），1.2s 后还原
  clearCopiedState()
  btn.classList.add('is-copied')
  copiedBtn = btn
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(clearCopiedState, COPY_FEEDBACK_MS)
}

/* ── mermaid 占位 → 动态挂载 MermaidRenderer ──
   v-html 产出的 <div class="md-mermaid" data-source> 是纯 HTML，不能直接变 Vue 组件。
   用 Vue render 函数模式：对每个占位，createVNode(MermaidRenderer) + render 到占位容器。
   流式增量重渲时先卸载旧的再挂新的（避免泄漏 + 保证 source 最新）。 */
const mermaidMounts: { host: HTMLElement; vnode: VNode }[] = []

function unmountAllMermaid(): void {
  for (const m of mermaidMounts) {
    // render(null, host) 触发子组件 onUnmounted（清理 MutationObserver 等）
    render(null, m.host)
  }
  mermaidMounts.length = 0
}

async function mountMermaidBlocks(): Promise<void> {
  const root = contentEl.value
  if (!root) return
  // 先卸载上一轮挂载的（html 重渲会重建 DOM，旧 vnode 失效）
  unmountAllMermaid()
  const placeholders = root.querySelectorAll<HTMLElement>('.md-mermaid:not([data-mounted])')
  for (const ph of placeholders) {
    const b64 = ph.dataset.source ?? ''
    if (!b64) continue
    const source = decodeBase64(b64)
    ph.dataset.mounted = '1' // 标记已处理（防 onUpdated 重复挂载同一占位）
    // 清空占位原内容（base64 source 文本），挂 MermaidRenderer
    ph.textContent = ''
    const vnode = h(MermaidRenderer, { source })
    render(vnode, ph)
    mermaidMounts.push({ host: ph, vnode })
  }
}

watch(
  () => props.content,
  async (text) => {
    if (!text.trim()) {
      html.value = ''
      unmountAllMermaid()
      return
    }
    // 流式增量会高频触发：用序号守卫，只采纳最新一次的渲染结果（防旧渲染覆盖新内容）
    const seq = ++renderSeq
    const rendered = await renderMarkdown(text)
    if (seq === renderSeq) {
      html.value = rendered
      await nextTick()
      mountMermaidBlocks()
    }
  },
  { immediate: true },
)

// onUpdated 兜底：html 变化已 watch 处理，但防御性补一次（极少数 DOM 更新时序）
onUpdated(() => {
  mountMermaidBlocks()
})

onBeforeUnmount(() => {
  unmountAllMermaid()
  if (copyResetTimer) clearTimeout(copyResetTimer)
})
</script>

<style scoped>
/* ── markdown 排版（design-tokens 语义色，不硬编码）── */
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
