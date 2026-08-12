// ============================================================
// workflow 概览解析与渲染（w5 新增，纯逻辑零 IO）
// ============================================================
//
// 本文件消费 discovery/workflows.ts 的 readRunSnapshot（返 unknown 原始快照对象），
// 把 unknown 类型化为 WorkflowOverview（NEW v='wf-run-v1' / OLD 无 v 双格式分支），
// 再渲染为人类可读文本。零 IO：parseRunSnapshot/renderWorkflowOverview 喂 mock 即可单测
//（w5 TC-wf-core-pure-logic，对齐 session-reader core/* 纯逻辑约定）。
//
// 不 import @zhushanwen/pi-subagent-workflow 的 RunSnapshot 类型——跨包类型耦合会使上游
// 升版连带编译期影响本扩展；且上游类型只描述 NEW，OLD 仍需自处理（TC-wf-snapshot-version-union）。
// session-reader 作为纯读取者，按字段存在性 + v 标记分支做「结构化快照」式解析，与上游解耦。

// ---- 类型守卫 helpers ----

/** unknown → Record<string, unknown> 守卫（非对象或 null → false）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 字符串截断（超 max 加省略号）。概览预览用，全文走 detail。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** contentPreview 截断长度（概览预览，全文走 detail）。 */
const CONTENT_PREVIEW_MAX = 120
/** step 行 call sessionId 显示截断长度（uuid 前缀段，LLM 可读）。 */
const SESSION_ID_PREVIEW_MAX = 12

// ---- 数据模型（对齐 m2 slice DM-WorkflowBudget/DM-WorkflowStep/DM-WorkflowOverview）----

/** wf-state budget 尽力提取（OLD budget 结构可能不全，缺字段 undefined）。 */
export interface WorkflowBudget {
  /** NEW state.budget.usedTokens / OLD budget.usedTokens */
  usedTokens?: number
  /** NEW state.budget.usedCost */
  usedCost?: number
  /** NEW state.budget.totalCallCount */
  totalCallCount?: number
  /** NEW state.budget.maxTokens */
  maxTokens?: number
  /** NEW state.budget.maxCost */
  maxCost?: number
  /** NEW state.budget.maxTimeMs */
  maxTimeMs?: number
}

/** workflow 单步（NEW call / OLD callCache entry）。 */
export interface WorkflowStep {
  /** NEW call.id / OLD callCache 顺序索引 */
  index: number
  /** NEW call.status / OLD 推测（有 sessionFile 或 content → 'done'，否则 'pending'） */
  status: 'pending' | 'running' | 'done'
  /** NEW call.opts.description */
  description?: string
  /** NEW call.opts.model */
  model?: string
  /** NEW call.opts.thinkingLevel */
  thinkingLevel?: string
  /** NEW call.attempts / OLD 无 → undefined */
  attempts?: number
  /** NEW call.result.durationMs / OLD value.result.durationMs */
  durationMs?: number
  /** call.sessionId 或 result.sessionId（LLM 跳 outline/detail 的 id 入口） */
  sessionId?: string
  /** call.sessionFile 或 result.sessionFile（LLM 跳 outline/detail 的绝对路径入口，OLD 多数为 undefined） */
  sessionFile?: string
  /** result.content 截断前 120 字（概览预览，全文走 detail） */
  contentPreview?: string
}

/** workflow run 概览（parseRunSnapshot 输出 / renderWorkflowOverview 输入）。 */
export interface WorkflowOverview {
  /** WorkflowRef.runId 透传（与 family.workflows 对齐，不读 snapshot.runId 避免 OLD 不一致） */
  runId: string
  /** WorkflowRef.stateFile 透传 */
  stateFile: string
  /** NEW state.status / OLD 顶层 status */
  status: string
  /** 格式标记（渲染/调试用） */
  version: 'wf-run-v1' | 'legacy'
  /** NEW spec.scriptName / spec.name / OLD name */
  script?: string
  /** NEW meta.startedAt / OLD startedAt（统一 string） */
  startedAt?: string
  /** NEW meta.completedAt */
  completedAt?: string
  /** NEW state.reason */
  reason?: string
  /** NEW state.error */
  error?: string
  budget: WorkflowBudget
  steps: WorkflowStep[]
}

// ---- 解析 helpers（call/cache entry → WorkflowStep）----

/** 把 budget 原始对象收窄为 WorkflowBudget（各字段类型校验，非 number → undefined）。 */
function mapBudget(b: Record<string, unknown>): WorkflowBudget {
  return {
    usedTokens: typeof b.usedTokens === 'number' ? b.usedTokens : undefined,
    usedCost: typeof b.usedCost === 'number' ? b.usedCost : undefined,
    totalCallCount: typeof b.totalCallCount === 'number' ? b.totalCallCount : undefined,
    maxTokens: typeof b.maxTokens === 'number' ? b.maxTokens : undefined,
    maxCost: typeof b.maxCost === 'number' ? b.maxCost : undefined,
    maxTimeMs: typeof b.maxTimeMs === 'number' ? b.maxTimeMs : undefined,
  }
}

/** NEW state.calls[] 单项 → WorkflowStep。sessionFile/sessionId 顶层优先回退 result。 */
function mapCallToStep(call: unknown, fallbackIndex: number): WorkflowStep {
  if (!isRecord(call)) return { index: fallbackIndex, status: 'pending' }
  const opts = isRecord(call.opts) ? call.opts : {}
  const result = isRecord(call.result) ? call.result : {}

  const index = typeof call.id === 'number' ? call.id : fallbackIndex
  const rawStatus = typeof call.status === 'string' ? call.status : ''
  const status: WorkflowStep['status'] =
    rawStatus === 'done' || rawStatus === 'running' || rawStatus === 'pending'
      ? rawStatus
      : 'pending'

  const sessionFile =
    typeof call.sessionFile === 'string'
      ? call.sessionFile
      : typeof result.sessionFile === 'string'
        ? result.sessionFile
        : undefined
  const sessionId =
    typeof call.sessionId === 'string'
      ? call.sessionId
      : typeof result.sessionId === 'string'
        ? result.sessionId
        : undefined
  const content = typeof result.content === 'string' ? result.content : undefined

  return {
    index,
    status,
    description: typeof opts.description === 'string' ? opts.description : undefined,
    model: typeof opts.model === 'string' ? opts.model : undefined,
    thinkingLevel: typeof opts.thinkingLevel === 'string' ? opts.thinkingLevel : undefined,
    attempts: typeof call.attempts === 'number' ? call.attempts : undefined,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : undefined,
    sessionId,
    sessionFile,
    contentPreview: content !== undefined ? truncate(content, CONTENT_PREVIEW_MAX) : undefined,
  }
}

/** OLD callCache[] 单项 {key, value} → WorkflowStep。status 推测，content 优先 result 回退 value。 */
function mapCacheEntryToStep(entry: unknown, index: number): WorkflowStep {
  if (!isRecord(entry)) return { index, status: 'pending' }
  const value = isRecord(entry.value) ? entry.value : {}
  const result = isRecord(value.result) ? value.result : {}

  // sessionFile: value.sessionFile 或 value.result.sessionFile（OLD 多数缺失，探针 112 文件 0）
  const sessionFile =
    typeof value.sessionFile === 'string'
      ? value.sessionFile
      : typeof result.sessionFile === 'string'
        ? result.sessionFile
        : undefined
  const sessionId =
    typeof value.sessionId === 'string'
      ? value.sessionId
      : typeof result.sessionId === 'string'
        ? result.sessionId
        : undefined
  // content：真实 OLD 数据 value.content（wf-skip-ok）与测试 fixture value.result.content 并存
  const content =
    typeof result.content === 'string'
      ? result.content
      : typeof value.content === 'string'
        ? value.content
        : undefined
  // OLD 无 status 字段：有 sessionFile 或非空 content → done，否则 pending
  //（空 content 如 wf-skip-ok 的 '' 不算完成标志，对齐 TC-w5-parse-old expected status='pending'；
  // content 仍提取为 contentPreview=''）
  const hasContent = content !== undefined && content.length > 0
  const status: WorkflowStep['status'] =
    sessionFile !== undefined || hasContent ? 'done' : 'pending'

  return {
    index,
    status,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : undefined,
    sessionId,
    sessionFile,
    contentPreview: content !== undefined ? truncate(content, CONTENT_PREVIEW_MAX) : undefined,
  }
}

// ---- parseRunSnapshot（unknown → WorkflowOverview | null）----

/**
 * 把 readRunSnapshot 返回的原始快照对象类型化为 WorkflowOverview（纯逻辑零 IO）。
 *
 * 分支（C-parserunsnapshot-dualformat，TC-wf-snapshot-version-union）：
 * - 非对象 → null（调用方跳过，ES-wf-snapshot-unparseable）
 * - NEW (snapshot.v === 'wf-run-v1')：state.* / meta.* / spec.*
 * - OLD (无 v，有 callCache 数组或顶层 status)：顶层 status/budget/startedAt + callCache
 * - 既非 NEW 也非 OLD → null（未来版本 wf-run-v2 / 异构内容）
 *
 * runId/stateFile 透传参数（不读 snapshot.runId，保证与 family.workflows 一致，避免 OLD 顶层
 * runId 可信度低的不一致）。零 any（全程 typeof/Array.isArray/isRecord 守卫收窄）。
 */
export function parseRunSnapshot(
  snapshot: unknown,
  runId: string,
  stateFile: string,
): WorkflowOverview | null {
  if (!isRecord(snapshot)) return null

  // NEW 格式（v === 'wf-run-v1'）
  if (snapshot.v === 'wf-run-v1') {
    const state = isRecord(snapshot.state) ? snapshot.state : {}
    const meta = isRecord(snapshot.meta) ? snapshot.meta : {}
    const spec = isRecord(snapshot.spec) ? snapshot.spec : {}
    const callsRaw = Array.isArray(state.calls) ? state.calls : []
    return {
      runId,
      stateFile,
      status: typeof state.status === 'string' ? state.status : '',
      version: 'wf-run-v1',
      script:
        typeof spec.scriptName === 'string'
          ? spec.scriptName
          : typeof spec.name === 'string'
            ? spec.name
            : undefined,
      startedAt: typeof meta.startedAt === 'string' ? meta.startedAt : undefined,
      completedAt: typeof meta.completedAt === 'string' ? meta.completedAt : undefined,
      reason: typeof state.reason === 'string' ? state.reason : undefined,
      error: typeof state.error === 'string' ? state.error : undefined,
      budget: mapBudget(isRecord(state.budget) ? state.budget : {}),
      steps: callsRaw.map((c, i) => mapCallToStep(c, i)),
    }
  }

  // OLD 格式（无 v，有 callCache 数组或顶层 status 字符串）
  if (Array.isArray(snapshot.callCache) || typeof snapshot.status === 'string') {
    const callCacheRaw = Array.isArray(snapshot.callCache) ? snapshot.callCache : []
    return {
      runId,
      stateFile,
      status: typeof snapshot.status === 'string' ? snapshot.status : '',
      version: 'legacy',
      script: typeof snapshot.name === 'string' ? snapshot.name : undefined,
      startedAt: typeof snapshot.startedAt === 'string' ? snapshot.startedAt : undefined,
      budget: mapBudget(isRecord(snapshot.budget) ? snapshot.budget : {}),
      steps: callCacheRaw.map((c, i) => mapCacheEntryToStep(c, i)),
    }
  }

  return null
}

// ---- renderWorkflowOverview（WorkflowOverview → 人类可读文本）----

/**
 * 渲染 WorkflowOverview 为人类可读文本（纯逻辑零 IO）。
 *
 * 输出结构（IF-renderWorkflowOverview）：
 * - 头行：`run: <runId> [status] (script?) started=<ISO> completed?=<ISO> reason?`
 * - budget 行：`budget: used=<tokens>tok $<cost> calls=<n> / max=<tokens>tok $<cost> <timeMs>ms`
 *   （缺省字段省略，不输出 undefined 字面量）
 * - steps 块每行：`  #<index> [status] <description> · model=<model> · <durationMs>ms ·
 *   attempts=<n> · call=<sessionId截断> <sessionFile>`
 *   sessionFile 缺则标 `（无 sessionFile，OLD 格式未持久化）`（TC-wf-step-sessionfile-link）
 * - error 行（如有 state.error）
 *
 * 每个 step 的 call sessionId/sessionFile 是 LLM 跳 outline/detail 的入口（m0 resolveSessionId
 * 三形态：sessionId/绝对路径/sa-id 均可深读）。多 run 场景由 doWorkflow 循环拼接多段（w6）。
 */
export function renderWorkflowOverview(overview: WorkflowOverview): string {
  const lines: string[] = []

  // 头行
  const headParts = [`run: ${overview.runId}`, `[${overview.status}]`]
  if (overview.script) headParts.push(`(${overview.script})`)
  if (overview.startedAt) headParts.push(`started=${overview.startedAt}`)
  if (overview.completedAt) headParts.push(`completed=${overview.completedAt}`)
  if (overview.reason) headParts.push(`reason=${overview.reason}`)
  lines.push(headParts.join(' '))

  // budget 行（缺字段省略）
  const budgetParts: string[] = ['budget:']
  if (overview.budget.usedTokens !== undefined) budgetParts.push(`used=${overview.budget.usedTokens}tok`)
  if (overview.budget.usedCost !== undefined) budgetParts.push(`$${overview.budget.usedCost}`)
  if (overview.budget.totalCallCount !== undefined) budgetParts.push(`calls=${overview.budget.totalCallCount}`)
  const hasMax =
    overview.budget.maxTokens !== undefined ||
    overview.budget.maxCost !== undefined ||
    overview.budget.maxTimeMs !== undefined
  if (hasMax) {
    const maxParts: string[] = ['/ max=']
    if (overview.budget.maxTokens !== undefined) maxParts.push(`${overview.budget.maxTokens}tok`)
    if (overview.budget.maxCost !== undefined) maxParts.push(`$${overview.budget.maxCost}`)
    if (overview.budget.maxTimeMs !== undefined) maxParts.push(`${overview.budget.maxTimeMs}ms`)
    budgetParts.push(maxParts.join(''))
  }
  lines.push(budgetParts.join(' '))

  // steps 块
  for (const step of overview.steps) {
    const stepParts = [`  #${step.index}`, `[${step.status}]`]
    if (step.description) stepParts.push(step.description)
    const tail: string[] = []
    if (step.model) tail.push(`model=${step.model}`)
    if (step.durationMs !== undefined) tail.push(`${step.durationMs}ms`)
    if (step.attempts !== undefined) tail.push(`attempts=${step.attempts}`)
    if (step.sessionId) tail.push(`call=${truncate(step.sessionId, SESSION_ID_PREVIEW_MAX)}`)
    let line = stepParts.join(' ')
    if (tail.length > 0) line += ' · ' + tail.join(' · ')
    if (step.sessionFile) {
      line += ' ' + step.sessionFile
    } else {
      line += ' （无 sessionFile，OLD 格式未持久化）'
    }
    lines.push(line)
  }

  // error 行
  if (overview.error) lines.push(`error: ${overview.error}`)

  return lines.join('\n')
}
