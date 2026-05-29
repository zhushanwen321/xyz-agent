/**
 * Todo Plugin Unit Tests.
 *
 * Tests the todo tool action handlers and state management.
 *
 * Test strategy:
 * - executeTodoAction() is exported from todo-tool.ts — test it directly
 * - Mock api.sessionData.get/set for state persistence
 * - Pure functions tested inline
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Phase2AgentAPI } from '../src/services/plugin-service/plugin-types.js'

// ── Helper to create mock API ────────────────────────────────

function createMockApi(initialState?: unknown): {
  api: Phase2AgentAPI
  mockGet: ReturnType<typeof vi.fn>
  mockSet: ReturnType<typeof vi.fn>
} {
  const mockGet = vi.fn().mockResolvedValue(initialState)
  const mockSet = vi.fn().mockResolvedValue(undefined)

  const api = {
    sessionData: {
      get: mockGet,
      set: mockSet,
      delete: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
    },
    tools: {
      register: vi.fn().mockResolvedValue(undefined),
      unregister: vi.fn().mockResolvedValue(undefined),
    },
    hooks: {
      onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      onBeforeAgentStart: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      onPiEvent: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
    },
    storage: undefined as never,
    notify: undefined as never,
    sessions: undefined as never,
    events: undefined as never,
    config: undefined as never,
    ui: undefined as never,
    agent: undefined as never,
    workspace: undefined as never,
  } as unknown as Phase2AgentAPI

  return { api, mockGet, mockSet }
}

const SESSION_ID = 'test-session'
const SESSION_DATA_KEY = 'todo-state'

// ── Tests ──────────────────────────────────────────────────────

describe('Todo plugin', () => {
  // ── 1. add — add items ───────────────────────────────────

  describe('add', () => {
    it('adds items to empty state', async () => {
      const { api, mockGet, mockSet } = createMockApi(undefined)
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'add',
        texts: ['Item 1', 'Item 2'],
      })

      expect(result.content[0].text).toContain('已添加 2 项 todo')
      expect(mockGet).toHaveBeenCalledWith(SESSION_ID, SESSION_DATA_KEY)
      expect(mockSet).toHaveBeenCalledWith(SESSION_ID, SESSION_DATA_KEY, expect.objectContaining({
        todos: expect.arrayContaining([
          expect.objectContaining({ id: 1, text: 'Item 1', status: 'pending' }),
          expect.objectContaining({ id: 2, text: 'Item 2', status: 'pending' }),
        ]),
        nextId: 3,
      }))
    })

    it('rejects empty texts array', async () => {
      const { api } = createMockApi(undefined)
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'add',
        texts: [],
      })

      expect(result.content[0].text).toContain('错误')
    })

    it('trims whitespace from texts', async () => {
      const { api, mockGet } = createMockApi(undefined)
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      await executeTodoAction(api, SESSION_ID, {
        action: 'add',
        texts: ['  Item 1  ', '', '  '],
      })

      const savedState = mockGet.mock.calls[0][1] === SESSION_DATA_KEY
        ? undefined
        : undefined
      // Check via mockSet
      const savedCall = (api.sessionData.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const saved = savedCall[2] as { todos: Array<{ text: string }> }
      expect(saved.todos).toHaveLength(1)
      expect(saved.todos[0].text).toBe('Item 1')
    })
  })

  // ── 2. update — change status ────────────────────────────

  describe('update', () => {
    it('changes status of an existing item', async () => {
      const { api } = createMockApi({
        todos: [{ id: 1, text: 'Item 1', status: 'pending' }],
        nextId: 2,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'update',
        id: 1,
        status: 'completed',
      })

      expect(result.content[0].text).toContain('已更新 todo #1')
      expect(result.content[0].text).toContain('状态 → completed')
    })

    it('updates text of an existing item', async () => {
      const { api } = createMockApi({
        todos: [{ id: 1, text: 'Old text', status: 'pending' }],
        nextId: 2,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'update',
        id: 1,
        text: 'New text',
      })

      expect(result.content[0].text).toContain('New text')
    })
  })

  // ── 3. delete — remove items ─────────────────────────────

  describe('delete', () => {
    it('removes existing items', async () => {
      const { api } = createMockApi({
        todos: [
          { id: 1, text: 'Item 1', status: 'pending' },
          { id: 2, text: 'Item 2', status: 'pending' },
          { id: 3, text: 'Item 3', status: 'pending' },
        ],
        nextId: 4,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'delete',
        ids: [1, 3],
      })

      expect(result.content[0].text).toContain('已删除 2 项')
      expect(result.content[0].text).toContain('剩余 1 项')
    })

    it('rejects non-existent ids', async () => {
      const { api } = createMockApi({
        todos: [{ id: 1, text: 'Item 1', status: 'pending' }],
        nextId: 2,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'delete',
        ids: [99],
      })

      expect(result.content[0].text).toContain('错误')
      expect(result.content[0].text).toContain('#99')
    })

    it('handles duplicate ids gracefully', async () => {
      const { api } = createMockApi({
        todos: [{ id: 1, text: 'Item 1', status: 'pending' }],
        nextId: 2,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'delete',
        ids: [1, 1],
      })

      expect(result.content[0].text).toContain('已删除 1 项')
    })
  })

  // ── 4. clear — empty list ───────────────────────────────

  describe('clear', () => {
    it('clears all items and resets nextId', async () => {
      const { api } = createMockApi({
        todos: [
          { id: 1, text: 'Item 1', status: 'pending' },
          { id: 2, text: 'Item 2', status: 'completed' },
        ],
        nextId: 3,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, { action: 'clear' })

      expect(result.content[0].text).toContain('已清空 2 项 todo')

      // Verify state was cleared
      const savedCall = (api.sessionData.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const saved = savedCall[2] as { todos: unknown[]; nextId: number }
      expect(saved.todos).toHaveLength(0)
      expect(saved.nextId).toBe(1)
    })

    it('says nothing to clear when already empty', async () => {
      const { api } = createMockApi({
        todos: [],
        nextId: 1,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, { action: 'clear' })

      expect(result.content[0].text).toContain('暂无 todo，无需清空')
    })
  })

  // ── 5. list — view all ──────────────────────────────────

  describe('list', () => {
    it('lists all items with correct status markers', async () => {
      const { api } = createMockApi({
        todos: [
          { id: 1, text: 'Pending item', status: 'pending' },
          { id: 2, text: 'In progress', status: 'in_progress' },
          { id: 3, text: 'Completed', status: 'completed' },
        ],
        nextId: 4,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, { action: 'list' })

      const text = result.content[0].text
      expect(text).toContain('[ ] #1')
      expect(text).toContain('[~] #2')
      expect(text).toContain('[x] #3')
    })

    it('shows empty message when no todos', async () => {
      const { api } = createMockApi({ todos: [], nextId: 1 })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, { action: 'list' })

      expect(result.content[0].text).toBe('暂无 todo')
    })
  })

  // ── 6. Auto-increment ID ────────────────────────────────

  describe('auto-increment ID', () => {
    it('assigns sequential IDs: 1, 2, 3', async () => {
      const { api } = createMockApi(undefined)
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      await executeTodoAction(api, SESSION_ID, {
        action: 'add',
        texts: ['First', 'Second', 'Third'],
      })

      const savedCall = (api.sessionData.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const saved = savedCall[2] as { todos: Array<{ id: number }> }
      expect(saved.todos[0].id).toBe(1)
      expect(saved.todos[1].id).toBe(2)
      expect(saved.todos[2].id).toBe(3)
    })

    it('continues from existing nextId', async () => {
      const { api } = createMockApi({
        todos: [{ id: 5, text: 'Existing', status: 'pending' }],
        nextId: 6,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      await executeTodoAction(api, SESSION_ID, {
        action: 'add',
        texts: ['New item'],
      })

      const savedCall = (api.sessionData.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const saved = savedCall[2] as { todos: Array<{ id: number }> }
      expect(saved.todos[1].id).toBe(6)
    })
  })

  // ── 7. update non-existent ID → error ───────────────────

  describe('update non-existent ID', () => {
    it('returns error when id does not exist', async () => {
      const { api } = createMockApi({
        todos: [{ id: 1, text: 'Item 1', status: 'pending' }],
        nextId: 2,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'update',
        id: 99,
        status: 'completed',
      })

      expect(result.content[0].text).toContain('Todo #99 不存在')
    })

    it('returns error when id is not provided', async () => {
      const { api } = createMockApi(undefined)
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'update',
        status: 'completed',
      })

      expect(result.content[0].text).toContain('错误')
    })
  })

  // ── 8. State restore from sessionData ───────────────────

  describe('State restore', () => {
    it('restoreTodoState loads state from sessionData', async () => {
      const savedState = {
        todos: [
          { id: 1, text: 'Restored item', status: 'pending' },
          { id: 2, text: 'Another', status: 'completed' },
        ],
        nextId: 3,
      }
      const { api } = createMockApi(savedState)
      const { restoreTodoState } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const state = await restoreTodoState(api, SESSION_ID)

      expect(state.todos).toHaveLength(2)
      expect(state.nextId).toBe(3)
      expect(state.todos[0].text).toBe('Restored item')
    })

    it('restoreTodoState returns empty state when no saved data', async () => {
      const { api } = createMockApi(undefined)
      const { restoreTodoState } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const state = await restoreTodoState(api, SESSION_ID)

      expect(state.todos).toHaveLength(0)
      expect(state.nextId).toBe(1)
    })
  })

  // ── 9. registerTodoTool + hooks ─────────────────────────

  describe('Tool registration', () => {
    it('registerTodoTool registers tool schema', async () => {
      const mockRegister = vi.fn().mockResolvedValue(undefined)
      const { api } = createMockApi(undefined)
      api.tools.register = mockRegister

      const { registerTodoTool } = await import('../../../resources/plugins/todo/src/todo-tool.js')
      await registerTodoTool(api)

      expect(mockRegister).toHaveBeenCalledTimes(1)
      const schema = mockRegister.mock.calls[0][0]
      expect(schema.name).toBe('todo')
      expect(schema.description).toContain('管理 todo 清单')
      expect(schema.parameters.properties.action.enum).toEqual(['list', 'add', 'update', 'delete', 'clear'])
    })

    it('todo plugin activate registers tool and session_start hook', async () => {
      // Import the actual activate function from the plugin entry
      const mockRegister = vi.fn().mockResolvedValue(undefined)
      const mockOnPiEvent = vi.fn().mockResolvedValue({ dispose: vi.fn() })
      const subscriptions: Array<{ dispose(): void }> = []

      const { activate } = await import('../../../resources/plugins/todo/index.js')

      const context = {
        pluginId: 'todo',
        pluginPath: '/mock/plugins/todo',
        globalState: {} as never,
        workspaceState: {} as never,
        api: {
          ...createMockApi(undefined).api,
          tools: { register: mockRegister, unregister: vi.fn() },
          hooks: {
            onBeforeSendMessage: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
            onBeforeToolCall: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
            onBeforeAgentStart: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
            onAfterToolResult: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
            onPiEvent: mockOnPiEvent,
          },
        } as unknown as Phase2AgentAPI,
        subscriptions,
      }

      await activate(context)

      expect(mockRegister).toHaveBeenCalledTimes(1)
      expect(mockOnPiEvent).toHaveBeenCalledWith('session_start', expect.any(Function))
      expect(subscriptions).toHaveLength(1)
    })
  })

  // ── Validation: invalid parameters ──────────────────────

  describe('Validation', () => {
    it('rejects update with invalid status', async () => {
      const { api } = createMockApi({
        todos: [{ id: 1, text: 'Item', status: 'pending' }],
        nextId: 2,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'update',
        id: 1,
        status: 'invalid_status' as never,
      })

      expect(result.content[0].text).toContain('错误')
    })

    it('rejects update with empty text', async () => {
      const { api } = createMockApi({
        todos: [{ id: 1, text: 'Item', status: 'pending' }],
        nextId: 2,
      })
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'update',
        id: 1,
        text: '',
      })

      expect(result.content[0].text).toContain('错误')
    })

    it('rejects unknown action', async () => {
      const { api } = createMockApi(undefined)
      const { executeTodoAction } = await import('../../../resources/plugins/todo/src/todo-tool.js')

      const result = await executeTodoAction(api, SESSION_ID, {
        action: 'unknown_action' as never,
      })

      expect(result.content[0].text).toContain('未知 action')
    })
  })
})
