/**
 * MarkdownSegment —— markdown 渲染段类型（ui 展示层关心的渲染单元）。
 *
 * renderer 壳的 renderMarkdownSegments（markdown.ts，依赖 shiki/markdown-it）产出此类型，
 * 经 ChatViewDeps.renderMarkdown 注入 ui 的 MarkdownRenderer。
 *
 * - text 段：渲染后的 HTML 字符串（含代码块/链接等，走 v-html）
 * - mermaid 段：原始 mermaid 源码（走 MermaidRenderer 组件渲染）
 *
 * 与 renderer composables/logic/markdown.ts 的 MarkdownSegment 结构对齐（renderer 壳适配）。
 */
export interface MarkdownSegment {
  type: 'text' | 'mermaid'
  content: string
}
