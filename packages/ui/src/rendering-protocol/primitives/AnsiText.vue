<script setup lang="ts">
/**
 * ANSI 文本渲染组件（v6）——用 ansi_up 解析 ANSI 转义序列，输出着色 HTML。
 *
 * 用于 tool result 的原始 ANSI 文本（ToolCall.outputRaw）。
 * 当 extension 未引入协议包时，tool result 的 ANSI 输出走此组件兜底（§5.5 永远保留）。
 *
 * v6 改造（§3.7 + §8）：
 * - use_classes=true：ansi_up 输出 `ansi-{color}-fg` class（而非内联 rgb），由 CSS 层映射 v6 token。
 * - 16 fg class 双主题映射（DM1 对照 §8）：暗色基础 16 条，亮色仅覆盖 black/white 明度反转。
 * - bg 丢弃：不定义任何 .ansi-*-bg CSS 规则，ansi_up 输出的 bg span 无样式 = 透明（§8「不自加背景」）。
 * - escape_html 默认 true（XSS 安全）。
 *
 * 已知限制：ansi_up use_classes 对 256 色 truecolor 仍输出内联 rgb（不映射 v6 token），
 * spec §8 明确范围仅 16 色，256 色不映射（RK2，不扩 scope）。
 */
import { computed } from 'vue'
import { AnsiUp } from 'ansi_up'

const props = defineProps<{
  /** tool result 文本（含 ANSI 转义）。 */
  content: string
}>()

const ansi = new AnsiUp()
// v6：输出 class 而非内联 rgb，由 CSS 层映射 v6 token（双主题可 CSS 变量化）
ansi.use_classes = true
// ansi_up 默认转义 HTML（escape_html=true），安全

const html = computed(() => {
  try {
    return ansi.ansi_to_html(props.content)
  } catch {
    // 解析失败回退纯文本（ES2 降级）
    return props.content
  }
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- ansi_up 默认 escape_html=true，输出 XSS 安全。use_classes 模式输出 ansi-* class，样式由下方非 scoped <style> 提供。受控注入点。 -->
  <span class="whitespace-pre-wrap font-mono" data-testid="ansi-text" v-html="html" />
</template>

<!--
  非 scoped <style>：ansi_up use_classes 输出的 span 经 v-html 注入，scoped 选择器
  会加 [data-v-xxx] 属性后缀，但 v-html 注入的子元素无该属性，scoped 无法命中。
  ansi-* class 名是 ansi_up 约定专属前缀，全局污染风险低（escape hatch：v-html 受控注入）。
  16 fg class 映射 v6 token；bg 不定义（丢弃）。
-->
<style>
.ansi-black-fg { color: var(--neutral-faint); }
.ansi-red-fg { color: var(--danger); }
.ansi-green-fg { color: var(--success); }
.ansi-yellow-fg { color: var(--warn); }
.ansi-blue-fg { color: var(--accent); }
.ansi-magenta-fg { color: var(--reasoning); }
.ansi-cyan-fg { color: var(--info); }
.ansi-white-fg { color: var(--neutral-fg); }
.ansi-bright-black-fg { color: var(--neutral-mid); }
.ansi-bright-red-fg { color: var(--danger); }
.ansi-bright-green-fg { color: var(--success); }
.ansi-bright-yellow-fg { color: var(--warn); }
.ansi-bright-blue-fg { color: var(--accent-hover); }
.ansi-bright-magenta-fg { color: var(--reasoning); }
.ansi-bright-cyan-fg { color: var(--info); }
.ansi-bright-white-fg { color: var(--neutral-fg); }

/* 亮色主题：black/white 明度反转（§8 亮色表，白底需深字）。
   其余 14 色语义 token 暗亮一致，靠 var(--danger) 等自动跟随主题。 */
[data-theme="light"] .ansi-black-fg { color: var(--neutral-fg); }
[data-theme="light"] .ansi-white-fg { color: var(--neutral-faint); }
</style>
