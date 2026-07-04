<!--
  CodeBlock —— 代码文件高亮渲染（detail-renderers 系列）。

  用 shiki 单例（与 MarkdownRenderer 共享）对整段代码做语法高亮，产出双主题
  --shiki-dark/--shiki-light span，由本组件 scoped 样式切换主题。

  v-html 受控点：shiki codeToHtml 转义所有非 token 文本（只发 scoped span），输出 XSS 安全，
  与 MarkdownRenderer 同论证（markdown.ts highlightCode 注释）。仅此受控点局部放开
  taste-lint vue/no-v-html。

  首次加载 shiki 异步：加载中显示空（极短，单例建好后同步）。props.code 变化重新高亮，
  用 renderSeq 序号守卫防旧渲染覆盖新内容（与 MarkdownRenderer 同模式）。
-->
<template>
  <!-- shiki codeToHtml 转义所有非 token 文本（只发 scoped span），输出 XSS 安全，与 MarkdownRenderer 同论证。
       eslint vue/no-v-html 块级禁用：下方 <pre v-html> 是受控注入点。 -->
  <!-- eslint-disable vue/no-v-html -->
  <pre
    v-if="html"
    class="shiki-codeblock shiki m-0 overflow-x-auto rounded p-2 font-mono text-[11px] leading-[1.5]"
    v-html="html"
  />
  <!-- eslint-enable vue/no-v-html -->
  <!-- shiki 未就绪/高亮失败降级：纯文本插值（XSS 安全） -->
  <pre
    v-else
    class="shiki-codeblock whitespace-pre-wrap break-all rounded p-2 font-mono text-[11px] leading-[1.5] text-fg/90"
  >{{ code }}</pre>
</template>

<script setup lang="ts">
/**
 * 代码高亮渲染器。
 * - props.code 变化（切文件）触发重新高亮；highlightCode 复用 shiki 单例。
 * - 序号守卫：异步高亮完成时若 code 已变，丢弃旧结果（防覆盖）。
 */
import { ref, watch } from 'vue'
import { highlightCode } from '@/composables/logic/markdown'

const props = defineProps<{
  /** 代码文本（UTF-8，由 file.read 返回） */
  code: string
  /** shiki 语言名（由 extToLang 映射，未加载的 lang fallback typescript） */
  lang: string
}>()

const html = ref('')
let renderSeq = 0

watch(
  () => [props.code, props.lang] as const,
  async ([code, lang]) => {
    if (!code) {
      html.value = ''
      return
    }
    const seq = ++renderSeq
    const rendered = await highlightCode(code, lang)
    // 序号守卫：仅采纳最新一次结果
    if (seq === renderSeq) html.value = rendered
  },
  { immediate: true },
)
</script>

<style scoped>
/* 复用 MarkdownRenderer 的 shiki 双主题切换机制（defaultColor:false 产出双套 span）。
   shiki codeToHtml 产出的 <pre class="shiki"> 带 --shiki-dark-bg/--shiki-light-bg 变量，
   这里把变量应用到 background-color；span 的 color 同理。暗为默认，亮主题经
   [data-theme="light"] 覆盖。走 design-tokens 主题机制。
   <pre> 自身布局样式用 Tailwind class（template 内），scoped 只留 :deep 主题变量切换
   （Tailwind 无法表达跨 :deep + [data-theme] 的 CSS 变量切换，属 escape hatch）。 */
.shiki-codeblock :deep(.shiki) {
  background-color: var(--shiki-dark-bg) !important;
}
.shiki-codeblock :deep(span) {
  color: var(--shiki-dark);
}

:global([data-theme="light"]) .shiki-codeblock :deep(.shiki) {
  background-color: var(--shiki-light-bg) !important;
}
:global([data-theme="light"]) .shiki-codeblock :deep(span) {
  color: var(--shiki-light);
}
</style>
