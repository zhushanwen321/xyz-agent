import { describe, it, expect } from 'vitest'
import { collectMessageContent } from '../collectMessageContent'

function createElement(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.firstElementChild as HTMLElement
}

describe('collectMessageContent', () => {
  it('collects plain text from a simple message', () => {
    const el = createElement(`
      <div><div class="msg__body">Hello world</div></div>
    `)
    const result = collectMessageContent(el)
    expect(result).toContain('Hello world')
  })

  it('collects thinking block content', () => {
    const el = createElement(`
      <div>
        <div class="thinking-block" data-expanded="true">Let me think about this...</div>
        <div class="msg__body">Here is my answer</div>
      </div>
    `)
    const result = collectMessageContent(el)
    expect(result).toContain('[Thinking: Let me think about this...]')
    expect(result).toContain('Here is my answer')
  })

  it('collects tool call card content', () => {
    const el = createElement(`
      <div>
        <div class="tool-call-card" data-tool-name="read" data-tool-status="success" data-tool-path="src/file.ts">read</div>
        <div class="msg__body">Done</div>
      </div>
    `)
    const result = collectMessageContent(el)
    expect(result).toContain('[Tool: read ✓ src/file.ts]')
    expect(result).toContain('Done')
  })

  it('includes all sections in correct order', () => {
    const el = createElement(`
      <div>
        <div class="thinking-block" data-expanded="true">Thinking...</div>
        <div class="tool-call-card" data-tool-name="write" data-tool-status="success" data-tool-path="out.ts">write</div>
        <div class="msg__body">Final answer</div>
      </div>
    `)
    const result = collectMessageContent(el)
    const thinkingIdx = result.indexOf('[Thinking:')
    const toolIdx = result.indexOf('[Tool:')
    const bodyIdx = result.indexOf('Final answer')
    expect(thinkingIdx).toBeLessThan(toolIdx)
    expect(toolIdx).toBeLessThan(bodyIdx)
  })

  it('plain format strips markdown symbols', () => {
    const el = createElement(`
      <div><div class="msg__body"># Title<br>*italic* and **bold**<br><a href="url">link</a><br>- list item</div></div>
    `)
    const result = collectMessageContent(el, { format: 'plain' })
    expect(result).not.toContain('**')
  })

  it('markdown format preserves content', () => {
    const el = createElement(`
      <div><div class="msg__body"># Title<br>**bold**</div></div>
    `)
    const result = collectMessageContent(el, { format: 'markdown' })
    expect(result).toContain('# Title')
    expect(result).toContain('**bold**')
  })

  it('handles tool call with error status', () => {
    const el = createElement(`
      <div>
        <div class="tool-call-card" data-tool-name="bash" data-tool-status="error" data-tool-path="">bash</div>
        <div class="msg__body">error result</div>
      </div>
    `)
    const result = collectMessageContent(el)
    expect(result).toContain('[Tool: bash ✗]')
  })

  it('returns empty string for empty element', () => {
    const el = createElement('<div></div>')
    const result = collectMessageContent(el)
    expect(result).toBe('')
  })

  it('ignores thinking blocks that are not expanded', () => {
    const el = createElement(`
      <div>
        <div class="thinking-block" data-expanded="false">Hidden thinking</div>
        <div class="msg__body">Answer</div>
      </div>
    `)
    const result = collectMessageContent(el)
    expect(result).not.toContain('[Thinking:')
    expect(result).toContain('Answer')
  })

  it('markdown format reads from data-markdown-source when available', () => {
    const el = createElement(`
      <div>
        <div class="msg__body" data-markdown-source="# Title\n\n**bold** text\n- item 1\n- item 2">Rendered Title bold text item 1 item 2</div>
      </div>
    `)
    const result = collectMessageContent(el, { format: 'markdown' })
    expect(result).toContain('# Title')
    expect(result).toContain('**bold**')
    expect(result).toContain('- item 1')
    // textContent would lose these markdown symbols
    expect(result).not.toBe('Rendered Title bold text item 1 item 2')
  })

  it('markdown format falls back to textContent without data-markdown-source', () => {
    const el = createElement(`
      <div><div class="msg__body">Plain text fallback</div></div>
    `)
    const result = collectMessageContent(el, { format: 'markdown' })
    expect(result).toContain('Plain text fallback')
  })

  it('plain format ignores data-markdown-source and uses textContent', () => {
    const el = createElement(`
      <div>
        <div class="msg__body" data-markdown-source="# Title\n**bold**">Rendered text</div>
      </div>
    `)
    const result = collectMessageContent(el, { format: 'plain' })
    // plain mode should use textContent, not data-markdown-source
    expect(result).toContain('Rendered text')
  })
})
