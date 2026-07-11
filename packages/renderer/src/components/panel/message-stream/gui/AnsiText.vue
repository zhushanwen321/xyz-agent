<script setup lang="ts">
/**
 * ANSI 文本渲染组件——用 ansi_up 解析 ANSI 转义序列，输出着色 HTML。
 *
 * 用于 tool result 的原始 ANSI 文本（ToolCall.outputRaw）。
 * 当 extension 未引入协议包时，tool result 的 ANSI 输出走此组件兜底渲染。
 */
import { computed } from 'vue'
import { AnsiUp } from 'ansi_up'

const props = defineProps<{
  /** tool result 文本（含 ANSI 转义）。 */
  content: string
}>()

const ansi = new AnsiUp()
// ansi_up 默认转义 HTML（escape_html=true），安全

const html = computed(() => {
  try {
    return ansi.ansi_to_html(props.content)
  } catch {
    // 解析失败回退纯文本
    return props.content
  }
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- ansi_up 默认 escape_html=true，输出 XSS 安全。与 MermaidRenderer/MarkdownRenderer 同论证。受控注入点。 -->
  <span class="whitespace-pre-wrap font-mono" data-testid="ansi-text" v-html="html" />
</template>
