/**
 * compute-layers —— 时间戳区间重叠分层纯函数（workflow DAG 可视化 W1 wave）。
 *
 * 算法目标：把 workflow run 的 agent calls（trace 节点）按执行时间区间分层。
 * 同一层内的节点 = 执行区间相互重叠 = 视为并发簇（可视化时横向并排）；
 * 不同层 = 时间上串行（可视化时纵向分层）。这就是「时间戳分层」算法。
 *
 * 纯逻辑层，零 Vue 依赖：parseT / computeLayers 可在任何上下文（Node、worker、
 * W3 Gantt 视图）复用。不 import vue。
 *
 * 区间右端 end 的计算（按优先级）：
 * - running 节点：end = Date.now()（running 无 durationMs，用当前时间表示「进行中」）
 * - 有 durationMs：end = parseT(startedAt) + durationMs
 * - failed 且无 durationMs 但有 completedAt：end = parseT(completedAt)
 * - 都没有：end = parseT(startedAt)（独占，不与任何节点重叠）
 *
 * 重叠判定：parseT(n.startedAt) < prevEnd（严格小于）→ 重叠，n 归入 currentLayer。
 * 否则（>=，包括首尾相接）→ 不重叠，currentLayer 入栈，n 开新层。
 *
 * 边界 case（不抛异常）：
 * - 空输入 → { layers: [], pendingNodes: [] }
 * - 全 pending → { layers: [], pendingNodes: <全部> }
 * - 非法 ISO → parseT 返回 -1，排序沉底，独占一层不参与重叠判定
 */
import type { WorkflowAgentCall } from '@xyz-agent/shared'

/** 分层结果中的单层。同层节点 = 执行区间相互重叠 = 并发。 */
export interface ExecutionLayer {
  /** 层序号（0 起） */
  index: number
  /** phase 名（取该层第一个节点的 phase）或「层 N」 */
  label: string
  /** 该层节点（同层=并发） */
  nodes: WorkflowAgentCall[]
  /** 是否并发层（nodes.length > 1） */
  isParallel: boolean
}

/** computeLayers 返回值：分层结果 + 排除的 pending 节点。 */
export interface ComputeLayersResult {
  layers: ExecutionLayer[]
  /** pending 节点（无 startedAt）不参与分层，原样返回供 UI 单独渲染 */
  pendingNodes: WorkflowAgentCall[]
}

/**
 * 时间解析。new Date(iso).getTime()，若 iso 为空或解析结果 isNaN 返回 -1
 * （-1 让节点在升序排序中沉底，并独占一层不参与重叠判定）。
 *
 * export 供 W3 Gantt 视图复用（统一时间解析口径）。
 */
export function parseT(iso: string | undefined): number {
  if (!iso) {
    return -1
  }
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? -1 : t
}

/**
 * 计算节点执行区间的右端 end（毫秒时间戳）。
 * 按优先级：running > durationMs > failed+completedAt > 独占（end=start）。
 */
function computeEnd(node: WorkflowAgentCall): number {
  const start = parseT(node.startedAt)
  // running 无 durationMs，用当前时间表示「进行中」（区间右端随时间推进）
  if (node.status === 'running') {
    return Date.now()
  }
  // 有 durationMs：end = start + duration
  if (typeof node.durationMs === 'number') {
    return start + node.durationMs
  }
  // failed 且无 durationMs 但有 completedAt：用 completedAt 作为区间右端
  if (node.status === 'failed' && node.completedAt) {
    return parseT(node.completedAt)
  }
  // 都没有：独占（end = start，不与任何节点重叠，因 start >= start 不成立严格小于）
  return start
}

/**
 * 时间戳区间重叠分层。
 *
 * @param nodes workflow run 的 agent calls（trace 节点）
 * @returns { layers, pendingNodes }
 *   - layers：分层结果（按时间升序），同层=并发
 *   - pendingNodes：无 startedAt 的 pending 节点，不参与分层
 */
export function computeLayers(nodes: WorkflowAgentCall[]): ComputeLayersResult {
  // 空输入守卫
  if (!nodes || nodes.length === 0) {
    return { layers: [], pendingNodes: [] }
  }

  // 分离 pending 节点（无 startedAt）——不参与分层
  const pendingNodes: WorkflowAgentCall[] = []
  const activeNodes: WorkflowAgentCall[] = []
  for (const n of nodes) {
    if (!n.startedAt) {
      pendingNodes.push(n)
    } else {
      activeNodes.push(n)
    }
  }

  // 全 pending（或无 active 节点）→ 无层
  if (activeNodes.length === 0) {
    return { layers: [], pendingNodes }
  }

  // 按 startedAt 升序排序。parseT 返回 -1（非法时间）的节点须沉底（独占一层），
  // 故比较时把 -1 当作 +∞（升序中排末尾）。parseT 仍返回 -1（w3 Gantt 复用契约不变）。
  const sorted = [...activeNodes].sort((a, b) => {
    const ta = parseT(a.startedAt)
    const tb = parseT(b.startedAt)
    const sa = ta === -1 ? Number.POSITIVE_INFINITY : ta
    const sb = tb === -1 ? Number.POSITIVE_INFINITY : tb
    return sa - sb
  })

  // 先按重叠规则把节点分到各层（每层是 WorkflowAgentCall[]），最后再映射为 ExecutionLayer。
  const rawLayers: WorkflowAgentCall[][] = []
  let currentLayer: WorkflowAgentCall[] = [sorted[0]]
  // 当前层的「右端」= 层内所有节点 end 的最大值（簇内任一节点仍 active 都算重叠延续）
  let currentLayerEnd = computeEnd(sorted[0])

  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]
    const nStart = parseT(n.startedAt)
    const nEnd = computeEnd(n)

    // 非法时间（-1）的节点独占一层，不参与重叠判定
    if (nStart === -1) {
      // 先收尾当前层
      rawLayers.push(currentLayer)
      currentLayer = [n]
      currentLayerEnd = nEnd
      continue
    }

    // 重叠判定：n.start < 当前层右端 → 归入当前层
    if (nStart < currentLayerEnd) {
      currentLayer.push(n)
      // 扩展当前层右端（取较大者，簇内最长 active 区间决定层边界）
      if (nEnd > currentLayerEnd) {
        currentLayerEnd = nEnd
      }
    } else {
      // 不重叠（>=，含首尾相接）：当前层入栈，n 开新层
      rawLayers.push(currentLayer)
      currentLayer = [n]
      currentLayerEnd = nEnd
    }
  }
  // 收尾最后一层
  rawLayers.push(currentLayer)

  // 映射为 ExecutionLayer（带 index/label/isParallel）
  const result: ExecutionLayer[] = rawLayers.map((nodesInLayer, index) => {
    const firstPhase = nodesInLayer[0]?.phase
    return {
      index,
      label: firstPhase ?? `层${index}`,
      nodes: nodesInLayer,
      isParallel: nodesInLayer.length > 1,
    }
  })

  return { layers: result, pendingNodes }
}
