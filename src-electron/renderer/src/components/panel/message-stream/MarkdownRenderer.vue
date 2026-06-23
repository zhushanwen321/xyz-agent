<template>
  <!--
    展示组件 · Markdown 渲染（W03）。
    shiki 代码高亮（VSCode 级）+ markdown-it 结构解析（标题/列表/表格/行内代码/链接）。

    双主题（ADR-0021-B：暗为默认）：shiki defaultColor:false 产出 --shiki-dark(暗)/--shiki-light(亮)
    双套 span，由 :root(暗默认) / [data-theme="light"] 的 scoped 样式切换，走 design-tokens 体系。

    v-html：shiki + markdown-it(html:false) 的输出是 XSS 安全的——
    shiki codeToHtml 转义所有非 token 文本（只发 scoped <span>），markdown-it 不透传用户原始 HTML。
    故在此受控渲染点局部放开 taste-lint vue/no-v-html（error）。仅此组件。
  -->
  <div class="md-render">
    <!-- eslint-disable-next-line vue/no-v-html -- shiki+markdown-it(html:false) 输出 XSS 安全：shiki 转义所有非 token 文本（只发 scoped span），markdown-it 不透传用户原始 HTML。仅此受控渲染点放开。 -->
    <div v-html="html" />
  </div>
</template>

<script setup lang="ts">
/**
 * Markdown 渲染器。
 * - 首次渲染需 await shiki 加载（异步），期间显示空（极短，highlighter 单例只建一次）。
 * - content 变化（流式增量）触发重新渲染；markdown-it 实例已缓存，后续渲染同步。
 * - 用 v-html 注入 shiki+markdown-it 的安全 HTML（XSS 由 html:false + shiki 转义保证）。
 */
import { ref, watch } from 'vue'
import { renderMarkdown } from '@/composables/logic/markdown'

const props = defineProps<{
  content: string
}>()

const html = ref('')
let renderSeq = 0

watch(
  () => props.content,
  async (text) => {
    if (!text.trim()) {
      html.value = ''
      return
    }
    // 流式增量会高频触发：用序号守卫，只采纳最新一次的渲染结果（防旧渲染覆盖新内容）
    const seq = ++renderSeq
    const rendered = await renderMarkdown(text)
    if (seq === renderSeq) html.value = rendered
  },
  { immediate: true },
)
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

/* 代码块（shiki 产出）：去掉 shiki 默认 margin，外层圆角 + 横向滚动 */
.md-render :deep(pre.shiki) {
  margin: 0.7em 0;
  padding: 0.8em 1em;
  border-radius: var(--radius);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.85em;
  line-height: 1.6;
}
.md-render :deep(pre.shiki code) {
  font-family: inherit;
  background: transparent;
  padding: 0;
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
