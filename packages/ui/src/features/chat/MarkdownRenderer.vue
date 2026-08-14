<template>
  <!--
    展示组件 · Markdown 渲染（W03）。
    shiki 代码高亮（VSCode 级）+ markdown-it 结构解析（标题/列表/表格/行内代码/链接）。

    渲染模式：renderMarkdownSegments 把 markdown 拆成 text 段（HTML，走 v-html）+ mermaid 段
    （源码，走 <MermaidRenderer> 组件）交替。mermaid 作为 template 里的正常 Vue 组件，
    无 Vue render 函数动态挂载（该模式不可靠，曾导致渲染失败）。

    代码块增强（fence 规则覆盖，markdown.ts）：语言标签 + 复制按钮（事件委托）。

    双主题（ADR-0022-B：暗为默认）：shiki defaultColor:false 产出 --shiki-dark(暗)/--shiki-light(亮)
    双套 span，由 :root(暗默认) / [data-theme="light"] 的 scoped 样式切换，走 design-tokens 体系。

    v-html：shiki + markdown-it(html:false) 的输出是 XSS 安全的——
    shiki codeToHtml 转义所有非 token 文本（只发 scoped <span>），markdown-it 不透传用户原始 HTML，
    代码源码经 base64 编码进 data 属性。故在此受控渲染点局部放开 taste-lint vue/no-v-html。仅此组件。
  -->
  <div class="md-render select-text" :class="{ 'md-render--thinking': variant === 'thinking' }" @click="onClick">
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
 * Markdown 渲染器（w6 迁 ui，deps 注入重构）。
 * - renderMarkdown 经 ChatViewDeps 注入（renderer 壳 renderMarkdownSegments，含 shiki + 路径链接化）
 * - 文件路径/歧义选择经 deps.onFileClick/onAmbiguousSelect/openDrawer 桥接
 * - 代码块复制是 DOM 副作用（v-html 内），ui 内本地处理（base64 解码 data-code + is-copied class）
 * - mermaid 段走 <MermaidRenderer>（经 deps.renderMermaid 渲染 SVG）
 * - content 变化（流式增量）rAF trailing 节流渲染；序号守卫防旧覆盖；失败降级转义纯文本
 */
import { onScopeDispose, ref, watch } from 'vue'
import type { FileNode } from '@xyz-agent/shared'
import type { MarkdownSegment } from './markdown-types'
import { findByBasename } from '../../lib/file-basename'
import AmbiguousFilePopover from './AmbiguousFilePopover.vue'
import MermaidRenderer from './MermaidRenderer.vue'
import { useChatViewDeps } from './chat-view-deps'

const props = defineProps<{
  content: string
  /** 所属 session（文件路径识别 + 歧义候选加载用）；命令文档等无 session 场景传 undefined */
  sessionId?: string | null
  /** 渲染变体：默认 undefined（正文级排版）；'thinking' 用于 thinking 块/次要过程信息。 */
  variant?: 'thinking'
}>()

const deps = useChatViewDeps()

/** data-path 解码（renderer 壳 linkify 产出 base64 编码路径，HISTORICAL：迁移时丢 decodeBase64 致点击打开错误路径） */
function decodeB64(b64: string): string {
  try {
    const binary = atob(b64)
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return b64
  }
}

const segments = ref<MarkdownSegment[]>([])
let renderSeq = 0

// ── H2 流式 markdown 渲染 rAF trailing 节流 ──
// 每个 text_delta token 触发 watch → deps.renderMarkdown 全量重解析。rAF trailing 把一帧内
// 多次 content 变化合并为单次渲染，消除流式卡顿。
let rafId: number | null = null
let pendingContent = ''

/**
 * HTML 特殊字符转义（W1 降级路径用）。deps.renderMarkdown 抛错时把原始 content 转义后
 * 作为单个 text segment 回填——保证消息气泡可读。
 */
function escapeHtmlForFallback(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 歧义选择浮层状态（多匹配 basename 点击时弹出，见 AmbiguousFilePopover） */
const ambiguousState = ref<{ basename: string; anchorEl: HTMLElement } | null>(null)
/** 歧义浮层候选（经 deps.loadFileCandidates 加载，findByBasename 过滤） */
const ambiguousCandidates = ref<FileNode[]>([])

// ambiguousState 变化 → 经 deps 桥接 useFileSearch 加载候选
watch(ambiguousState, async (st) => {
  if (!st) {
    ambiguousCandidates.value = []
    return
  }
  const sid = props.sessionId
  if (!sid) {
    ambiguousCandidates.value = []
    return
  }
  const nodes = await deps.loadFileCandidates(sid, st.basename)
  ambiguousCandidates.value = findByBasename(nodes, st.basename)
})

/** 歧义浮层选中 → 打开文件 detail + 清状态 */
function onAmbiguousSelect(path: string): void {
  deps.onFileClick(path)
  deps.openDrawer('detail', { filePath: path })
  ambiguousState.value = null
}

// ── 代码块复制反馈态（DOM imperative：v-html 内 .md-codeblock__copy 无 Vue 响应式）──
let copiedBtn: HTMLElement | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null
const COPIED_FEEDBACK_MS = 1200

/**
 * v-html 内点击事件委托路由（代码块复制 / 文件路径 / 歧义 basename / 外链）。
 * 文件操作经 deps 桥接（onFileClick/openDrawer）。代码块复制是 DOM 副作用，ui 本地处理。
 */
function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement

  // ① 代码块复制按钮（data-code 是 base64 编码的源码）
  const btn = target.closest('.md-codeblock__copy') as HTMLElement | null
  if (btn) {
    e.preventDefault()
    // base64 解码失败（无合法 data-code）：code 保持空串，跳过剪贴板写入，仅保留反馈态
    let code = ''
    try {
      code = atob(btn.dataset.code ?? '')
    } catch {
      code = ''
    }
    if (code) {
      navigator.clipboard.writeText(code).catch(() => { /* 剪贴板失败静默 */ })
    }
    btn.classList.add('is-copied')
    if (copiedBtn && copiedBtn !== btn) copiedBtn.classList.remove('is-copied')
    copiedBtn = btn
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      btn.classList.remove('is-copied')
      if (copiedBtn === btn) copiedBtn = null
    }, COPIED_FEEDBACK_MS)
    return
  }

  // ② 含/路径文件链接（.md-filepath 带 data-path，base64 编码）
  const pathLink = target.closest('.md-filepath') as HTMLElement | null
  if (pathLink) {
    e.preventDefault()
    const raw = pathLink.dataset.path
    const path = raw ? decodeB64(raw) : (pathLink.textContent ?? '')
    if (path) {
      deps.onFileClick(path)
      deps.openDrawer('detail', { filePath: path })
    }
    return
  }

  // ③ 裸 basename（.md-ambiguous）：弹歧义浮层（多匹配时由 AmbiguousFilePopover 选择）
  const ambLink = target.closest('.md-ambiguous') as HTMLElement | null
  if (ambLink) {
    e.preventDefault()
    const basename = ambLink.textContent ?? ''
    if (basename) ambiguousState.value = { basename, anchorEl: ambLink }
    return
  }
  // ④ 其余点击（外链等）：默认冒泡，不拦截
}

/**
 * 实际执行 markdown 渲染。经 deps.renderMarkdown 桥接 renderer 壳的 renderMarkdownSegments
 * （含 shiki 高亮 + 路径/basename 链接化，renderer 壳内部管 filePaths/localFiles）。
 * 序号守卫防旧渲染覆盖新内容；失败降级转义纯文本兜底。
 */
async function doRender(text: string): Promise<void> {
  if (!text.trim()) {
    segments.value = []
    return
  }
  const seq = ++renderSeq
  try {
    const segs = await deps.renderMarkdown(text, props.sessionId ?? undefined)
    if (seq === renderSeq) segments.value = segs
  } catch {
    if (seq === renderSeq) {
      segments.value = [{ type: 'text', content: escapeHtmlForFallback(text) }]
    }
  }
}

/** rAF 回调：执行 pending 渲染（延迟求值守卫，一帧内多次 content 变化只渲染末次值） */
function flushRender(): void {
  rafId = null
  void doRender(pendingContent)
}

/** 调度一次渲染（存 pending → 若无挂起 rAF 则 requestAnimationFrame） */
function scheduleRender(text: string): void {
  pendingContent = text
  if (rafId === null) rafId = requestAnimationFrame(flushRender)
}

// content 变化（流式增量）→ rAF 节流渲染
watch(
  () => props.content,
  (text) => {
    scheduleRender(text)
  },
  { immediate: true },
)

// 卸载时取消 pending rAF + 清复制反馈定时器
onScopeDispose(() => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (copiedTimer) clearTimeout(copiedTimer)
})
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
  color: var(--neutral-fg);
}
.md-render :deep(h1) { font-size: 1.3em; }
.md-render :deep(h2) { font-size: 1.18em; }
.md-render :deep(h3),
.md-render :deep(h4) { font-size: 1.06em; }

/* p margin 归零：用户气泡里列表与相邻段落紧贴（旧 0.5em 0 让列表上下多 7px 空行）。
   块级 <p> 天然换行，margin:0 后多段落仍可区分（换行在，只是无额外间距）。
   assistant summary 同此样式，多段落紧贴也是合理节奏。 */
.md-render :deep(p) {
  margin: 0;
  line-height: 1.7;
}

/* 列表样式：让编号/符号列表在视觉上接近普通正文行（用户气泡里手打的编号列表
   不该被当成大间距结构化块）。紧凑节奏：无项间 margin、行高对齐 <p>、左缩进仅留编号位。
   [HISTORICAL] 旧值 margin:0.5em 0 + li margin:0.2em 0 + padding-left:1.5em + marker --subtle，
   导致编号行上下多空行、左缩进过深、编号是三级灰与正文不一致——被用户判定为「像多一个空行」。 */
.md-render :deep(ul),
.md-render :deep(ol) {
  margin: 0;
  padding-left: 1.2em;
}
/* 恢复 Tailwind preflight 清掉的 list-style-type（preflight 对 ol/ul 设 list-style:none）。
   不恢复则 <ol> 数字编号不可见——用户气泡里的编号列表会丢编号只剩换行。 */
.md-render :deep(ul) {
  list-style-type: disc;
}
.md-render :deep(ol) {
  list-style-type: decimal;
}
.md-render :deep(li) {
  margin: 0;
  line-height: 1.7;
}
/* 编号颜色与正文一致（旧 --subtle 让编号变灰，与正文 fg 脱节） */
.md-render :deep(li)::marker {
  color: var(--neutral-fg);
}

.md-render :deep(blockquote) {
  border-left: 2px solid var(--border-strong);
  padding-left: 0.85em;
  margin: 0.6em 0;
  color: var(--neutral-mid);
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
   代码区底色：pre 用 var(--bg-input)（min-dark/min-light 透明底，跟随全部主题/preset），
   header 用 --surface-2。 */
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
  color: var(--neutral-dim);
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
  color: var(--neutral-mid);
  transition: color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
}
.md-render :deep(.md-codeblock__copy:hover) {
  color: var(--neutral-fg);
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

/* shiki <pre>：被容器包住后去掉自身 margin/圆角，仅保留内边距 + 横向滚动。
   背景用 --bg-input（凹陷容器语义，跟随 6 套主题；min 系列 shiki 主题背景透明）。 */
.md-render :deep(.md-codeblock pre.shiki) {
  margin: 0;
  padding: 0.8em 1em;
  border-radius: 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.85em;
  line-height: 1.6;
  background: var(--bg-input);
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

/* 表格横向滚动 wrapper（markdown.ts table_open rule 产出）：超宽表格自身 overflow-x:auto
   滚动，不撑宽 .md-render / detail-content（与 .md-codeblock 同策略：离散块自带滚动容器）。
   table 的 margin 移到 wrapper（避免双 margin）；table width:100% 在 wrapper 内仍撑满窄表格。 */
.md-render :deep(.md-table-wrap) {
  overflow-x: auto;
  margin: 0.7em 0;
}
.md-render :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0;
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
  color: var(--neutral-fg);
}

.md-render :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

/* ── shiki 双主题切换（defaultColor:false，min-dark/min-light 透明底）──
   [HISTORICAL] 亮色切换曾写 :global([data-theme="light"]) X :deep(Y)，Vue scoped 编译
   把「:global 开头 + :deep 结尾」的组合退化成裸 [data-theme="light"]（只匹配 html 元素），
   亮色规则从未作用于代码块——亮色主题下代码块恒为暗色画布。修复：整条选择器包进
   :global（compileStyle 验证输出 [data-theme="light"] .md-render .shiki span）。
   代码块底色由 .md-codeblock pre.shiki 的 var(--bg-input) 提供（跟随全部主题），
   shiki 只提供语法 token 色（明暗两档，独立彩色通道不跟 accent 走）。 */
.md-render :deep(.shiki span) {
  color: var(--shiki-dark);
}

:global([data-theme="light"] .md-render .shiki span) {
  color: var(--shiki-light);
}

/* ── thinking variant：次要过程信息的降级排版 ──
   用于 thinking 块等「过程性次要信息」语境。
   设计取向（impeccable critique 确认）：
   - 标题用 --reasoning（紫）而非 --fg（白），避免与正文 summary 白标题撞色，保持紫色语义族
   - li::marker / blockquote 压到 --subtle（三级灰），结构存在但不抢戏
   - strong 回升到 --fg，提供强调层级（muted 段落里 fg 粗体是唯一强调点）
   - p 行高保持 1.7（继承默认），段落间距与正文一致 */
.md-render--thinking :deep(h1),
.md-render--thinking :deep(h2),
.md-render--thinking :deep(h3),
.md-render--thinking :deep(h4) {
  color: var(--reasoning);
}
.md-render--thinking :deep(li)::marker {
  color: var(--neutral-dim);
}
.md-render--thinking :deep(blockquote) {
  color: var(--neutral-dim);
  border-left-color: var(--border-strong);
}
.md-render--thinking :deep(blockquote) p {
  color: var(--neutral-dim);
}
.md-render--thinking :deep(strong) {
  color: var(--neutral-fg);
  font-weight: 600;
}
</style>
