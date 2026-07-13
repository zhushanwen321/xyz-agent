/**
 * Workflow 提取器 —— 从主 session JSONL 提取 WorkflowRunRecord[]。
 *
 * 数据来源：主 session JSONL 中的 `workflow-state-link` custom_message entry。
 * pi-subagent-workflow 扩展注册了 `workflow` tool，主 agent 调用时会启动一个
 * 在独立 worker 线程执行的 workflow run。
 *
 * JSONL 中的 entry 模式（pi-subagent-workflow）：
 * 1. custom_message customType:'workflow-state-link' 含 data:{runId, path, updatedAt}
 *    —— path 指向 workflow-state 文件的绝对路径。每次 RunStore.save 都 append 一条，
 *    同 runId 可有多条（去重保留最新 updatedAt 的 path）。
 * 2. workflow-state 文件（<sessionDir>/workflow-state/<runId>.jsonl）：
 *    单行 RunSnapshot（rewrite mode，文件始终是最新单行快照）。
 *    格式版本：v === 'wf-run-v1'（D-5 版本守卫，不匹配跳过）。
 *
 * 提取策略：
 * - 遍历所有 custom_message entry，收集 workflow-state-link（按 runId 去重，保留最新 path）
 * - 逐个读 path 指向的 state 文件，取最后一行（rewrite mode = 最新快照）
 * - 版本守卫（v !== 'wf-run-v1' 跳过，D-5 不向后兼容）
 * - 映射 RunSnapshot → WorkflowRunRecord
 *
 * agent call 对话流：trace[].sessionId 是 pi session ID（uuidv7），
 * SessionService.getAgentCallHistory 按 sessionId 全局查找 JSONL 文件
 * （scanPiSessions 扫所有 encodedCwd 子目录）。
 *
 * 参考扩展源码：
 * - extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts（RunSnapshot 格式 + SNAPSHOT_VERSION）
 * - extensions/subagent-workflow/src/orchestration/models/workflow-run.ts（WorkflowRun 聚合根）
 * - extensions/subagent-workflow/src/orchestration/models/types.ts（RunStatus/DoneReason/AgentResult）
 */

import { readFileSync } from 'node:fs'
import { parseJsonl } from '../../utils/jsonl.js'
import type {
  WorkflowRunRecord,
  WorkflowAgentCall,
  WorkflowRunStatus,
  WorkflowDoneReason,
} from '@xyz-agent/shared'

/** RunSnapshot 格式版本（对齐扩展的 SNAPSHOT_VERSION）。版本不匹配跳过（D-5）。 */
const SNAPSHOT_VERSION = 'wf-run-v1'

/** workflow-state-link entry 的 data 结构 */
interface WorkflowStateLinkData {
  runId: string
  path: string
  updatedAt?: string
}

/** JSONL 中的 custom_message entry 结构（简化） */
interface JsonlCustomEntry {
  type: string
  customType?: string
  data?: unknown
}

/** RunSnapshot.state.budget 结构 */
interface SnapshotBudget {
  maxTokens?: number
  maxCost?: number
  maxTimeMs?: number
  usedTokens: number
  usedCost: number
  totalCallCount?: number
}

/** RunSnapshot.state.trace[] 节点结构（RunSnapshot 序列化时 strip live 字段） */
interface SnapshotTraceNode {
  stepIndex: number
  agent: string
  task?: string
  model?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  phase?: string
  startedAt?: string
  completedAt?: string
  sessionId?: string
  result?: {
    content?: string
    usage?: {
      input?: number
      output?: number
      turns?: number
    }
    durationMs?: number
    error?: string
    sessionId?: string
  }
  error?: string
}

/** RunSnapshot 顶层结构（对齐扩展 jsonl-run-store.ts 的 RunSnapshot interface） */
interface RunSnapshot {
  v: string
  runId: string
  spec: {
    scriptSource?: string
    args?: Record<string, unknown>
    scriptName: string
    slug?: string
    scriptPath?: string
    description?: string
  }
  state: {
    status: 'running' | 'paused' | 'done'
    reason?: WorkflowDoneReason
    budget: SnapshotBudget
    calls: unknown[]
    trace: SnapshotTraceNode[]
    errorLogs?: unknown[]
    error?: string
    scriptResult?: unknown
  }
  meta: {
    startedAt: string
    completedAt?: string
    pausedAt?: string
    workerErrorCount?: number
    scriptErrorCount?: number
  }
}

/**
 * 从主 session JSONL 文件提取 WorkflowRunRecord[]。
 *
 * 读取文件 → parseJsonl → filter workflow-state-link → 按 runId 去重 →
 * 逐个读 state 文件 → 版本守卫 → 映射 → 返回列表。
 * 文件不存在或无 workflow-state-link 时返回空数组。
 */
export function extractWorkflowsFromSessionFile(filePath: string): WorkflowRunRecord[] {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const entries = parseJsonl(content)

  // 收集 workflow-state-link，按 runId 去重（保留最新 path）
  const links = new Map<string, string>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as JsonlCustomEntry
    if (e.type !== 'custom_message' || e.customType !== 'workflow-state-link') continue
    const data = e.data as WorkflowStateLinkData | undefined
    if (!data?.runId || !data?.path) continue
    // 同 runId 后出现的覆盖前面的（JSONL 顺序 = 时间顺序，后者更新）
    links.set(data.runId, data.path)
  }

  if (links.size === 0) return []

  // 逐个读 state 文件，映射 RunSnapshot → WorkflowRunRecord
  const records: WorkflowRunRecord[] = []
  for (const [runId, stateFilePath] of links) {
    const record = readAndMapSnapshot(runId, stateFilePath)
    if (record) records.push(record)
  }

  return records
}

/**
 * 读 workflow-state 文件 + 映射为 WorkflowRunRecord。
 * 文件不存在 / 解析失败 / 版本不匹配 → 返回 null（跳过该 run）。
 */
function readAndMapSnapshot(runId: string, stateFilePath: string): WorkflowRunRecord | null {
  let content: string
  try {
    content = readFileSync(stateFilePath, 'utf-8')
  } catch {
    // state 文件不存在或不可读（已被清理 / 并发删除）
    return null
  }

  // rewrite mode：文件始终是最新单行快照。取最后一个非空行。
  const lines = content.split('\n').filter((l) => l.trim())
  const lastLine = lines[lines.length - 1]
  if (!lastLine) return null

  let snapshot: RunSnapshot
  try {
    snapshot = JSON.parse(lastLine) as RunSnapshot
  } catch {
    // JSON 解析失败（损坏的 state 文件）
    return null
  }

  // D-5 版本守卫：版本不匹配跳过（旧格式不向后兼容）
  if (snapshot.v !== SNAPSHOT_VERSION) return null

  return mapSnapshotToRecord(snapshot, stateFilePath)
}

/** 映射 RunSnapshot → WorkflowRunRecord（含 trace → agentCalls 映射） */
function mapSnapshotToRecord(snapshot: RunSnapshot, stateFilePath: string): WorkflowRunRecord {
  const agentCalls: WorkflowAgentCall[] = (snapshot.state.trace ?? []).map(mapTraceNode)

  return {
    runId: snapshot.runId,
    scriptName: snapshot.spec.scriptName,
    slug: snapshot.spec.slug,
    description: snapshot.spec.description,
    status: snapshot.state.status as WorkflowRunStatus,
    reason: snapshot.state.reason,
    startedAt: snapshot.meta.startedAt,
    completedAt: snapshot.meta.completedAt,
    pausedAt: snapshot.meta.pausedAt,
    usedTokens: snapshot.state.budget?.usedTokens,
    totalCallCount: snapshot.state.budget?.totalCallCount,
    agentCalls,
    stateFilePath,
  }
}

/** 映射单个 trace 节点 → WorkflowAgentCall */
function mapTraceNode(node: SnapshotTraceNode): WorkflowAgentCall {
  const usage = node.result?.usage
  return {
    id: node.stepIndex,
    agent: node.agent,
    phase: node.phase,
    status: node.status,
    model: node.model,
    sessionId: node.sessionId ?? node.result?.sessionId,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    durationMs: node.result?.durationMs,
    inputTokens: usage?.input,
    outputTokens: usage?.output,
    turns: usage?.turns,
    // 顶层 error 优先于 result.error（顶层 error 是 dispatchAgentCall 写的运行期错误）
    error: node.error ?? node.result?.error,
  }
}
