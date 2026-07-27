/**
 * virtua mock helper（cw wave w2 / W2CO5）：createMockVlist 工厂共享文件。
 *
 * 多个 virtua 相关单测（use-virtua-follow / use-message-stream-rail-virtua）都需要构造一个
 * 满足 VirtualizerHandle 接口的 mock 对象（happy-dom 下真实 Virtualizer 行为不可控）。
 * 提取至此避免重复定义。导出 createMockVlist，签名与 w1 实现一致（向后兼容）。
 */
import { vi } from 'vitest'
import type { VirtualizerHandle } from 'virtua/vue'

/** 默认 mock 几何（distance = scrollSize - scrollOffset - viewportSize = 0，即默认贴底） */
const DEFAULT_SCROLL_SIZE = 1000
const DEFAULT_SCROLL_OFFSET = 500
const DEFAULT_VIEWPORT_SIZE = 500
/** findItemIndex 默认返回值（mock 5 项数据：末项 index=4，中间 index=2） */
const DEFAULT_LAST_INDEX = 4
const DEFAULT_MID_INDEX = 2

/**
 * mock 工厂（contract W1CO2）：造一个满足 VirtualizerHandle 接口的 mock 对象。
 * 默认 scrollSize/scrollOffset/viewportSize 使 distance=0（默认贴底）；其余方法为 vi.fn()，可被断言。
 */
export function createMockVlist(
  overrides?: Partial<{
    scrollSize: number
    scrollOffset: number
    viewportSize: number
    scrollToIndex: ReturnType<typeof vi.fn>
    getItemOffset: ReturnType<typeof vi.fn>
    getItemSize: ReturnType<typeof vi.fn>
    findItemIndex: ReturnType<typeof vi.fn>
  }>,
): VirtualizerHandle {
  const scrollSize = overrides?.scrollSize ?? DEFAULT_SCROLL_SIZE
  const scrollOffset = overrides?.scrollOffset ?? DEFAULT_SCROLL_OFFSET
  const viewportSize = overrides?.viewportSize ?? DEFAULT_VIEWPORT_SIZE
  return {
    scrollSize,
    scrollOffset,
    viewportSize,
    cache: {} as unknown as VirtualizerHandle['cache'],
    scrollToIndex: overrides?.scrollToIndex ?? vi.fn(),
    getItemOffset: overrides?.getItemOffset ?? vi.fn(),
    getItemSize: overrides?.getItemSize ?? vi.fn(),
    findItemIndex:
      overrides?.findItemIndex ??
      vi.fn((offset: number) => {
        // 默认：把 offset 当作末尾位置，返回一个稳定的 last index（mock 5 项数据 → last index）
        return offset >= scrollSize ? DEFAULT_LAST_INDEX : DEFAULT_MID_INDEX
      }),
    // 额外 API（VirtualizerHandle 接口要求实现）
    scrollTo: vi.fn(),
    scrollBy: vi.fn(),
  } satisfies VirtualizerHandle
}
