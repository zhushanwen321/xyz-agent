/**
 * useTailScroll — 双轴尾部追踪 composable（W4 流式 block 尾部追踪）。
 *
 * 机制按频率分层（D4 节）：
 * - 横向（高频 delta，不补间）：视口元素 scrollLeft = scrollWidth 即时钉右，
 *   rAF 内执行（节流合并同帧多次更新）。
 * - 纵向（低频换行，补间）：内容容器 transform: translateY(-(N-1)*行高) 钉最新行，
 *   配 CSS transition 120ms。
 *
 * 降级开关 disableScroll：纯尾行 slice 瞬切（无滚动无 transform），
 * 适用于 reduced-motion 或特殊场景。
 *
 * 环境防御：jsdom 下 scrollWidth/clientWidth 为 0，元素不存在/未挂载时跳过。
 */
import { type ComputedRef, type Ref, computed, nextTick, watch } from 'vue'

/** useTailScroll 选项 */
export interface UseTailScrollOptions {
  /** 视口元素 ref（横向滚动目标）。span/div 带 overflow-x: hidden/scroll。 */
  viewportRef: Ref<HTMLElement | undefined>
  /** 降级开关：纯尾行 slice 瞬切（无滚动无 transform） */
  disableScroll?: boolean
  /** 单行高度（px），用于纵向 translateY 计算。默认 20。 */
  lineHeight?: number
}

/** useTailScroll 返回值 */
export interface UseTailScrollReturn {
  /** 当前应渲染的行（tailLines 截取结果，直接 v-for 渲染） */
  displayLines: ComputedRef<string[]>
  /** 纵向 transform + transition style（绑定到内容容器 :style） */
  contentStyle: ComputedRef<Record<string, string>>
}

const DEFAULT_LINE_HEIGHT = 20

/**
 * 双轴尾部追踪 composable。
 *
 * @param rawLines - 原始行数组（如 tailLines(content, 3) 的结果）
 * @param options  - 选项（viewportRef 必填）
 * @returns displayLines（渲染用） + contentStyle（:style 绑定用）
 *
 * @example
 * ```ts
 * const viewportRef = ref<HTMLElement>()
 * const contentRef = ref<HTMLElement>()
 * const lines = computed(() => tailLines(content.value, 3))
 * const { displayLines, contentStyle } = useTailScroll(lines, {
 *   viewportRef,
 *   contentRef,
 *   lineHeight: 20,
 * })
 * ```
 */
export function useTailScroll(
  rawLines: Ref<string[]> | ComputedRef<string[]>,
  options: UseTailScrollOptions,
): UseTailScrollReturn {
  const { viewportRef, disableScroll = false, lineHeight = DEFAULT_LINE_HEIGHT } = options

  // displayLines：直接透传 rawLines（composable 不截取，由调用方 tailLines 控制行数）
  const displayLines = computed(() => rawLines.value)

  // 纵向 transform style：N 行只显示最新 1 行 → translateY(-(N-1)*行高)
  const contentStyle = computed<Record<string, string>>(() => {
    if (disableScroll) return {} as Record<string, string>
    const n = rawLines.value.length
    if (n <= 1) return {} as Record<string, string>
    const offsetY = (n - 1) * lineHeight
    return {
      transform: `translateY(-${offsetY}px)`,
      transition: 'transform var(--duration-fast) var(--ease)',
    } as Record<string, string>
  })

  // 横向 + 纵向 DOM 操作：watch rawLines → nextTick → rAF 内执行
  watch(
    rawLines,
    () => {
      if (disableScroll) return

      nextTick(() => {
        requestAnimationFrame(() => {
          // 横向：scrollLeft = scrollWidth（钉右）
          const viewport = viewportRef.value
          if (viewport) {
            const { scrollWidth, clientWidth } = viewport
            // jsdom 防御：scrollWidth/clientWidth 为 0 时跳过
            if (scrollWidth > 0 && clientWidth > 0 && scrollWidth > clientWidth) {
              viewport.scrollLeft = scrollWidth
            }
          }
        })
      })
    },
    { flush: 'post' },
  )

  return { displayLines, contentStyle }
}
