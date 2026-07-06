/**
 * useMarkdownInteractions —— markdown v-html 内点击事件委托路由（从 MarkdownRenderer.vue 拆出）。
 *
 * 职责（单一变化轴「v-html 内 a/button 点击分发」）：
 * - ① 代码块复制按钮（.md-codeblock__copy）→ useCodeblockCopy（写剪贴板 + .is-copied 反馈）。
 * - ② 文件路径链接（.md-filepath）→ 按 data-path 分两路：
 *      - 含 /（完整 path，原含/路径场景）→ 直接 selectFile + SideDrawer detail tab
 *      - 不含 /（裸 basename 场景）→ 按 basename 反查 fileSearchStore：
 *        - 唯一匹配 → selectFile(path) + drawer.open('detail')
 *        - 多匹配 → onAmbiguous 回调（调用方弹选择浮层）
 *        - 0 匹配（缓存过期/文件已删）→ 降级 selectFile(basename) 让 DetailPane 处理
 * - ③ 外链 a[href^=http(s)://] → openExternal（Electron file:// 下 target=_blank 不开系统浏览器）。
 *
 * 背景：v-html 渲染的节点 Vue 无法绑事件，统一在容器 @click 委托，由本 composable 按 target
 * 选择器分发。decodeBase64 解出 data-code/data-path 的原始内容。
 *
 * 不含：markdown 渲染/segments（留 MarkdownRenderer）、文件树/抽屉状态（留各自 store/composable）、
 * 歧义浮层渲染（由 onAmbiguous 回调委托调用方，保持本 composable 单一职责）。
 */
import { onBeforeUnmount } from 'vue'
import { decodeBase64 } from '@/composables/logic/markdown'
import { useFileTree } from '@/composables/features/useFileTree'
import { useFileSearch } from '@/composables/features/useFileSearch'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { findByBasename } from '@/lib/file-basename'
import { openExternal } from '@/lib/ipc'
import { useCodeblockCopy } from './useCodeblockCopy'

/** 外链协议判定（http(s):// 才走 openExternal；锚点等走默认行为） */
const EXTERNAL_HREF_RE = /^https?:\/\//i

/** useMarkdownInteractions 的可选配置：session 上下文 + 歧义回调 */
export interface MarkdownInteractionsOptions {
  /**
   * 当前 session id（裸 basename 反查 fileSearchStore 用；命令文档等无 session 场景可省略）。
   * 支持 getter 函数形式——调用方 props.sessionId 变化时 onClick 读到最新值（对象字面量
   * 静态值会在 setup 时快照，切 session 后 opts.sessionId 仍是旧值）。
   */
  sessionId?: string | null | (() => string | null | undefined)
  /**
   * 裸 basename 多匹配时回调（让调用方弹歧义选择浮层）。
   * @param basename 文件名（如 'a.ts'，无路径前缀）
   * @param anchorEl 点击的 <a> 元素（浮层锚定用）
   */
  onAmbiguous?: (basename: string, anchorEl: HTMLElement) => void
}

/** 读取 sessionId（兼容静态值与 getter 形式） */
function readSessionId(src: MarkdownInteractionsOptions['sessionId']): string | null | undefined {
  return typeof src === 'function' ? src() : src
}

export function useMarkdownInteractions(opts: MarkdownInteractionsOptions = {}): { onClick: (e: MouseEvent) => void } {
  const { selectFile } = useFileTree()
  const { load: loadFileCandidates } = useFileSearch()
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

    // ② 文件路径链接：按 data-path 分含/路径（直接打开）和裸 basename（反查后打开/歧义）
    const filepathLink = target.closest('.md-filepath') as HTMLElement | null
    if (filepathLink) {
      e.preventDefault()
      const pathB64 = filepathLink.dataset.path
      if (pathB64) {
        const path = decodeBase64(pathB64)
        // 含 / 的完整 path（原含/路径场景）：无歧义，直接打开
        if (path.includes('/')) {
          selectFile(path)
          drawer.open('detail')
          return
        }
        // 裸 basename：按 basename 反查 fileSearchStore（session 上下文）
        const sid = readSessionId(opts.sessionId)
        if (sid) {
          // 缓存命中同步取，否则降级（loadFileCandidates 异步，点击场景不阻塞，下次点击生效）
          void loadFileCandidates(sid).then((nodes) => {
            const matches = findByBasename(nodes, path)
            if (matches.length === 1) {
              // 唯一匹配 → 直接打开
              selectFile(matches[0].path)
              drawer.open('detail')
            } else if (matches.length > 1 && opts.onAmbiguous) {
              // 多匹配 → 弹歧义选择浮层
              opts.onAmbiguous(path, filepathLink)
            } else {
              // 0 匹配（缓存过期/文件已删）或无 onAmbiguous：降级 selectFile(basename)
              selectFile(path)
              drawer.open('detail')
            }
          })
        } else {
          // 无 session 上下文（命令文档等）：降级 selectFile(basename)
          selectFile(path)
          drawer.open('detail')
        }
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
