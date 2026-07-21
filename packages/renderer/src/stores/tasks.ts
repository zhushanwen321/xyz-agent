/**
 * Tasks store —— 按 sessionId 分区缓存 goal/todo 的 GuiComponent 快照。
 *
 * 数据源：
 * - todo：todo tool 调用返回的 details.__gui__（list-tree GuiComponent）
 * - goal：goal_control tool 调用返回的 details.__gui__（card / stats-line GuiComponent）
 *         + goal extension 主动推送的 ANSI widget（extension:widget widgetKey='goal'）解析出的实时字段
 *
 * 范式对齐 chat.ts 的 chatSessions: Map<sessionId, ...>：所有读写按 sessionId 分区。
 * 读 API 在 session 不存在时返回 undefined / 零值（不自动创建空条目）；
 * 写 API 在 session 不存在时先创建空 SessionTasksState 再写入。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 *
 * 响应式策略：sessions 是 ref<Map>，所有变更走「取出 → 浅拷贝 → 改 → new Map → 赋值 .value」
 * 的不可变更新（对齐 chat.ts 的 Map 集合响应性范式）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { Message, ToolCall } from '@xyz-agent/shared'

// ── 常量 ────────────────────────────────────────────

/** 百分比乘子：比率 (0-1) → 百分比 (0-100) */
const PERCENT_MULTIPLIER = 100
/** 百分比上下限（夹值用，防御 ANSI widget 异常输入如 NaN/负数/>100） */
const PERCENT_MAX = 100
const PERCENT_MIN = 0

// ── 类型 ─────────────────────────────────────────────

/** goal 的快照：tool result 的 GuiComponent + ANSI widget 解析的实时字段（可选） */
export interface GoalSnapshot {
  /** 来自 goal_control tool 的 details.__gui__.component（card 或 stats-line GuiComponent） */
  gui: GuiComponent | undefined
  /** goal 的完整目标描述（来自 goal_control create 的 input.objective，仅 create 时有） */
  objective?: string
  /** goal 的短标识（来自 goal_control tool result 的 details.slug 或 card header） */
  slug?: string
  /** 来自 ANSI widget 解析的实时状态（解析失败/无 widget 时 undefined） */
  liveStatus?: GoalLiveStatus
  /** 来自 ANSI widget 解析的 token 用量百分比 0-100（无预算或解析失败时 undefined） */
  liveTokenPct?: number
  /** 来自 ANSI widget 解析的 time 用量百分比 0-100（无预算或解析失败时 undefined） */
  liveTimePct?: number
  /** ANSI widget 原始到达时间戳（用于判断新鲜度） */
  widgetUpdatedAt?: number
}

/**
 * todo 原始项（来自 todo tool result 的 details.todos，对齐 todo extension model.ts Todo）。
 * 用于 TasksPanel 渲染 VERIFY 标签 + 准确三态（list-tree 的 TreeItem 不含 isVerification）。
 */
export interface TodoItem {
  id: number
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  /** 验证任务标记（VERIFY 标签渲染依据，goal extension 要求完成前不可标记 goal complete） */
  isVerification?: boolean
}

/** goal 的实时状态枚举（对齐 goal extension engine/types.ts GoalStatus，去掉 cancelled/active 默认态） */
export type GoalLiveStatus =
  | 'active'
  | 'blocked'
  | 'paused'
  | 'complete'
  | 'budget_limited'
  | 'time_limited'

/** 单个 session 的 tasks 分区状态 */
export interface SessionTasksState {
  goal: GoalSnapshot | undefined
  todo: GuiComponent | undefined
  /** todo 原始项数组（含 isVerification，TasksPanel 渲染 VERIFY 标签用） */
  todos: TodoItem[]
  /** todo 的 done/total 计数（从 todos 聚合，completed 计为 done） */
  todoDone: number
  todoTotal: number
}

// ── 纯函数：ANSI widget 解析 ─────────────────────────

/** strip ANSI 颜色/样式转义序列（\x1b[...m 等）。简单正则，不引入额外依赖。 */
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, '')
}

/**
 * 解析 goal extension widget 的 ANSI 行为实时字段。
 *
 * widget 格式（见 goal extension projection/widget.ts renderStatusLine + renderWidgetLines）：
 * - header 行：`◆ <slug> Turn N | 71% tokens | 12% time | <suffix>`
 *   suffix：`⏸ Paused` / `⊘ Blocked` / `✓ Completed` / `⊗ Token budget exhausted` / `⏱ Time budget exhausted`
 * - Token 行：`  Token: ████░░░░ 71k/200k`（有预算）或 `  Token: 142k used (no budget)`（无预算）
 * - Time 行：`  Time: ██░░░░ 12m/30min`（有预算）或 `  Time: 12m elapsed (no budget)`（无预算）
 *
 * 容错优先：任何字段解析失败只跳过该字段（返回对象中对应 key 不出现），不抛错。
 * status 匹配顺序：先终态/预算耗尽（避免 'Completed' 被前面的 active 默认吞掉）。
 *
 * 百分比来源优先级：
 * - tokenPct：header 的 `NN% tokens` 优先，回退 Token 行 `Xk/Yk` 计算
 * - timePct：header 的 `NN% time` 优先，回退 Time 行 `Xm/Ym(in)?` 计算
 */
function parseGoalWidget(lines: string[]): {
  status?: GoalLiveStatus
  tokenPct?: number
  timePct?: number
} {
  if (!Array.isArray(lines) || lines.length === 0) return {}
  const text = stripAnsi(lines.join('\n'))

  // status：顺序敏感，先匹配终态/耗尽
  let status: GoalLiveStatus | undefined
  if (/Token budget exhausted/i.test(text)) {
    status = 'budget_limited'
  } else if (/Time budget exhausted/i.test(text)) {
    status = 'time_limited'
  } else if (/✓\s*Completed|Completed/i.test(text)) {
    status = 'complete'
  } else if (/Paused/i.test(text)) {
    status = 'paused'
  } else if (/Blocked/i.test(text)) {
    status = 'blocked'
  } else {
    status = 'active'
  }

  // tokenPct：header `NN% tokens` 优先，回退 Token 行 Xk/Yk
  let tokenPct: number | undefined
  const tokenHeaderMatch = text.match(/(\d+(?:\.\d+)?)%\s*tokens?/i)
  if (tokenHeaderMatch) {
    tokenPct = clampPct(Number(tokenHeaderMatch[1]))
  } else {
    const tokenLineMatch = text.match(/Token:.*?(\d+(?:\.\d+)?)k\s*\/\s*(\d+(?:\.\d+)?)k/i)
    if (tokenLineMatch) {
      const used = Number(tokenLineMatch[1])
      const tot = Number(tokenLineMatch[2])
      if (tot > 0) tokenPct = clampPct((used / tot) * PERCENT_MULTIPLIER)
    }
  }

  // timePct：header `NN% time` 优先，回退 Time 行 Xm/Ym(in)
  let timePct: number | undefined
  const timeHeaderMatch = text.match(/(\d+(?:\.\d+)?)%\s*time/i)
  if (timeHeaderMatch) {
    timePct = clampPct(Number(timeHeaderMatch[1]))
  } else {
    const timeLineMatch = text.match(/Time:.*?(\d+(?:\.\d+)?)m\s*\/\s*(\d+(?:\.\d+)?)m(?:in)?/i)
    if (timeLineMatch) {
      const used = Number(timeLineMatch[1])
      const tot = Number(timeLineMatch[2])
      if (tot > 0) timePct = clampPct((used / tot) * PERCENT_MULTIPLIER)
    }
  }

  const result: { status?: GoalLiveStatus; tokenPct?: number; timePct?: number } = { status }
  if (tokenPct !== undefined) result.tokenPct = tokenPct
  if (timePct !== undefined) result.timePct = timePct
  return result
}

/** 把百分比夹到 [PERCENT_MIN, PERCENT_MAX]，防御异常输入（NaN/负数/>100） */
function clampPct(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined
  return Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, n))
}

// ── store ────────────────────────────────────────────

export const useTasksStore = defineStore('tasks', () => {
  /** 按 sessionId 分区的 tasks 状态表 */
  const sessions = ref<Map<string, SessionTasksState>>(new Map())

  /** 取或创建分区（内部写 API 用，返回可变引用，调用方负责触发响应式） */
  function ensureSession(sessionId: string): SessionTasksState {
    const existing = sessions.value.get(sessionId)
    if (existing) return existing
    const fresh: SessionTasksState = {
      goal: undefined,
      todo: undefined,
      todos: [],
      todoDone: 0,
      todoTotal: 0,
    }
    const next = new Map(sessions.value)
    next.set(sessionId, fresh)
    sessions.value = next
    return fresh
  }

  /** 不可变更新：替换某 session 分区（保证 Map 响应式触发） */
  function replaceSession(sessionId: string, state: SessionTasksState): void {
    const next = new Map(sessions.value)
    next.set(sessionId, { ...state })
    sessions.value = next
  }

  // ── 读 API ──

  function getGoal(sessionId: string): GoalSnapshot | undefined {
    return sessions.value.get(sessionId)?.goal
  }

  function getTodo(sessionId: string): GuiComponent | undefined {
    return sessions.value.get(sessionId)?.todo
  }

  function getTodoCount(sessionId: string): { done: number; total: number } {
    const s = sessions.value.get(sessionId)
    if (!s) return { done: 0, total: 0 }
    return { done: s.todoDone, total: s.todoTotal }
  }

  /** goal 或 todo 任一存在即视为有数据（SideDrawer 据此决定 Tasks tab 是否显示内容） */
  function hasData(sessionId: string): boolean {
    const s = sessions.value.get(sessionId)
    if (!s) return false
    // goal（含 widget merge 创建的空 gui 分区）/ todo list-tree gui / 原始 todos 数组任一非空即有数据。
    // 必须含 todos：real todo extension 的 tool result 可能只含 details.todos 无 details.__gui__，
    // 此时 s.todo 为 undefined 但 s.todos 非空——漏检 todos 会导致 tasks tab 不显示。
    return s.goal !== undefined || s.todo !== undefined || s.todos.length > 0
  }

  // ── 写 API ──

  /** chat-message-effects 检测到 goal_control tool result 的 details.__gui__ 时调用 */
  function setGoalFromGui(sessionId: string, gui: GuiComponent): void {
    const s = ensureSession(sessionId)
    // 保留已 setGoalMeta 的 objective/slug 和已 merge 的 widget 实时字段
    // （gui 是 tool result 的结构化快照，不覆盖元数据和实时数据）
    const prev = s.goal
    replaceSession(sessionId, {
      ...s,
      goal: {
        gui,
        objective: prev?.objective,
        slug: prev?.slug,
        liveStatus: prev?.liveStatus,
        liveTokenPct: prev?.liveTokenPct,
        liveTimePct: prev?.liveTimePct,
        widgetUpdatedAt: prev?.widgetUpdatedAt,
      },
    })
  }

  /**
   * chat-message-effects 检测到 todo tool result 的 details.__gui__ 时调用。
   * 只存 gui（用于 hasData 判断 + SideDrawer tabs 显隐）。不在此设 todoDone/todoTotal——
   * 计数唯一来源是 setTodos（原始 details.todos 数组，status 必填枚举，准确）；
   * list-tree 的 TreeItem.status 是可选展示字段，不可靠（真实 extension 的 list-tree item
   * 可能只有 icon/label/depth 无 status）。两者同时调用时，setTodos 后执行覆盖计数。
   */
  function setTodoFromGui(sessionId: string, gui: GuiComponent): void {
    const s = ensureSession(sessionId)
    replaceSession(sessionId, { ...s, todo: gui })
  }

  /**
   * chat-message-effects 检测到 todo tool result 的 details.todos（原始数组）时调用。
   * 存原始项用于 TasksPanel 渲染 VERIFY 标签 + 准确三态（list-tree 的 TreeItem 不含 isVerification）。
   * 同时重算 done/total（以原始 todos 为准，覆盖 list-tree 聚合结果——原始数据更可靠）。
   */
  function setTodos(sessionId: string, todos: TodoItem[]): void {
    const s = ensureSession(sessionId)
    const done = todos.filter((t) => t.status === 'completed').length
    replaceSession(sessionId, { ...s, todos, todoDone: done, todoTotal: todos.length })
  }

  /**
   * chat-message-effects 检测到 goal_control create 的 input.objective 时调用。
   * objective 不在 tool result details 里（只在 create 的 input），需单独提取。
   */
  function setGoalMeta(sessionId: string, meta: { objective?: string; slug?: string }): void {
    const s = ensureSession(sessionId)
    const prevGoal = s.goal
    replaceSession(sessionId, {
      ...s,
      goal: {
        gui: prevGoal?.gui,
        objective: meta.objective ?? prevGoal?.objective,
        slug: meta.slug ?? prevGoal?.slug,
        liveStatus: prevGoal?.liveStatus,
        liveTokenPct: prevGoal?.liveTokenPct,
        liveTimePct: prevGoal?.liveTimePct,
        widgetUpdatedAt: prevGoal?.widgetUpdatedAt,
      },
    })
  }

  /**
   * SideDrawer 收到 extension:widget widgetKey='goal' 的 ANSI 行时调用。
   * 解析实时字段 merge 进 goal 快照（保留 gui）。解析失败的字段被跳过。
   * 无 goal 分区时也会创建（widget 可能先于 tool result 到达）。
   */
  function mergeGoalWidget(sessionId: string, lines: string[]): void {
    const parsed = parseGoalWidget(lines)
    const s = ensureSession(sessionId)
    const prevGoal = s.goal
    replaceSession(sessionId, {
      ...s,
      goal: {
        gui: prevGoal?.gui,
        // 保留 setGoalMeta 写入的 objective/slug（widget merge 只补实时字段，不丢元数据）
        objective: prevGoal?.objective,
        slug: prevGoal?.slug,
        ...(parsed.status !== undefined ? { liveStatus: parsed.status } : {}),
        ...(parsed.tokenPct !== undefined ? { liveTokenPct: parsed.tokenPct } : {}),
        ...(parsed.timePct !== undefined ? { liveTimePct: parsed.timePct } : {}),
        widgetUpdatedAt: Date.now(),
      },
    })
  }

  /** session 结束/切换时清理该 session 分区 */
  function clearSession(sessionId: string): void {
    if (!sessions.value.has(sessionId)) return
    const next = new Map(sessions.value)
    next.delete(sessionId)
    sessions.value = next
  }

  // ── 持久化恢复（规则 7.5：重开 session 后 goal/todo 仍可见）─────────────────
  //
  // 实时链路（routeToolResultToTasks）只管「此刻发生」的 tool result；重开 session 时
  // getHistory 返回的历史 messages 里 toolCall.details 已含 __gui__/todos（message-converter
  // F1 修复透传），但不会自动进 store。本方法在 chat.hydrate 后遍历历史，把每个 todo /
  // goal_control toolCall 的 details + input 再调一遍 set*，复现实时链路的写入。

  /** details.todos 元素类型守卫（容错：过滤掉非合法结构） */
  function isTodoItem(v: unknown): v is TodoItem {
    if (!v || typeof v !== 'object') return false
    const o = v as Record<string, unknown>
    return (
      typeof o['id'] === 'number' &&
      typeof o['text'] === 'string' &&
      typeof o['status'] === 'string' &&
      ['pending', 'in_progress', 'completed', 'cancelled'].includes(o['status'] as string)
    )
  }

  /** details.__gui__ 守卫：可能是 {v:1, component} 包装，也可能是裸 GuiComponent */
  function extractGuiComponent(rawGui: unknown): GuiComponent | undefined {
    if (!rawGui || typeof rawGui !== 'object') return undefined
    // 包装层 { v: 1, component: GuiComponent }（pi-subagents / pi-goal 的包装格式）
    if ('component' in rawGui) {
      const c = (rawGui as { component: unknown }).component
      if (c && typeof c === 'object' && 'type' in c) return c as GuiComponent
    }
    // 裸 GuiComponent（pi-todo 的格式，直接 { type: 'list-tree', props: {...} }）
    if ('type' in rawGui) return rawGui as GuiComponent
    return undefined
  }

  /**
   * 从历史 messages 恢复 goal/todo 快照到 store。
   *
   * 在 chat.hydrate(sessionId, messages) 之后调。遍历所有 assistant message 的 toolCalls，
   * 按时间顺序复现实时链路的写入（后调的 set* 覆盖前者，最终状态 = 最后一条 toolCall 的状态）。
   *
   * 注意：只处理 toolName 明确是 'todo' / 'goal_control' 的 toolCall（历史路 toolCall.toolName
   * 由 message-converter 从 pi arguments 透传，是权威值，不存在实时路 tool_call_end 的 fallback 问题）。
   */
  function hydrateFromMessages(sessionId: string, history: Message[]): void {
    for (const msg of history) {
      if (msg.role !== 'assistant' || !msg.toolCalls) continue
      for (const tc of msg.toolCalls) {
        hydrateFromToolCall(sessionId, tc)
      }
    }
  }

  /** 单个 toolCall 的 details/input 提取（与 chat-message-effects 的 routeToolResultToTasks /
   *  routeToolStartToTasks 数据结构一致，独立实现避免 store → effects 循环依赖） */
  function hydrateFromToolCall(sessionId: string, tc: ToolCall): void {
    if (tc.toolName !== 'todo' && tc.toolName !== 'goal_control') return
    const details = tc.details
    const input = (tc.input ?? {}) as Record<string, unknown>

    // goal_control create 的 objective / slug（实时路在 tool_call_start 提取，历史路从 input 取）
    if (tc.toolName === 'goal_control') {
      const objective = typeof input['objective'] === 'string' ? input['objective'] : undefined
      const inputSlug = typeof input['slug'] === 'string' ? input['slug'] : undefined
      if (objective || inputSlug) {
        setGoalMeta(sessionId, { objective, slug: inputSlug })
      }
    }

    if (!details) return

    // __gui__ 快照
    const gui = extractGuiComponent(details['__gui__'])
    if (gui) {
      if (tc.toolName === 'todo') {
        setTodoFromGui(sessionId, gui)
      } else {
        setGoalFromGui(sessionId, gui)
      }
    }

    // todo 原始数组（含 isVerification）
    if (tc.toolName === 'todo') {
      const rawTodos = details['todos']
      if (Array.isArray(rawTodos)) {
        const todos = rawTodos.filter(isTodoItem)
        if (todos.length > 0) setTodos(sessionId, todos)
      }
    }

    // goal slug（details.slug 比 card header 解析更可靠）
    if (tc.toolName === 'goal_control') {
      const detailSlug = typeof details['slug'] === 'string' ? details['slug'] : undefined
      if (detailSlug) setGoalMeta(sessionId, { slug: detailSlug })
    }
  }

  /** 读取 session 的原始 todo 项数组（TasksPanel 渲染 VERIFY 标签用） */
  function getTodos(sessionId: string): TodoItem[] {
    return sessions.value.get(sessionId)?.todos ?? []
  }

  return {
    sessions,
    getGoal,
    getTodo,
    getTodos,
    getTodoCount,
    hasData,
    setGoalFromGui,
    setGoalMeta,
    setTodoFromGui,
    setTodos,
    hydrateFromMessages,
    mergeGoalWidget,
    clearSession,
  }
})
