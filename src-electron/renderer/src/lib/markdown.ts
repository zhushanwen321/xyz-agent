// @ts-expect-error markdown-it has no types
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})

export function renderMarkdown(text: string): string {
  const html = md.render(text)
  return DOMPurify.sanitize(html)
}
