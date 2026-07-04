/**
 * useMarkdownInteractions —— markdown v-html 内点击事件委托路由（从 MarkdownRenderer.vue 拆出）。
 *
 * 职责（单一变化轴「v-html 内 a/button 点击分发」）：
 * - ① 代码块复制按钮（.md-codeblock__copy）→ useCodeblockCopy（写剪贴板 + .is-copied 反馈）。
 * - ② 文件路径链接（.md-filepath）→ selectFile + SideDrawer detail tab（双步模式）。
 * - ③ 外链 a[href^=http(s)://] → openExternal（Electron file:// 下 target=_blank 不开系统浏览器）。
 *
 * 背景：v-html 渲染的节点 Vue 无法绑事件，统一在容器 @click 委托，由本 composable 按 target
 * 选择器分发。decodeBase64 解出 data-code/data-path 的原始内容。
 *
 * 不含：markdown 渲染/segments（留 MarkdownRenderer）、文件树/抽屉状态（留各自 store/composable）。
 */
import { onBeforeUnmount } from 'vue'
import { decodeBase64 } from '@/composables/logic/markdown'
import { useFileTree } from '@/composables/features/useFileTree'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { openExternal } from '@/lib/ipc'
import { useCodeblockCopy } from './useCodeblockCopy'

/** 外链协议判定（http(s):// 才走 openExternal；锚点等走默认行为） */
const EXTERNAL_HREF_RE = /^https?:\/\//i

export function useMarkdownInteractions(): { onClick: (e: MouseEvent) => void } {
  const { selectFile } = useFileTree()
  const drawer = useSideDrawer()
  const { copyButton, dispose } = useCodeblockCopy()

  function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement

    // ① 代码块复制按钮
    const btn = target.closest('.md-codeblock__copy') as HTMLElement | null
    if (btn) {
      const dataCode = btn.dataset.code
      if (dataCode) {
        copyButton(btn, decodeBase64(dataCode))
      }
      return
    }

    // ② 文件路径链接：点击在 SideDrawer detail tab 打开（复用 selectFile + drawer.open 双步模式）
    const filepathLink = target.closest('.md-filepath') as HTMLElement | null
    if (filepathLink) {
      e.preventDefault()
      const pathB64 = filepathLink.dataset.path
      if (pathB64) {
        selectFile(decodeBase64(pathB64))
        drawer.open('detail')
      }
      return
    }

    // ③ 外链 <a href="http(s)://">：Electron file:// 下 target=_blank 不会开系统浏览器，
    //    走 lib/ipc.openExternal → electronAPI.openExternal IPC（main 侧 isValidExternalUrl 校验只放行 http(s)://）
    const anchor = target.closest('a[href]') as HTMLAnchorElement | null
    if (anchor) {
      const href = anchor.getAttribute('href') ?? ''
      if (EXTERNAL_HREF_RE.test(href)) {
        e.preventDefault()
        openExternal(href).catch(() => {
          /* 打开失败静默：非关键路径 */
        })
      }
      // 非 http(s) 链接（如锚点）走默认行为
    }
  }

  onBeforeUnmount(dispose)

  return { onClick }
}
