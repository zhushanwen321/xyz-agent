/**
 * streaming trace 窗口切片纯逻辑（chat 域 SSOT）。
 *
 * 数据模型：一个 turn 内可能有多条 assistant 消息（subagent 接力 / 多轮补写），
 * 每条 assistant 内部又含 thinking / toolCall / text 有序块（见 message-turns.expandAssistantBlocks）。
 * 渲染 trace 时需要把「跨 assistant 的所有块」拍平成一维时序，再按窗口策略决定哪些可见、
 * 哪些收编（compacted）、哪些是失败块（failed）独立计数。
 *
 * 三个输出语义（TraceWindowResult）：
 * - visible：按 flatIndex 升序的可见块（takeover=false 时由三类互斥块合并；takeover=true 时全量）
 * - compactedCount：被收编的「已完成过程块」数量（非 error、非进行中、非 text 的已定型块，
 *   超出窗口宽度 W 的靠前部分被折叠）。failed 块不计入此计数（见 failedCount）
 * - failedCount：被收编的 status==='error' 的 tool/agentgraph 块数量（失败重试独立计数，
 *   不污染 compactedCount）
 *
 * 归属：chat 域纯函数（零 Vue/renderer 依赖），对齐 w1-w6 chat 域绞杀模式（core SSOT）。
 * ui 包经 @xyz-agent/core/domain/chat 子路径 import。
 */
import type { Message, ToolCall } from '@xyz-agent/shared'
import { expandAssistantBlocks, type OrderedBlock } from './message-turns'

/**
 * 拍平后的渲染块单元。
 * - assistantId：所属 assistant 的 Message.id
 * - assistantStatus：所属 assistant 的 Message.status（MessageStatus，'streaming'|'complete'|'error'）
 * - block：原始有序块（复用 OrderedBlock，kind:'thinking'|'tool'|'text'|'agentgraph'）
 * - flatIndex：全 turn 内一维时序下标（从 0 全局递增，跨 assistant 连续）
 */
export interface FlatBlock {
  assistantId: string
  assistantStatus: Message['status']
  block: OrderedBlock
  flatIndex: number
}

/**
 * 窗口切片结果。
 * - visible：按 flatIndex 升序的可见块
 * - compactedCount：被收编的非 error 已定型过程块数（已完成过程块总数 − visible 内该类数）
 * - failedCount：被收编的 status==='error' 的 tool/agentgraph 块数（不在 visible 内的失败块）
 */
export interface TraceWindowResult {
  visible: FlatBlock[]
  compactedCount: number
  failedCount: number
}

/** 窗口宽度（已完成过程块保留条数）。导出供 window wave 使用。 */
export const W = 8

/**
 * 把多条 assistant Message 的内部块按 contentBlocks 真实时序解出后拍平为一维。
 *
 * 按 assistants 数组顺序遍历，对每个 assistant 调 expandAssistantBlocks(msg)（from './message-turns'），
 * 把返回的 OrderedBlock[] 拼接，每个 block 包装成 FlatBlock，flatIndex 从 0 全局递增（跨 assistant 连续）。
 * 空数组 → 返回 []。纯函数无副作用（不修改入参）。
 */
export function flattenTurnBlocks(assistants: Message[]): FlatBlock[] {
  const result: FlatBlock[] = []
  let flatIndex = 0
  for (const msg of assistants) {
    for (const block of expandAssistantBlocks(msg)) {
      result.push({
        assistantId: msg.id,
        assistantStatus: msg.status,
        block,
        flatIndex,
      })
      flatIndex += 1
    }
  }
  return result
}

/**
 * tool/agentgraph 块是否为失败块（status==='error'）。
 *
 * 注意拼写陷阱：ToolCall 完成态是 'completed'（过去式），Message 完成态是 'complete'（无 d），
 * 两者不一致；failed 判定统一用 ToolCall 的 status==='error'（非 'failed'，ToolCallStatus 无 'failed'）。
 * 铁证：message-turns.ts hasFailedTool 用 t.status === 'error'；shared/message.ts error 字段注释
 * 「与 status:'error' 同源」。
 */
function isFailedProcessBlock(block: OrderedBlock): boolean {
  return (
    (block.kind === 'tool' || block.kind === 'agentgraph') &&
    (block.ref as ToolCall).status === 'error'
  )
}

/**
 * 按窗口策略切片拍平后的块。
 *
 * takeover=true → visible=全部 blocks（按 flatIndex 升序），compactedCount=0，failedCount=0。
 * takeover=false → visible 收集三类互斥块后合并按 flatIndex 升序：
 *   ① 末位 text 块：blocks 中最后一个 kind==='text' 的块（最多 1 个；仅末位 text 作为当前回复锚点
 *      保留全文，非末位 text 不收集——既不归①也不进 visible）
 *   ② 进行中块：对每个 assistantStatus==='streaming' 的 assistant（按 assistantId 分组），取其拍平块中
 *      最后一个 kind ∈ {thinking,tool,agentgraph} 的块（flatIndex 最大者）
 *   ③ 已完成过程块（压缩候选）：所有满足 kind!=='text' 且不在②集合内 且（kind==='thinking' 或
 *      tool/agentgraph 且 status!=='error'）的块；从这池子按 flatIndex 降序取前 windowSize 个
 *   三类按 flatIndex 标识去重后合并，最终按 flatIndex 升序输出。
 * compactedCount = ③候选池总数 − visible 内属于③的数量。
 * failedCount = 所有 tool/agentgraph 且 status==='error' 的块中不在 visible 内的数量。
 *   （若某 error tool 恰好是 streaming assistant 末尾块被②收入 visible，按「不在 visible 内」判定
 *   自然不计入 failedCount，无需特判。）
 * 空 blocks → { visible: [], compactedCount: 0, failedCount: 0 }。纯函数无副作用。
 */
export function computeTraceWindow(
  blocks: FlatBlock[],
  opts: { windowSize: number; takeover: boolean },
): TraceWindowResult {
  if (blocks.length === 0) {
    return { visible: [], compactedCount: 0, failedCount: 0 }
  }

  // takeover=true：全量展开，计数归零（收编区为空）。
  if (opts.takeover) {
    return { visible: [...blocks], compactedCount: 0, failedCount: 0 }
  }

  // ① 末位 text 块（blocks 中最后一个 kind==='text' 的块）。
  // 仅末位 text 作为当前回复锚点保留全文；非末位 text 既不归①也不进 visible（见上文注释）。
  let lastText: FlatBlock | null = null
  for (const fb of blocks) {
    if (fb.block.kind === 'text') lastText = fb
  }

  // ② 进行中块：每个 streaming assistant 取其拍平块中最后一个非 text 块（flatIndex 最大者）。
  const inProgressByAssistant = new Map<string, FlatBlock>()
  for (const fb of blocks) {
    if (fb.assistantStatus === 'streaming' && fb.block.kind !== 'text') {
      const prev = inProgressByAssistant.get(fb.assistantId)
      if (!prev || fb.flatIndex > prev.flatIndex) {
        inProgressByAssistant.set(fb.assistantId, fb)
      }
    }
  }
  const inProgressSet = new Set<number>(
    [...inProgressByAssistant.values()].map((fb) => fb.flatIndex),
  )

  // ③ 已完成过程块（压缩候选）：kind!=='text' 且不在②内 且（thinking 或 tool/agentgraph 非 error）。
  const completedProcessPool: FlatBlock[] = []
  for (const fb of blocks) {
    if (fb.block.kind === 'text') continue
    if (inProgressSet.has(fb.flatIndex)) continue
    if (fb.block.kind === 'thinking' || !isFailedProcessBlock(fb.block)) {
      completedProcessPool.push(fb)
    }
  }
  // 按 flatIndex 降序取前 windowSize 个作为 visible 的③部分。
  const windowed = [...completedProcessPool]
    .sort((a, b) => b.flatIndex - a.flatIndex)
    .slice(0, opts.windowSize)
  const windowedSet = new Set<number>(windowed.map((fb) => fb.flatIndex))

  // 合并三类（按 flatIndex 去重），按 flatIndex 升序输出。
  const merged = new Map<number, FlatBlock>()
  if (lastText) merged.set(lastText.flatIndex, lastText)
  for (const fb of inProgressByAssistant.values()) merged.set(fb.flatIndex, fb)
  for (const fb of windowed) merged.set(fb.flatIndex, fb)
  const visible = [...merged.values()].sort((a, b) => a.flatIndex - b.flatIndex)

  // compactedCount = ③候选池总数 − visible 内属于③的数量。
  const visibleInWindowed = windowed.filter((fb) => merged.has(fb.flatIndex)).length
  const compactedCount = completedProcessPool.length - visibleInWindowed

  // failedCount = 所有 error tool/agentgraph 块中不在 visible 内的数量。
  const visibleSet = new Set(visible.map((fb) => fb.flatIndex))
  let failedCount = 0
  for (const fb of blocks) {
    if (isFailedProcessBlock(fb.block) && !visibleSet.has(fb.flatIndex)) {
      failedCount += 1
    }
  }

  return { visible, compactedCount, failedCount }
}
