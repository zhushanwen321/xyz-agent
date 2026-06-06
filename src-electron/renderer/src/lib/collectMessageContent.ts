/**
 * collectMessageContent — extract message content from a DOM element
 *
 * Collects: thinking blocks (expanded) > tool call cards > message body text
 *
 * @param messageEl - The wrapper HTMLElement containing the message parts
 * @param opts.format - 'markdown' (default) preserves formatting; 'plain' strips markdown symbols
 */

/** Status symbol map for tool call cards */
const TOOL_STATUS_SYMBOLS: Record<string, string> = {
  success: '\u2713',
  error: '\u2717',
  running: '\u2026',
}

/**
 * Strip markdown syntax for plain-text output.
 * Removes headings, bold/italic, strikethrough, inline code,
 * links, blockquotes, and list markers.
 * Preserves non-markdown characters unlike a brute-force regex approach.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^ {0,3}#{1,6}\s*/gm, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^ {0,3}[-*+]\s+/gm, '')
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
