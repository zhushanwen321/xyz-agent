/**
 * useUrlBar —— BrowserPane 地址栏编辑态管理。
 *
 * 职责：管理地址栏 Input 的编辑态值 + 导航触发 + 防钓鱼回填。
 * 抽出 composable 让 BrowserPane 聚焦布局，地址栏逻辑独立可测。
 *
 * 状态流：
 * - 非编辑态：urlInput 同步 displayUrl（主进程 did-navigate 回填真实 URL）
 * - 编辑态（聚焦中）：urlInput 独立持有用户输入，displayUrl 更新不覆盖（避免导航中闪烁）
 * - 回车：补全协议前缀（裸域名 → https://）→ 触发 navigate → 退出编辑态
 * - Escape：放弃编辑，回填 displayUrl（防钓鱼：不导航到未确认的输入）
 *
 * @param displayUrlRef 真实 URL 的响应式 ref（主进程回填，防钓鱼 SSOT）
 * @param navigateFn 导航回调（调用方传入 browserNavigate IPC）
 * @returns { urlInput, isEditingUrl, onUrlFocus, onUrlEnter, onUrlEscape }
 */
import { ref, watch, type Ref } from 'vue'

/** URL 协议前缀正则（http:// 或 https://，大小写不敏感） */
const URL_SCHEME_RE = /^https?:\/\//i

export function useUrlBar(
  displayUrlRef: Ref<string>,
  navigateFn: (url: string) => void,
): {
  urlInput: Ref<string>
  isEditingUrl: Ref<boolean>
  onUrlFocus: (e: FocusEvent) => void
  onUrlEnter: () => void
  onUrlEscape: () => void
} {
  /** 地址栏编辑态值（Input v-model） */
  const urlInput = ref<string>(displayUrlRef.value)
  /** 是否处于编辑态（聚焦中）。编辑态时 displayUrl 更新不覆盖用户输入 */
  const isEditingUrl = ref<boolean>(false)

  // 非编辑态时同步 displayUrl → urlInput（主进程 did-navigate 回填真实 URL）
  watch(displayUrlRef, (url) => {
    if (!isEditingUrl.value) urlInput.value = url
  })

  /** 聚焦 → 进入编辑态，全选当前 URL（方便整体替换输入新地址） */
  function onUrlFocus(e: FocusEvent): void {
    isEditingUrl.value = true
    const input = e.target as HTMLInputElement
    input.select()
  }

  /** 回车 → 补全协议前缀 + 导航，退出编辑态。
   * 裸域名（example.com）补全为 https://example.com；已有 http(s):// 不重复补全。 */
  function onUrlEnter(): void {
    const raw = urlInput.value.trim()
    if (!raw) return
    const url = URL_SCHEME_RE.test(raw) ? raw : `https://${raw}`
    isEditingUrl.value = false
    navigateFn(url)
    blurActive()
  }

  /** Escape → 放弃编辑，回填真实 URL（防钓鱼：不导航到未确认输入） */
  function onUrlEscape(): void {
    urlInput.value = displayUrlRef.value
    isEditingUrl.value = false
    blurActive()
  }

  return { urlInput, isEditingUrl, onUrlFocus, onUrlEnter, onUrlEscape }
}

/** 失焦当前 active element（回车/Escape 后让 Input 退出编辑态视觉） */
function blurActive(): void {
  ;(document.activeElement as HTMLElement | null)?.blur()
}
