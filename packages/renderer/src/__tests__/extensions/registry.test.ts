/**
 * ExtensionRegistry + tasks-adapter 单测。
 *
 * 覆盖：
 * - 注册后 route{Widget|WidgetGui|Status} 命中返回 true、调用 adapter
 * - 未注册的 key 返回 false（走通用管线）
 * - case-insensitive 匹配（extension 推的 key 大小写不可控）
 * - tasks-adapter 的 goal/todo 分流语义（goal→mergeGoalWidget / todo→no-op / status→no-op）
 * - 重复注册幂等（HMR 场景）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/extensions/registry.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  registerKnownExtension,
  routeWidget,
  routeWidgetGui,
  routeStatus,
  __resetExtensionRegistry,
} from '@/extensions/registry'
import { useTasksStore } from '@/stores/tasks'
// import tasks-adapter 触发副作用注册（goal/todo adapter 进 registry）
import '@/extensions/adapters/tasks-adapter'

describe('ExtensionRegistry 分流', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 注意：不调 __resetExtensionRegistry——tasks-adapter 的副作用注册在 import 时已完成，
    // 重置会丢失它。测试需要 tasks-adapter 已注册。
  })

  describe('未注册 key 走通用管线（route* 返回 false）', () => {
    it('未注册 widgetKey → routeWidget 返回 false', () => {
      expect(routeWidget('s1', 'unknown-widget', ['line'])).toBe(false)
    })
    it('未注册 statusKey → routeStatus 返回 false', () => {
      expect(routeStatus('s1', 'unknown-status', 'text', undefined)).toBe(false)
    })
  })

  describe('tasks-adapter（goal/todo）分流语义', () => {
    it("goal widget → 调 tasksStore.mergeGoalWidget 解析实时字段", () => {
      const store = useTasksStore()
      // 先 setGoalFromGui 建一个 goal 快照（mergeGoalWidget 要 merge 到已有 goal）
      store.setGoalMeta('s1', { objective: '目标', slug: 'do-x' })
      const widgetLines = [
        '◆ do-x Turn 6 | 2.0k tokens | 0m3s | ⊘ Blocked',
      ]
      const consumed = routeWidget('s1', 'goal', widgetLines)
      expect(consumed).toBe(true)
      const goal = store.getGoal('s1')
      expect(goal?.liveStatus).toBe('blocked')
    })

    it('todo widget → 被消费（返回 true）但不写 store（no-op，权威是 details.todos）', () => {
      const store = useTasksStore()
      const consumed = routeWidget('s1', 'todo', ['✓ 3/3'])
      expect(consumed).toBe(true)
      // todo widget 不该写 store（无 isVerification，权威数据来自 tool result）
      expect(store.hasData('s1')).toBe(false)
    })

    it('goal/todo status → 被消费（返回 true）但不显示（no-op，TasksPanel 已有更完整展示）', () => {
      const consumedGoal = routeStatus('s1', 'goal', '◆ Turn 6', '◆ Turn 6')
      const consumedTodo = routeStatus('s1', 'todo', '✓ 3/3', '✓ 3/3')
      expect(consumedGoal).toBe(true)
      expect(consumedTodo).toBe(true)
    })

    it('widgetKey 大小写不敏感（GOAL/Goal/goal 都命中）', () => {
      expect(routeWidget('s1', 'GOAL', ['x'])).toBe(true)
      expect(routeWidget('s1', 'Goal', ['x'])).toBe(true)
    })
  })

  describe('自定义 adapter 注册', () => {
    it('注册自定义 adapter 后命中其 onWidget', () => {
      const onWidget = vi.fn()
      __resetExtensionRegistry()
      registerKnownExtension({
        widgetKeys: ['my-ext'],
        statusKeys: [],
        onWidget,
      })
      expect(routeWidget('s1', 'my-ext', ['line'])).toBe(true)
      expect(onWidget).toHaveBeenCalledWith('s1', 'my-ext', ['line'])
    })

    it('adapter 无 onStatus 时 statusKey 命中也返回 false（让通用管线处理）', () => {
      __resetExtensionRegistry()
      registerKnownExtension({
        widgetKeys: [],
        statusKeys: ['my-status'],
        // 故意不提供 onStatus
      })
      expect(routeStatus('s1', 'my-status', 'text', undefined)).toBe(false)
    })

    it('重复注册同一 adapter 幂等（HMR 场景）', () => {
      __resetExtensionRegistry()
      const onWidget = vi.fn()
      const adapter = { widgetKeys: ['ext'], statusKeys: [], onWidget }
      registerKnownExtension(adapter)
      registerKnownExtension(adapter) // 重复
      routeWidget('s1', 'ext', ['x'])
      expect(onWidget).toHaveBeenCalledTimes(1) // 不重复触发
    })
  })
})
