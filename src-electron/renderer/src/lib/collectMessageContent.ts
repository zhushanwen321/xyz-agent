/**
 * collectMessageContent — extract message content from a DOM element
 *
 * Collects: thinking blocks (expanded) → tool call cards → message body text
 *
 * @param messageEl - The wrapper HTMLElement containing the message parts
 * @param opts.format - 'markdown' (default) preserves formatting; 'plain' strips markdown symbols
 */

/** Status symbol map for tool call cards */
const TOOL_STATUS_SYMBOLS: Record<string, string> = {
  success: '✓',
  error: '✗',
  running: '…',
}

/** Regex for stripping markdown symbols in plain mode */
const MARKDOWN_STRIP_RE = /[#*_~`>\[\]()]|!\[.*?\]\(.*?\)|\[([^\]]*)\]\([^)]*\)/g

function stripMarkdown(text: string): string {
  return text
    .replace(MARKDOWN_STRIP_RE, (_, p1) => p1 ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function collectMessageContent(
  messageEl: HTMLElement,
  opts?: { format?: 'markdown' | 'plain' },
): string {
  const format = opts?.format ?? 'markdown'
  const parts: string[] = []

  // 1. Collect thinking blocks (only expanded ones)
  const thinkingBlocks = messageEl.querySelectorAll('.thinking-block[data-expanded="true"]')
  for (const tb of thinkingBlocks) {
    const text = tb.textContent?.trim() ?? ''
    if (text) {
      parts.push(`[Thinking: ${text}]`)
    }
  }

  // 2. Collect tool call cards
  const toolCards = messageEl.querySelectorAll('.tool-call-card')
  for (const tc of toolCards) {
    const name = tc.getAttribute('data-tool-name') ?? ''
    const status = tc.getAttribute('data-tool-status') ?? ''
    const path = tc.getAttribute('data-tool-path') ?? ''
    const symbol = TOOL_STATUS_SYMBOLS[status] ?? status
    const pathPart = path ? ` ${path}` : ''
    parts.push(`[Tool: ${name} ${symbol}${pathPart}]`)
  }

  // 3. Collect message body text
  const body = messageEl.querySelector('.msg__body')
  if (body) {
    // For markdown format, prefer the original markdown source stored in data attribute
    // (textContent loses markdown formatting since v-html renders HTML)
    if (format === 'markdown') {
      const markdownSource = body.getAttribute('data-markdown-source')
      if (markdownSource) {
        parts.push(markdownSource)
      } else {
        const text = body.textContent?.trim() ?? ''
        if (text) parts.push(text)
      }
    } else {
      const text = body.textContent?.trim() ?? ''
      if (text) parts.push(text)
    }
  }

  const result = parts.join('\n\n')
  return format === 'plain' ? stripMarkdown(result) : result
}
