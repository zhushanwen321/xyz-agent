/**
 * Markdown 渲染 composable：轻量渲染（streaming）+ 完整渲染（完成）+ mermaid 懒加载。
 *
 * 同时被 MessageBubble（user 气泡）和 AssistantContent（assistant text）使用。
 */
import { ref, computed, watch, nextTick } from 'vue'
import { renderLightweight, renderFull } from '../lib/markdown'
import { useSettingsStore } from '../stores/settings'

export function useMarkdownRender(
  contentGetter: () => string,
  options?: {
    /** 消息 id（用于 mermaid DOM 查询） */
    messageId: () => string
    /** 消息状态 getter */
    status: () => string
    /** 是否始终用 dark 代码主题（user 气泡需要） */
    forceDarkCode?: boolean
  },
) {
  const settings = useSettingsStore()
  const fullRenderCache = ref('')
  // Non-reactive counter: no dependency tracking needed, avoids unnecessary re-computation
  let renderVersion = 0

  let mermaidModule: typeof import('mermaid').default | null = null
  let mermaidInitTheme: string | null = null

  const lightweightContent = computed(() => renderLightweight(contentGetter()))

  const renderedContent = computed(() => {
    if (options?.status() === 'streaming') {
      return lightweightContent.value
    }
    return fullRenderCache.value || lightweightContent.value
  })

  watch(
    () => [contentGetter(), options?.status(), settings.theme] as const,
    async ([content, status]) => {
      if (status !== 'streaming' && content) {
        renderVersion++
        const version = renderVersion
        const effectiveTheme = getEffectiveTheme()
        const codeTheme: 'light' | 'dark' | undefined =
          options?.forceDarkCode ? 'dark' : undefined
        try {
          const result = await renderFull(content, effectiveTheme, { codeTheme })
          if (version === renderVersion) {
            fullRenderCache.value = result
          }
        } catch {
          if (version === renderVersion) {
            fullRenderCache.value = renderLightweight(content)
          }
        }
        await nextTick()
        renderMermaidBlocks()
      }
    },
    { immediate: true },
  )

  function getEffectiveTheme(): 'light' | 'dark' {
    if (settings.theme === 'dark') return 'dark'
    if (settings.theme === 'light') return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  async function renderMermaidBlocks() {
    const msgId = options?.messageId()
    if (!msgId) return
    const el = document.querySelector(`[data-message-id="${msgId}"] .mermaid-source[data-mermaid]`)
    if (!el) return

    try {
      if (!mermaidModule) {
        mermaidModule = (await import('mermaid')).default
      }
      const effectiveTheme = getEffectiveTheme()
      if (mermaidInitTheme !== effectiveTheme) {
        mermaidModule.initialize({
          startOnLoad: false,
          securityLevel: 'sandbox',
          theme: effectiveTheme === 'dark' ? 'dark' : 'default',
        })
        mermaidInitTheme = effectiveTheme
      }
      const sources = document.querySelectorAll(`[data-message-id="${msgId}"] .mermaid-source[data-mermaid]`)
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]
        const content = source.textContent ?? ''
        const mermaidId = `mermaid-${msgId}-${i}-${Date.now()}`
        const { svg } = await mermaidModule.render(mermaidId, content)
        source.innerHTML = svg
        source.removeAttribute('data-mermaid')
        source.classList.remove('mermaid-source')
        source.classList.add('mermaid-rendered')
      }
    } catch {
      const sources = document.querySelectorAll(`[data-message-id="${msgId}"] .mermaid-source[data-mermaid]`)
      sources.forEach(source => {
        source.classList.add('mermaid-error')
        const errorEl = document.createElement('div')
        errorEl.className = 'mermaid-error-msg'
        errorEl.textContent = '图表渲染失败'
        source.parentElement?.insertBefore(errorEl, source)
      })
    }
  }

  return { renderedContent }
}
