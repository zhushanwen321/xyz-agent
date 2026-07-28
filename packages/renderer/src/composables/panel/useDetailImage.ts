/**
 * useDetailImage —— DetailPane 图片 URL 加载 composable（spec §十 D8 远程图片资源化）。
 *
 * 从 DetailPane.vue 抽出（行数约束 <script setup> ≤300），内聚「图片 URL 加载 + 防竞态 + 模式分支」逻辑：
 * - 本地模式（isRemoteMode()===false）：imageUrl = local-file:///encodeURIComponent(absPath)
 *   （与改造前 computed 逐字节一致，零改动——spec §十二 兼容性契约硬约束）
 * - 远程模式：signUrl(path) 现签 + wsUrlToHttpOrigin(wsUrl) 拼 httpOrigin + 相对 url → 完整 src
 *   （TTL 5min 不缓存，每次 watch 重新签发；<img> HTTP cache 兜底）
 * - 防竞态：signUrlReqId guard——快速切文件时旧 RPC 晚到 reqId 不一致即丢弃（对齐 useDetailPane.openPreview loadToken 模式）
 * - 失败（RPC reject / img onerror）→ imageUrl=null 走占位（imageLoadFailed 标志触发）
 *
 * 设计决策（slice TC1-TC3 / IF2 / DM1 / ERR1-4）：ref+watch+reqId-guard，不用 AbortController
 * （WS RPC 无 cancel 协议），不用缓存（spec §十每次现签）。
 *
 * 依赖方向：依赖 useDetailPane（state/sessionCwd）+ file API + connection-config + ws-origin。
 * 被DetailPane.vue 消费。
 */
import { ref, watch } from 'vue'
import { signUrl } from '@/api/domains/file'
import { isRemoteMode, getActiveProfile } from '@/lib/remote/connection-config'
import { wsUrlToHttpOrigin } from '@/lib/remote/ws-origin'
import { resolvePreviewPath } from '@/lib/path-utils'
import type { DetailPaneState } from '@/composables/features/useDetailPane'

/**
 * 加载图片 URL 的入参（DetailPane 提供 state ref + sessionCwd 取值函数 + sessionId）。
 */
export interface UseDetailImageOptions {
  /** useDetailPane 返回的 state ref（含 path） */
  state: { value: DetailPaneState }
  /** useDetailPane 返回的 sessionCwd 取值函数 */
  sessionCwd: (sessionId: string | null) => string | null
  /** DetailPane 的 sessionId prop */
  sessionId: () => string | null
}

/**
 * DetailPane 图片 URL 加载 hook。
 *
 * @returns imageUrl（ref，模板绑定 src）/ imageLoadFailed（ref，模板绑定占位分支显隐）/ onImageError（img @error 回调）
 */
export function useDetailImage(options: UseDetailImageOptions) {
  const { state, sessionCwd, sessionId } = options

  /**
   * 图片加载失败标志（local-file:// 403 白名单 / 文件损坏 / 远程签名 URL 404 时 onerror 置 true，降级占位）。
   * 切文件时在 loadImage 首行重置（新文件应重新尝试加载）。
   */
  const imageLoadFailed = ref(false)

  /**
   * 图片 URL（ref，从原 computed 改造——computed 无法承载 async signUrl 结果）。
   * 模板 `v-if="imageUrl"` 绑定，null 走占位分支。
   */
  const imageUrl = ref<string | null>(null)

  /**
   * signUrl 请求序号（防竞态 guard，非响应式——不参与模板渲染）。
   * 快速切换文件时，旧 signUrl 晚到的结果 reqId 不一致即丢弃。
   */
  let signUrlReqId = 0

  /**
   * 加载图片 URL（watch(path) 触发）。
   * - 首行重置 imageLoadFailed（保留原「切文件重试」语义）
   * - 无 cwd/path → null
   * - 远程模式：signUrl 现签 + reqId-guard 防 race，失败/竞态 → null（走占位）
   * - 本地模式：local-file:///encodeURIComponent(absPath)（零改动路径）
   */
  async function loadImage(): Promise<void> {
    // 切文件重置图片失败标志（新文件应重新尝试加载）
    imageLoadFailed.value = false
    // 仅图片类文件加载 URL（对齐原 computed 惰性求值——非图片文件 <img> 不渲染不读取 imageUrl，
    // 故原 computed 对非图片文件从不执行；改 watch 后须显式 guard 避免无谓 RPC）。
    if (state.value.kind !== 'image') {
      imageUrl.value = null
      return
    }
    const cwd = sessionCwd(sessionId())
    const relPath = state.value.path
    if (!cwd || !relPath) {
      imageUrl.value = null
      return
    }
    const absPath = resolvePreviewPath(cwd, relPath).absolute
    if (isRemoteMode()) {
      // 远程模式：signUrl 现签 + httpOrigin 拼完整 src
      const profile = getActiveProfile()
      const httpOrigin = profile ? wsUrlToHttpOrigin(profile.url) : ''
      const myReqId = ++signUrlReqId
      try {
        const result = await signUrl(absPath)
        // 防竞态：快速切换文件时旧 RPC 晚到，reqId 不一致则丢弃（不覆盖新图）
        if (myReqId !== signUrlReqId) return
        imageUrl.value = httpOrigin + result.url
      } catch {
        // signUrl RPC 失败（开放模式/越权/不存在）→ 降级占位
        if (myReqId !== signUrlReqId) return
        imageUrl.value = null
      }
    } else {
      // 本地模式：local-file:// 协议（与原 computed 逐字节一致，零改动）
      imageUrl.value = `local-file:///${encodeURIComponent(absPath)}`
    }
  }

  /** img onerror：白名单 403 / 文件损坏 / 签名 URL 过期 → 标记失败降级占位 */
  function onImageError(): void {
    imageLoadFailed.value = true
  }

  // 切文件时重新加载图片（immediate 保证首次挂载也触发，替代原 computed 的惰性求值）
  watch(
    () => state.value.path,
    () => {
      void loadImage()
    },
    { immediate: true },
  )

  return { imageUrl, imageLoadFailed, onImageError }
}
