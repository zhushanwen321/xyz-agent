/**
 * tasks store 行为单测（core 域，P3 绞杀迁移锁定）。
 *
 * 迁自 renderer __tests__/stores/tasks.test.ts 的核心写入/读取路径（聚焦语义等价锁定，
 * 非全量镜像——全量 ANSI widget 解析等用例由 renderer tasks.test.ts 经 @xyz-agent/core 回归覆盖）。
 *
 * 覆盖：
 * - setTodoFromGui / setGoalFromGui：写入后 getTodo / getGoal 返回 gui
 * - setTodos：写入原始数组，getTodos / getTodoCount（done/total）正确
 * - setGoalMeta：objective / slug 写入 merge 到 goal 分区
 * - hasData：无数据 false / 有 todo 或 goal true
 * - clearSession：清空后 hasData false、getTodo undefined
 * - 读 API 对不存在 session 返回零值（不自动创建）
 * - getTodoCount 空分区 {done:0,total:0}
 *
 * 运行：cd packages/core && npx vitest run src/domain/tasks
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { useTasksStore } from '../tasks'

function listTree(items: unknown[]): GuiComponent {
  return { type: 'list-tree', props: { items } as unknown as GuiComponent['props'] }
}

describe('tasks store（core 域迁移后行为锁定）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  describe('setTodoFromGui / getTodo / hasData', () => {
    it('setTodoFromGui 后 getTodo 返回 gui，hasData=true', () => {
      const store = useTasksStore()
      const sid = 's1'
      const gui = listTree([{ label: '#1: pending' }])
      store.setTodoFromGui(sid, gui)
      expect(store.getTodo(sid)).toEqual(gui)
      expect(store.hasData(sid)).toBe(true)
    })

    it('未写入的 session：getTodo=undefined / hasData=false / getTodoCount={0,0}', () => {
      const store = useTasksStore()
      const sid = 's-empty'
      expect(store.getTodo(sid)).toBeUndefined()
      expect(store.hasData(sid)).toBe(false)
      expect(store.getTodoCount(sid)).toEqual({ done: 0, total: 0 })
    })
  })

  describe('setGoalFromGui / setGoalMeta / getGoal', () => {
    it('setGoalFromGui 后 getGoal 返回含 gui 的快照', () => {
      const store = useTasksStore()
      const sid = 's2'
      const card: GuiComponent = { type: 'card', props: {} as GuiComponent['props'] }
      store.setGoalFromGui(sid, card)
      const goal = store.getGoal(sid)
      expect(goal).toBeDefined()
      expect(goal!.gui).toEqual(card)
      expect(store.hasData(sid)).toBe(true)
    })

    it('setGoalMeta 写入 objective + slug，merge 到 goal 分区', () => {
      const store = useTasksStore()
      const sid = 's3'
      store.setGoalMeta(sid, { objective: '完成 X', slug: 'do-x' })
      const goal = store.getGoal(sid)
      expect(goal).toBeDefined()
      expect(goal!.objective).toBe('完成 X')
      expect(goal!.slug).toBe('do-x')
      expect(store.hasData(sid)).toBe(true)
    })
  })

  describe('setTodos / getTodos / getTodoCount', () => {
    it('setTodos 写入后 getTodos 返回原数组，计数 completed=done', () => {
      const store = useTasksStore()
      const sid = 's4'
      store.setTodos(sid, [
        { id: 1, text: 'a', status: 'completed' },
        { id: 2, text: 'b', status: 'pending' },
        { id: 3, text: 'c', status: 'in_progress' },
      ])
      expect(store.getTodos(sid)).toHaveLength(3)
      expect(store.getTodoCount(sid)).toEqual({ done: 1, total: 3 })
      expect(store.hasData(sid)).toBe(true)
    })

    it('isVerification 字段透传保留', () => {
      const store = useTasksStore()
      const sid = 's5'
      store.setTodos(sid, [
        { id: 1, text: 'v', status: 'pending', isVerification: true },
      ])
      expect(store.getTodos(sid)[0].isVerification).toBe(true)
    })
  })

  describe('clearSession', () => {
    it('写入后 clearSession → hasData=false / getTodo=undefined / getGoal=undefined', () => {
      const store = useTasksStore()
      const sid = 's6'
      store.setTodoFromGui(sid, listTree([{ label: 'x' }]))
      store.setGoalMeta(sid, { slug: 'g' })
      expect(store.hasData(sid)).toBe(true)

      store.clearSession(sid)
      expect(store.hasData(sid)).toBe(false)
      expect(store.getTodo(sid)).toBeUndefined()
      expect(store.getGoal(sid)).toBeUndefined()
      expect(store.getTodos(sid)).toEqual([])
    })
  })
})
