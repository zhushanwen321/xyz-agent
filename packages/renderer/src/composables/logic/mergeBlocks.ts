/**
 * 连续同类块合并纯逻辑（R2 logic 层，纯函数无副作用，无 Vue 响应式）。
 *
 * 用途：Turn trace 区把「连续的正常 thinking」或「连续的正常 tool」折成一个可展开的
 * merged 块，压缩视觉噪声（draft-message-stream w2）。text 块是最终输出，永远独立；
 * 失败 tool 需单独醒目展示，断开合并链让用户一眼看到错误位置。
 */
import type { OrderedBlock } from './messageTurns'

/** 未参与合并的独立块（text、失败 tool、孤立单个 thinking/tool）。 */
export interface MergedBlockSingle {
  kind: 'single'
  type: 'thinking' | 'tool' | 'text'
  block: OrderedBlock
}

/**
 * 连续同类块的合并组（>=2 个）。
 * type 限定为 thinking|tool：text 永不合并、失败 tool 永不并入组，
 * 故 merged 组只可能由这两种 kind 构成。
 */
export interface MergedBlockGroup {
  kind: 'merged'
  type: 'thinking' | 'tool'
  items: OrderedBlock[]
}

export type MergedBlock = MergedBlockSingle | MergedBlockGroup

/**
 * 失败判断——与 Block.vue L198 同源：status==='error' 视为失败。
 * 失败块独立输出，不参与任何合并（错误需醒目单独展示，不应被埋进折叠组里）。
 */
function isFailedTool(block: OrderedBlock): boolean {
  // text（ref:string）和 thinking 直接跳过；仅 tool 需查 status
  if (block.kind !== 'tool') return false
  const ref = block.ref as { status?: string }
  return ref.status === 'error'
}

/**
 * 把待合并缓冲 currentGroup flush 成输出项。
 * - 0 个：不输出
 * - 1 个：作为 single 输出（type 取该块 kind）
 * - >=2 个：作为 merged 输出（type 取首块 kind，仅可能 thinking|tool——
 *   text/失败块永远不进 currentGroup，故此处 type 收窄安全）
 */
function flush(currentGroup: OrderedBlock[]): MergedBlock[] {
  if (currentGroup.length === 0) return []
  if (currentGroup.length === 1) {
    const block = currentGroup[0]
    return [{ kind: 'single', type: block.kind, block }]
  }
  // items 浅拷贝，避免外部改动输入数组影响输出（纯函数契约）
  return [
    {
      kind: 'merged',
      type: currentGroup[0].kind as 'thinking' | 'tool',
      items: currentGroup.slice(),
    },
  ]
}

/**
 * 线性遍历输入，把连续的同类「正常」块（thinking/tool，非失败）折成 merged 组。
 *
 * 决策表：
 * - text：先 flush 缓冲，text 本身独立 single（text 是收尾输出，不合并）
 * - 失败 tool：先 flush 缓冲，失败 tool 独立 single（错误需醒目，断开合并链）
 * - 正常 thinking/tool：同类则并入当前缓冲，异类先 flush 再起新缓冲
 *
 * 纯函数：不修改输入数组（仅读取，items 用 slice 复制）。
 */
export function mergeConsecutiveBlocks(blocks: OrderedBlock[]): MergedBlock[] {
  const result: MergedBlock[] = []
  let currentGroup: OrderedBlock[] = []

  for (const block of blocks) {
    // text 与失败 tool 是「断点」：独立输出，不进 currentGroup
    if (block.kind === 'text' || isFailedTool(block)) {
      result.push(...flush(currentGroup))
      currentGroup = []
      result.push({ kind: 'single', type: block.kind, block })
      continue
    }

    // 正常 thinking/tool：与当前缓冲同类则并入，异类先 flush
    const head = currentGroup[0]
    if (head && head.kind !== block.kind) {
      result.push(...flush(currentGroup))
      currentGroup = []
    }
    currentGroup.push(block)
  }

  // 收尾 flush 残留缓冲
  result.push(...flush(currentGroup))
  return result
}
