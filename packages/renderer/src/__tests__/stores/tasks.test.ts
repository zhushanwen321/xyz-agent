/**
 * tasks store 单测 —— session 级 goal/todo 快照的读写 + ANSI widget 解析。
 *
 * 覆盖：
 * - setTodoFromGui 后 getTodo 返回原 gui（计数由 setTodos 独立管理，setTodoFromGui 不再设）
 * - setGoalFromGui 后 getGoal 返回 gui
 * - mergeGoalWidget 解析 status / tokenPct / timePct（真实 ANSI fixture）
 * - mergeGoalWidget 解析失败不抛错（乱码字符串）
 * - setGoalFromGui + mergeGoalWidget 共存：gui 保留、live 字段 merge
 * - hasData 在无数据 false、有 todo/goal true
 * - clearSession 后 hasData false、getTodo 返回 undefined
 * - 读 API 对不存在的 session 返回 undefined / 零值（不自动创建）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/tasks.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { useTasksStore } from '@/stores/tasks'

// ── fixture 工厂 ────────────────────────────────────

/** 构造 list-tree GuiComponent（对齐 todo extension model.ts buildGui 的输出形状） */
function makeListTree(items: GuiComponent['props'] extends infer P
  ? P extends { items: infer I } ? I : never
  : never): GuiComponent {
  return { type: 'list-tree', props: { items } as unknown as GuiComponent['props'] }
}

/** 构造单层 todo list-tree（无嵌套） */
function flatTodoList(): GuiComponent {
  return makeListTree([
    { icon: 'check', label: '#1: done task', status: 'done', depth: 0 },
    { icon: 'check', label: '#2: done task', status: 'done', depth: 0 },
    { icon: 'circle', label: '#3: in progress', status: 'running', depth: 0 },
    { icon: 'dot', label: '#4: pending', depth: 0 },
  ])
}

/** 构造带嵌套 children 的 list-tree（验证递归计数） */
function nestedTodoList(): GuiComponent {
  return makeListTree([
    {
      icon: 'check',
      label: '#1: parent done',
      status: 'done',
      depth: 0,
      children: [
        { icon: 'check', label: 'child a done', status: 'done', depth: 1 },
        { icon: 'dot', label: 'child b pending', depth: 1 },
      ],
    },
    { icon: 'circle', label: '#2: running', status: 'running', depth: 0 },
  ])
}

/** 构造 card GuiComponent（对齐 goal extension buildGoalGui 有预算分支输出） */
function makeGoalCard(): GuiComponent {
  return {
    type: 'card',
    props: {
      variant: 'default',
      header: 'fix-auth-bug',
      body: [{ type: 'progress-bar', props: { label: 'tokens', current: 71000, total: 200000, unit: 'tok', severity: 'ok' } }],
    } as unknown as GuiComponent['props'],
  }
}

/** 真实 ANSI widget fixture：active 态 + 有 token/time 预算（含 ANSI 颜色码） */
function activeWidgetLines(): string[] {
  // 模拟 goal extension renderStatusLine + renderWidgetLines 的 ANSI 输出
  return [
    '\x1b[36m◆ fix-auth-bug\x1b[0m\x1b[90m Turn 3\x1b[0m\x1b[33m | 36% tokens\x1b[0m\x1b[33m | 40% time\x1b[0m',
    '  Token: \x1b[33m████░░░░\x1b[0m 71k/200k',
    '  Time: \x1b[33m██░░░░░░\x1b[0m 12m/30min',
  ]
}

/** 真实 ANSI widget fixture：completed 终态（折叠为 status bar 单行） */
function completedStatusLines(): string[] {
  return ['\x1b[36m◆ Goal\x1b[0m\x1b[32m ✓ Completed\x1b[0m\x1b[32m | 48% tokens\x1b[0m']
}

/** paused 态 widget（header 行含 ⏸ Paused suffix） */
function pausedWidgetLines(): string[] {
  return [
    '\x1b[36m◆ paused-goal\x1b[0m\x1b[90m Turn 1\x1b[0m\x1b[90m | 5% tokens\x1b[0m\x1b[33m | ⏸ Paused\x1b[0m',
    '  Token: \x1b[32m█░░░░░░░\x1b[0m 10k/200k',
  ]
}

/** token 预算耗尽 widget（header 行含 ⊗ Token budget exhausted） */
function budgetExhaustedLines(): string[] {
  return ['\x1b[36m◆ Goal\x1b[0m\x1b[31m ⊗ Token budget exhausted\x1b[0m\x1b[31m | 100% tokens\x1b[0m']
}

/** time 预算耗尽 widget（header 行含 ⏱ Time budget exhausted） */
function timeExhaustedLines(): string[] {
  return ['\x1b[36m◆ Goal\x1b[0m\x1b[31m ⏱ Time budget exhausted\x1b[0m\x1b[31m | 100% time\x1b[0m']
}

/** blocked 态 widget（header 行含 ⊘ Blocked） */
function blockedWidgetLines(): string[] {
  return ['\x1b[36m◆ blocked-goal\x1b[0m\x1b[90m Turn 5\x1b[0m\x1b[31m | ⊘ Blocked\x1b[0m']
}

/** 无预算 widget（header 显示绝对值 + Token/Time 行显示 used/no budget） */
function noBudgetWidgetLines(): string[] {
  return [
    '\x1b[36m◆ no-budget-goal\x1b[0m\x1b[90m Turn 2\x1b[0m\x1b[90m | 12k tokens\x1b[0m\x1b[90m | 3m\x1b[0m',
    '\x1b[90m  Token: 12k used (no budget)\x1b[0m',
    '\x1b[90m  Time: 3m elapsed (no budget)\x1b[0m',
  ]
}

// ── 测试 ─────────────────────────────────────────────

describe('tasks store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // ── 读 API 对不存在 session 的行为 ──

  describe('读 API 对不存在的 session', () => {
    it('getGoal 返回 undefined（不自动创建分区）', () => {
      const store = useTasksStore()
      expect(store.getGoal('s1')).toBeUndefined()
      // 确认未副作用创建分区
      expect(store.sessions.size).toBe(0)
    })

    it('getTodo 返回 undefined（不自动创建分区）', () => {
      const store = useTasksStore()
      expect(store.getTodo('s1')).toBeUndefined()
      expect(store.sessions.size).toBe(0)
    })

    it('getTodoCount 返回 {done:0, total:0}', () => {
      const store = useTasksStore()
      expect(store.getTodoCount('s1')).toEqual({ done: 0, total: 0 })
      expect(store.sessions.size).toBe(0)
    })

    it('hasData 返回 false', () => {
      const store = useTasksStore()
      expect(store.hasData('s1')).toBe(false)
    })
  })

  // ── todo ──

  describe('todo 写入（gui 存储）与计数（setTodos）', () => {
    it('setTodoFromGui 后 getTodo 返回原 gui（deep equal，Pinia reactive proxy 使引用不等）', () => {
      const store = useTasksStore()
      const gui = flatTodoList()
      store.setTodoFromGui('s1', gui)
      expect(store.getTodo('s1')).toEqual(gui)
    })

    it('单层 todo 数组：done = completed 数量，total = todos.length', () => {
      const store = useTasksStore()
      // fixture: 2 completed, 1 in_progress, 1 pending → done=2, total=4
      store.setTodos('s1', [
        { id: 1, text: 'a', status: 'completed' },
        { id: 2, text: 'b', status: 'completed' },
        { id: 3, text: 'c', status: 'in_progress' },
        { id: 4, text: 'd', status: 'pending' },
      ])
      expect(store.getTodoCount('s1')).toEqual({ done: 2, total: 4 })
    })

    it('重复 setTodos 覆盖旧值并重算计数', () => {
      const store = useTasksStore()
      store.setTodos('s1', [
        { id: 1, text: 'a', status: 'completed' },
        { id: 2, text: 'b', status: 'completed' },
        { id: 3, text: 'c', status: 'in_progress' },
        { id: 4, text: 'd', status: 'pending' },
      ])
      expect(store.getTodoCount('s1')).toEqual({ done: 2, total: 4 })
      store.setTodos('s1', [
        { id: 1, text: 'x', status: 'completed' },
        { id: 2, text: 'y', status: 'pending' },
        { id: 3, text: 'z', status: 'pending' },
      ])
      expect(store.getTodoCount('s1')).toEqual({ done: 1, total: 3 })
    })

    it('非 list-tree 的 gui 不抛错，计数为 0（setTodoFromGui 不再设计数）', () => {
      const store = useTasksStore()
      const card = makeGoalCard()
      expect(() => store.setTodoFromGui('s1', card)).not.toThrow()
      // todo 字段仍被写入（store 不限制 type，计数逻辑容错）
      expect(store.getTodo('s1')).toEqual(card)
      // setTodoFromGui 不写计数，未调 setTodos 时计数为默认 0
      expect(store.getTodoCount('s1')).toEqual({ done: 0, total: 0 })
    })

    it('重复 setTodoFromGui 覆盖旧 gui（计数由 setTodos 独立管理，不在此重算）', () => {
      const store = useTasksStore()
      store.setTodoFromGui('s1', flatTodoList())
      store.setTodoFromGui('s1', nestedTodoList())
      expect(store.getTodo('s1')).toEqual(nestedTodoList())
      // 计数仍是 0（setTodoFromGui 不设计数，需 setTodos 才有）
      expect(store.getTodoCount('s1')).toEqual({ done: 0, total: 0 })
    })
  })

  // ── goal ──

  describe('goal 写入', () => {
    it('setGoalFromGui 后 getGoal 返回含 gui 的快照', () => {
      const store = useTasksStore()
      const gui = makeGoalCard()
      store.setGoalFromGui('s1', gui)
      const goal = store.getGoal('s1')
      expect(goal).toBeDefined()
      expect(goal?.gui).toEqual(gui)
    })

    it('setGoalFromGui 不覆盖已 merge 的 widget 实时字段', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', activeWidgetLines())
      store.setGoalFromGui('s1', makeGoalCard())
      const goal = store.getGoal('s1')
      expect(goal?.gui).toBeDefined()
      expect(goal?.liveStatus).toBe('active')
      expect(goal?.liveTokenPct).toBe(36)
    })
  })

  // ── ANSI widget 解析 ──

  describe('mergeGoalWidget ANSI 解析', () => {
    it('active 态：解析 status + tokenPct + timePct（从 header 百分比）', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', activeWidgetLines())
      const goal = store.getGoal('s1')
      expect(goal?.liveStatus).toBe('active')
      expect(goal?.liveTokenPct).toBe(36)
      expect(goal?.liveTimePct).toBe(40)
    })

    it('completed 终态：status=complete，tokenPct 从 header 解析', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', completedStatusLines())
      const goal = store.getGoal('s1')
      expect(goal?.liveStatus).toBe('complete')
      expect(goal?.liveTokenPct).toBe(48)
      // 无 time 行 → timePct undefined
      expect(goal?.liveTimePct).toBeUndefined()
    })

    it('paused 态：status=paused', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', pausedWidgetLines())
      expect(store.getGoal('s1')?.liveStatus).toBe('paused')
    })

    it('blocked 态：status=blocked', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', blockedWidgetLines())
      expect(store.getGoal('s1')?.liveStatus).toBe('blocked')
    })

    it('Token budget exhausted：status=budget_limited（优先于其它匹配）', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', budgetExhaustedLines())
      const goal = store.getGoal('s1')
      expect(goal?.liveStatus).toBe('budget_limited')
      expect(goal?.liveTokenPct).toBe(100)
    })

    it('Time budget exhausted：status=time_limited', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', timeExhaustedLines())
      const goal = store.getGoal('s1')
      expect(goal?.liveStatus).toBe('time_limited')
      expect(goal?.liveTimePct).toBe(100)
    })

    it('header 无百分比时回退 Token 行 Xk/Yk 计算 tokenPct', () => {
      const store = useTasksStore()
      // 构造只有 Token 行、header 无百分比的场景
      const lines = [
        '\x1b[36m◆ goal\x1b[0m\x1b[90m Turn 1\x1b[0m',
        '  Token: █░░░░░░░ 50k/200k',
      ]
      store.mergeGoalWidget('s1', lines)
      expect(store.getGoal('s1')?.liveTokenPct).toBe(25)
    })

    it('header 无百分比时回退 Time 行 Xm/Ym 计算 timePct', () => {
      const store = useTasksStore()
      const lines = [
        '\x1b[36m◆ goal\x1b[0m\x1b[90m Turn 1\x1b[0m',
        '  Time: ██░░░░░░ 6m/30min',
      ]
      store.mergeGoalWidget('s1', lines)
      expect(store.getGoal('s1')?.liveTimePct).toBe(20)
    })

    it('无预算 widget：status=active，tokenPct/timePct 均 undefined', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', noBudgetWidgetLines())
      const goal = store.getGoal('s1')
      expect(goal?.liveStatus).toBe('active')
      expect(goal?.liveTokenPct).toBeUndefined()
      expect(goal?.liveTimePct).toBeUndefined()
    })

    it('空数组 lines：不抛错，所有实时字段 undefined（空 widget 无可解析内容）', () => {
      const store = useTasksStore()
      expect(() => store.mergeGoalWidget('s1', [])).not.toThrow()
      const goal = store.getGoal('s1')
      // 空数组 parseGoalWidget 返回 {}，merge 时无 status/key 被写入
      expect(goal?.liveStatus).toBeUndefined()
      expect(goal?.liveTokenPct).toBeUndefined()
    })

    it('乱码字符串：不抛错，status=active', () => {
      const store = useTasksStore()
      expect(() => store.mergeGoalWidget('s1', ['@@@###$$$不是有效内容'])).not.toThrow()
      const goal = store.getGoal('s1')
      expect(goal?.liveStatus).toBe('active')
      expect(goal?.liveTokenPct).toBeUndefined()
      expect(goal?.liveTimePct).toBeUndefined()
    })

    it('重复 merge 覆盖旧实时字段', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', activeWidgetLines())
      expect(store.getGoal('s1')?.liveTokenPct).toBe(36)
      store.mergeGoalWidget('s1', completedStatusLines())
      const goal = store.getGoal('s1')
      expect(goal?.liveStatus).toBe('complete')
      expect(goal?.liveTokenPct).toBe(48)
      // completed 行无 time 百分比 → 覆盖为 undefined（新对象无该 key）
      expect(goal?.liveTimePct).toBeUndefined()
    })

    it('widget 先于 tool result 到达：创建分区，gui 仍为 undefined', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', activeWidgetLines())
      const goal = store.getGoal('s1')
      expect(goal?.gui).toBeUndefined()
      expect(goal?.liveStatus).toBe('active')
      // 后续 setGoalFromGui 补 gui
      store.setGoalFromGui('s1', makeGoalCard())
      expect(store.getGoal('s1')?.gui).toBeDefined()
    })
  })

  // ── hasData / clearSession ──

  describe('hasData 与 clearSession', () => {
    it('hasData：无数据 false', () => {
      const store = useTasksStore()
      expect(store.hasData('s1')).toBe(false)
    })

    it('hasData：只有 todo 时 true', () => {
      const store = useTasksStore()
      store.setTodoFromGui('s1', flatTodoList())
      expect(store.hasData('s1')).toBe(true)
    })

    it('hasData：只有 goal 时 true', () => {
      const store = useTasksStore()
      store.setGoalFromGui('s1', makeGoalCard())
      expect(store.hasData('s1')).toBe(true)
    })

    it('hasData：只有 widget（无 gui）时 true', () => {
      const store = useTasksStore()
      store.mergeGoalWidget('s1', activeWidgetLines())
      expect(store.hasData('s1')).toBe(true)
    })

    it('hasData：只有原始 todos 数组（无 __gui__）时 true（real todo extension 场景）', () => {
      const store = useTasksStore()
      // real todo extension 的 tool result 可能只含 details.todos 无 details.__gui__，
      // 此时 s.todo 为 undefined 但 s.todos 非空——hasData 必须识别这种情况，否则 tasks tab 不显示。
      store.setTodos('s1', [
        { id: 1, text: 'a', status: 'pending' },
        { id: 2, text: 'b', status: 'completed' },
      ])
      expect(store.hasData('s1')).toBe(true)
    })

    it('clearSession 后 hasData false、getTodo/getGoal undefined', () => {
      const store = useTasksStore()
      store.setTodoFromGui('s1', flatTodoList())
      store.setGoalFromGui('s1', makeGoalCard())
      expect(store.hasData('s1')).toBe(true)
      store.clearSession('s1')
      expect(store.hasData('s1')).toBe(false)
      expect(store.getTodo('s1')).toBeUndefined()
      expect(store.getGoal('s1')).toBeUndefined()
      expect(store.getTodoCount('s1')).toEqual({ done: 0, total: 0 })
      expect(store.sessions.size).toBe(0)
    })

    it('clearSession 不存在的 session：no-op 不抛错', () => {
      const store = useTasksStore()
      expect(() => store.clearSession('never-existed')).not.toThrow()
    })
  })

  // ── session 隔离 ──

  describe('session 隔离', () => {
    it('不同 session 的 todo/goal 互不影响', () => {
      const store = useTasksStore()
      store.setTodoFromGui('s1', flatTodoList())
      store.setTodos('s1', [
        { id: 1, text: 'a', status: 'completed' },
        { id: 2, text: 'b', status: 'completed' },
        { id: 3, text: 'c', status: 'in_progress' },
        { id: 4, text: 'd', status: 'pending' },
      ])
      store.setGoalFromGui('s2', makeGoalCard())
      expect(store.getTodoCount('s1')).toEqual({ done: 2, total: 4 })
      expect(store.getTodo('s2')).toBeUndefined()
      expect(store.getGoal('s1')).toBeUndefined()
      expect(store.getGoal('s2')?.gui).toBeDefined()
      expect(store.sessions.size).toBe(2)
    })

    it('clearSession 只清目标 session', () => {
      const store = useTasksStore()
      store.setTodoFromGui('s1', flatTodoList())
      store.setTodoFromGui('s2', nestedTodoList())
      store.clearSession('s1')
      expect(store.hasData('s1')).toBe(false)
      expect(store.hasData('s2')).toBe(true)
      expect(store.sessions.size).toBe(1)
    })
  })

  // ── 原始 todos 数组（VERIFY 标签 + 准确三态） ──

  describe('setTodos / getTodos（原始 todo 数组）', () => {
    it('setTodos 后 getTodos 返回原始数组（deep equal）', () => {
      const store = useTasksStore()
      const todos = [
        { id: 1, text: 'task a', status: 'completed' as const, isVerification: true },
        { id: 2, text: 'task b', status: 'pending' as const },
      ]
      store.setTodos('s1', todos)
      expect(store.getTodos('s1')).toEqual(todos)
    })

    it('setTodos 重算 done/total（以原始 todos 为唯一计数源）', () => {
      const store = useTasksStore()
      // setTodoFromGui 只存 gui 不设计数（未调 setTodos 时计数为 0）
      store.setTodoFromGui('s1', flatTodoList())
      expect(store.getTodoCount('s1')).toEqual({ done: 0, total: 0 })
      // setTodos 后计数以原始数组为准（done=1/total=3）
      store.setTodos('s1', [
        { id: 1, text: 'a', status: 'completed' },
        { id: 2, text: 'b', status: 'in_progress' },
        { id: 3, text: 'c', status: 'pending' },
      ])
      expect(store.getTodoCount('s1')).toEqual({ done: 1, total: 3 })
    })

    it('getTodos 对不存在的 session 返回空数组（不抛错）', () => {
      const store = useTasksStore()
      expect(store.getTodos('nope')).toEqual([])
    })

    it('isVerification 字段保留（TasksPanel 渲染 VERIFY 标签依据）', () => {
      const store = useTasksStore()
      store.setTodos('s1', [
        { id: 1, text: 'verify task', status: 'pending', isVerification: true },
        { id: 2, text: 'normal task', status: 'pending' },
      ])
      const todos = store.getTodos('s1')
      expect(todos[0].isVerification).toBe(true)
      expect(todos[1].isVerification).toBeUndefined()
    })
  })

  // ── goal objective / slug 元数据 ──

  describe('hydrateFromMessages（持久化恢复，规则 7.5）', () => {
    // [HISTORICAL] tasks store 数据原本只来自实时 tool result 事件。重启 app / 刷新页面后
    // store 清空，tasks tab 消失。message-converter F1 修复已透传 toolCall.details（含 __gui__
    // /todos），hydrateFromMessages 在 chat.hydrate 后遍历历史复现写入。
    it('从历史 assistant.toolCalls 恢复 todo 快照（裸 __gui__ + todos 数组）', () => {
      const store = useTasksStore()
      const history = [{
        id: 'a1', role: 'assistant', content: '',
        toolCalls: [{
          id: 'tc1', toolName: 'todo',
          input: { action: 'add' },
          status: 'completed',
          details: {
            action: 'add', nextId: 2,
            todos: [
              { id: 1, text: '历史任务1', status: 'completed' },
              { id: 2, text: '历史任务2', status: 'pending', isVerification: true },
            ],
            __gui__: { type: 'list-tree', props: { items: [{ label: '#1: 历史任务1' }] } },
          },
        }],
      }]
      store.hydrateFromMessages('s1', history as never)
      expect(store.hasData('s1')).toBe(true)
      expect(store.getTodos('s1')).toEqual([
        { id: 1, text: '历史任务1', status: 'completed' },
        { id: 2, text: '历史任务2', status: 'pending', isVerification: true },
      ])
      expect(store.getTodoCount('s1')).toEqual({ done: 1, total: 2 })
      expect(store.getTodo('s1')?.type).toBe('list-tree')
    })

    it('从历史 goal_control toolCall 恢复 goal 快照 + objective + slug', () => {
      const store = useTasksStore()
      const history = [{
        id: 'a1', role: 'assistant', content: '',
        toolCalls: [
          // create：input.objective / slug（tool_call_start 路径）
          {
            id: 'tc1', toolName: 'goal_control',
            input: { action: 'create', objective: '实现登录功能', slug: 'impl-login' },
            status: 'completed',
          },
          // report：details.__gui__ + slug（tool_call_end 路径）
          {
            id: 'tc2', toolName: 'goal_control',
            input: { action: 'report' },
            status: 'completed',
            details: {
              slug: 'impl-login',
              __gui__: { v: 1, component: { type: 'stats-line', props: { content: '50% (2/4)' } } },
            },
          },
        ],
      }]
      store.hydrateFromMessages('s1', history as never)
      const goal = store.getGoal('s1')
      expect(goal?.objective).toBe('实现登录功能')
      expect(goal?.slug).toBe('impl-login')
      // 包装层 __gui__ {v, component} 被解开
      expect(goal?.gui?.type).toBe('stats-line')
    })

    it('多条同类 toolCall 按顺序覆盖（最后一条为准）', () => {
      const store = useTasksStore()
      const history = [{
        id: 'a1', role: 'assistant', content: '',
        toolCalls: [
          { id: 'tc1', toolName: 'todo', input: {}, status: 'completed',
            details: { todos: [{ id: 1, text: '旧', status: 'pending' }] } },
          { id: 'tc2', toolName: 'todo', input: {}, status: 'completed',
            details: { todos: [
              { id: 1, text: '新', status: 'completed' },
              { id: 2, text: '新2', status: 'pending' },
            ] } },
        ],
      }]
      store.hydrateFromMessages('s1', history as never)
      expect(store.getTodos('s1').map(t => t.text)).toEqual(['新', '新2'])
      expect(store.getTodoCount('s1')).toEqual({ done: 1, total: 2 })
    })

    it('非 todo/goal_control toolCall 被忽略', () => {
      const store = useTasksStore()
      const history = [{
        id: 'a1', role: 'assistant', content: '',
        toolCalls: [
          { id: 'tc1', toolName: 'bash', input: { cmd: 'ls' }, status: 'completed',
            details: { output: 'file1' } },
          { id: 'tc2', toolName: 'read', input: { path: '/a' }, status: 'completed' },
        ],
      }]
      store.hydrateFromMessages('s1', history as never)
      expect(store.hasData('s1')).toBe(false)
    })

    it('空历史 / 无 toolCalls 的 message 不报错', () => {
      const store = useTasksStore()
      store.hydrateFromMessages('s1', [])
      store.hydrateFromMessages('s2', [{ id: 'u1', role: 'user', content: 'hi' }] as never)
      expect(store.hasData('s1')).toBe(false)
      expect(store.hasData('s2')).toBe(false)
    })
  })

  describe('setGoalMeta（objective / slug）', () => {
    it('setGoalMeta 写入 objective 和 slug', () => {
      const store = useTasksStore()
      store.setGoalMeta('s1', { objective: '修复登录 bug', slug: 'fix-auth' })
      const goal = store.getGoal('s1')
      expect(goal?.objective).toBe('修复登录 bug')
      expect(goal?.slug).toBe('fix-auth')
    })

    it('setGoalMeta 不覆盖已存在的 gui / live 字段', () => {
      const store = useTasksStore()
      store.setGoalFromGui('s1', makeGoalCard())
      store.mergeGoalWidget('s1', activeWidgetLines())
      store.setGoalMeta('s1', { objective: '修复登录 bug' })
      const goal = store.getGoal('s1')
      expect(goal?.objective).toBe('修复登录 bug')
      expect(goal?.gui).toBeDefined()
      expect(goal?.liveStatus).toBe('active')
      expect(goal?.liveTokenPct).toBe(36)
    })

    it('setGoalMeta 部分更新：只传 objective 不清空 slug', () => {
      const store = useTasksStore()
      store.setGoalMeta('s1', { objective: 'obj1', slug: 'slug1' })
      store.setGoalMeta('s1', { objective: 'obj2' })
      const goal = store.getGoal('s1')
      expect(goal?.objective).toBe('obj2')
      expect(goal?.slug).toBe('slug1')
    })

    it('setGoalFromGui 不覆盖已 setGoalMeta 的 objective/slug', () => {
      const store = useTasksStore()
      store.setGoalMeta('s1', { objective: '修复登录 bug', slug: 'fix-auth' })
      store.setGoalFromGui('s1', makeGoalCard())
      const goal = store.getGoal('s1')
      expect(goal?.objective).toBe('修复登录 bug')
      expect(goal?.slug).toBe('fix-auth')
      expect(goal?.gui).toBeDefined()
    })

    // [HISTORICAL] mergeGoalWidget 曾漏保留 prevGoal.objective/slug，goal ANSI widget 到达会
    // 覆盖掉 setGoalMeta 写入的元数据，导致 GoalCard 的 objective 永久不渲染（E2E tasks-drawer Case 3 暴露）。
    // 此测试锁住「widget merge 只补实时字段，不丢元数据」语义。
    it('mergeGoalWidget 不覆盖已 setGoalMeta 的 objective/slug（回归防护）', () => {
      const store = useTasksStore()
      store.setGoalMeta('s1', { objective: '修复登录 bug', slug: 'fix-auth' })
      store.mergeGoalWidget('s1', activeWidgetLines())
      const goal = store.getGoal('s1')
      expect(goal?.objective).toBe('修复登录 bug')
      expect(goal?.slug).toBe('fix-auth')
      expect(goal?.liveStatus).toBe('active')
      expect(goal?.liveTokenPct).toBe(36)
    })
  })
})
