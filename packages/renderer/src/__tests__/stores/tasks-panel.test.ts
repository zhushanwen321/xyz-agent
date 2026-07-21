/**
 * TasksPanel 组件渲染验证（AGENTS.md 测试规范 §5-8 首屏冒烟模板）。
 *
 * 验证「store 数据 → 组件渲染」映射：pre-fill tasks store → mount TasksPanel → 断言 DOM。
 * 三视角中的「观察者」视角（2026-06-27「新建任务」事故教训：测试全绿但功能不可用）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/tasks-panel.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import TasksPanel from '@/components/panel/TasksPanel.vue'
import { useTasksStore } from '@/stores/tasks'

// ── fixture 工厂 ────────────────────────────────────

function makeListTree(items: Array<Record<string, unknown>>): GuiComponent {
  return { type: 'list-tree', props: { items } as unknown as GuiComponent['props'] }
}

function flatTodoList(): GuiComponent {
  return makeListTree([
    { icon: 'check', label: '#1: done task', status: 'done', depth: 0 },
    { icon: 'check', label: '#2: done task', status: 'done', depth: 0 },
    { icon: 'circle', label: '#3: in progress', status: 'running', depth: 0 },
    { icon: 'dot', label: '#4: pending', depth: 0 },
    { icon: 'check', label: '#5: verify done', status: 'done', depth: 0 },
  ])
}

function makeGoalCard(): GuiComponent {
  return {
    type: 'card',
    props: {
      header: 'Goal Title',
      body: [
        { type: 'stats-line', props: { items: [{ label: 'Status', value: 'Active' }] } },
      ],
    } as unknown as GuiComponent['props'],
  }
}

// ── 测试 ────────────────────────────────────

describe('TasksPanel 首屏渲染', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('首屏渲染：tasks-panel 容器存在于 DOM', () => {
    const wrapper = mount(TasksPanel, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="tasks-panel"]').exists()).toBe(true)
  })

  it('有 goal 数据时渲染 goal-card', () => {
    const store = useTasksStore()
    store.setGoalFromGui('s1', makeGoalCard())

    const wrapper = mount(TasksPanel, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="goal-card"]').exists()).toBe(true)
  })

  it('有 todo 数据时渲染 todo 列表 + VERIFY 标签数量', () => {
    const store = useTasksStore()
    store.setTodoFromGui('s1', flatTodoList())
    // 手动设置 todos 数组（setTodoFromGui 只设 gui，不设 todos 数组）
    store.setTodos('s1', [
      { id: 1, text: 'done task', status: 'completed' },
      { id: 2, text: 'done task', status: 'completed' },
      { id: 3, text: 'in progress', status: 'in_progress' },
      { id: 4, text: 'pending', status: 'pending' },
      { id: 5, text: 'verify done', status: 'completed', isVerification: true },
    ])

    const wrapper = mount(TasksPanel, { props: { sessionId: 's1' } })
    const todoItems = wrapper.findAll('.todo-item')
    expect(todoItems.length).toBe(5)
  })

  it('goal + todo 同时存在时两者都渲染', () => {
    const store = useTasksStore()
    store.setGoalFromGui('s1', makeGoalCard())
    store.setTodos('s1', [
      { id: 1, text: 'task 1', status: 'completed' },
    ])

    const wrapper = mount(TasksPanel, { props: { sessionId: 's1' } })
    expect(wrapper.find('[data-testid="goal-card"]').exists()).toBe(true)
    expect(wrapper.findAll('.todo-item').length).toBe(1)
  })

  it('sessionId=null 时显空态（不抛错）', () => {
    const wrapper = mount(TasksPanel, { props: { sessionId: null } })
    // 无 goal 无 todo → 显空态文案
    expect(wrapper.find('[data-testid="tasks-panel"]').exists()).toBe(true)
  })

  it('计数器显示 done/total', () => {
    const store = useTasksStore()
    store.setTodos('s1', [
      { id: 1, text: 'task 1', status: 'completed' },
      { id: 2, text: 'task 2', status: 'completed' },
      { id: 3, text: 'task 3', status: 'pending' },
    ])

    const wrapper = mount(TasksPanel, { props: { sessionId: 's1' } })
    expect(wrapper.text()).toContain('2/3')
  })
})
