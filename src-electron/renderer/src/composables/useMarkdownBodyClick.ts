/**
 * Shared markdown body click handler.
 * Handles code-copy, code-expand, and external link clicks via event delegation.
 * Used by both AssistantContent.vue and MessageBubble.vue.
 */
const COPY_FEEDBACK_MS = 1500

export function useMarkdownBodyClick() {
  async function handleBodyClick(e: MouseEvent) {
    const target = e.target as HTMLElement

    const anchor = target.closest('a')
    if (anchor instanceof HTMLAnchorElement) {
      const href = anchor.href
      if (href && /^https?:\/\//i.test(href)) {
        e.preventDefault()
        window.electronAPI?.openExternal(href)
      }
      return
    }

    if (target.matches('.code-copy-btn')) {
      e.preventDefault()
      const codeBlock = target.closest('.code-block')
      const codeEl = codeBlock?.querySelector('pre code') ?? codeBlock?.querySelector('code')
      const code = codeEl?.textContent ?? ''
      try {
        await navigator.clipboard.writeText(code)
        target.textContent = '已复制'
        setTimeout(() => { target.textContent = '复制' }, COPY_FEEDBACK_MS)
      } catch {
        // Clipboard API may be denied by browser security policy;
        // the visual feedback ("复制失败") is sufficient for the user.
        target.textContent = '复制失败'
        setTimeout(() => { target.textContent = '复制' }, COPY_FEEDBACK_MS)
      }
      return
    }

    if (target.matches('.code-expand-btn')) {
      e.preventDefault()
      const codeBlock = target.closest('.code-block')
      if (!codeBlock) return
      const isCollapsed = codeBlock.getAttribute('data-collapsed') === 'true'
      codeBlock.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true')
      target.textContent = isCollapsed ? '收起' : '展开'
    }
  }

  return { handleBodyClick }
}
