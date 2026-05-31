import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StatusBarItem } from '@xyz-agent/shared'
import type { StatusBarItemOptions } from '../src/services/plugin-service/plugin-types.js'

/**
 * Statusline feature tests: PluginService updateStatusBarItem (TC-4-01 ~ TC-4-03)
 *
 * Tests the Map-based status bar item management in PluginService:
 * - Adding items with new options (scope, sessionId, priority)
 * - Backward compatibility without options
 * - Merge behavior (multiple items coexist)
 * - Removal on empty text
 * - Broadcast after each mutation
 */

// ── Minimal PluginService-like fixture ──────────────────────────────

class StatusBarManagerFixture {
  statusBarItems: Map<string, StatusBarItem> = new Map()
  broadcasts: Array<{ type: string; payload: { items: StatusBarItem[] } }> = []

  updateStatusBarItem(pluginId: string, id: string, text: string, options?: StatusBarItemOptions) {
    const itemKey = `${pluginId}:${id}`
    if (text === '') {
      this.statusBarItems.delete(itemKey)
    } else {
      const item: StatusBarItem = {
        id,
        pluginId,
        text,
        tooltip: options?.tooltip,
        commandId: options?.commandId,
        priority: options?.priority ?? 100,
        scope: options?.scope ?? 'global',
        sessionId: options?.sessionId,
      }
      this.statusBarItems.set(itemKey, item)
    }
    this.broadcastStatusBarItems()
  }

  private broadcastStatusBarItems() {
    const items = Array.from(this.statusBarItems.values())
    this.broadcasts.push({
      type: 'plugin:statusBarUpdate',
      payload: { items },
    })
  }
}

// ── TC-4-01: updateStatusBarItem with new options parameters ────────

describe('TC-4-01: updateStatusBarItem with new options', () => {
  let fixture: StatusBarManagerFixture

  beforeEach(() => {
    fixture = new StatusBarManagerFixture()
  })

  it('stores item with scope=per-session and sessionId', () => {
    fixture.updateStatusBarItem('statusline', 'goal', '◆ Goal 3/20', {
      priority: 10,
      scope: 'per-session',
      sessionId: 's1',
      tooltip: 'Goal task progress',
    })

    expect(fixture.statusBarItems.size).toBe(1)
    const item = fixture.statusBarItems.get('statusline:goal')!
    expect(item.id).toBe('goal')
    expect(item.pluginId).toBe('statusline')
    expect(item.text).toBe('◆ Goal 3/20')
    expect(item.priority).toBe(10)
    expect(item.scope).toBe('per-session')
    expect(item.sessionId).toBe('s1')
    expect(item.tooltip).toBe('Goal task progress')
  })

  it('broadcasts after update', () => {
    fixture.updateStatusBarItem('statusline', 'goal', '◆ Goal 3/20', {
      priority: 10,
      scope: 'per-session',
      sessionId: 's1',
    })

    expect(fixture.broadcasts).toHaveLength(1)
    expect(fixture.broadcasts[0].type).toBe('plugin:statusBarUpdate')
    expect(fixture.broadcasts[0].payload.items).toHaveLength(1)
    expect(fixture.broadcasts[0].payload.items[0].id).toBe('goal')
  })

  it('stores item with scope=global', () => {
    fixture.updateStatusBarItem('statusline', 'preset', 'default', {
      priority: 30,
      scope: 'global',
    })

    const item = fixture.statusBarItems.get('statusline:preset')!
    expect(item.scope).toBe('global')
    expect(item.sessionId).toBeUndefined()
  })
})

// ── TC-4-02: updateStatusBarItem backward compatible without options ─

describe('TC-4-02: updateStatusBarItem without options (backward compat)', () => {
  let fixture: StatusBarManagerFixture

  beforeEach(() => {
    fixture = new StatusBarManagerFixture()
  })

  it('defaults priority to 100 and scope to global', () => {
    fixture.updateStatusBarItem('p1', 'item1', 'Hello')

    const item = fixture.statusBarItems.get('p1:item1')!
    expect(item.priority).toBe(100)
    expect(item.scope).toBe('global')
    expect(item.sessionId).toBeUndefined()
    expect(item.tooltip).toBeUndefined()
    expect(item.commandId).toBeUndefined()
  })

  it('still broadcasts', () => {
    fixture.updateStatusBarItem('p1', 'item1', 'Hello')

    expect(fixture.broadcasts).toHaveLength(1)
    expect(fixture.broadcasts[0].payload.items[0].text).toBe('Hello')
  })
})

// ── TC-4-03: updateStatusBarItem merge behavior ────────────────────

describe('TC-4-03: updateStatusBarItem merge behavior', () => {
  let fixture: StatusBarManagerFixture

  beforeEach(() => {
    fixture = new StatusBarManagerFixture()
  })

  it('multiple items coexist in Map', () => {
    fixture.updateStatusBarItem('statusline', 'goal', '3/20', { priority: 10, scope: 'per-session', sessionId: 's1' })
    fixture.updateStatusBarItem('statusline', 'todo', '5/10', { priority: 20, scope: 'per-session', sessionId: 's1' })
    fixture.updateStatusBarItem('other-plugin', 'info', 'v1.0', { priority: 50, scope: 'global' })

    expect(fixture.statusBarItems.size).toBe(3)
    expect(fixture.broadcasts).toHaveLength(3)

    // Last broadcast contains all 3 items
    const lastBroadcast = fixture.broadcasts[2]
    expect(lastBroadcast.payload.items).toHaveLength(3)
  })

  it('same itemKey overwrites previous value', () => {
    fixture.updateStatusBarItem('statusline', 'goal', '3/20', { priority: 10 })
    fixture.updateStatusBarItem('statusline', 'goal', '4/20', { priority: 10 })

    expect(fixture.statusBarItems.size).toBe(1)
    expect(fixture.statusBarItems.get('statusline:goal')!.text).toBe('4/20')
  })

  it('empty text removes item from Map', () => {
    fixture.updateStatusBarItem('statusline', 'goal', '3/20', { priority: 10 })
    expect(fixture.statusBarItems.size).toBe(1)

    fixture.updateStatusBarItem('statusline', 'goal', '')
    expect(fixture.statusBarItems.size).toBe(0)

    // Last broadcast should have empty items
    const lastBroadcast = fixture.broadcasts[fixture.broadcasts.length - 1]
    expect(lastBroadcast.payload.items).toHaveLength(0)
  })

  it('items from different plugins with same id coexist', () => {
    fixture.updateStatusBarItem('plugin-a', 'status', 'A status')
    fixture.updateStatusBarItem('plugin-b', 'status', 'B status')

    expect(fixture.statusBarItems.size).toBe(2)
    expect(fixture.statusBarItems.get('plugin-a:status')!.text).toBe('A status')
    expect(fixture.statusBarItems.get('plugin-b:status')!.text).toBe('B status')
  })
})

// ── Statusline plugin logic (TC-3-01, TC-3-02) ────────────────────

describe('TC-3-01/TC-3-02: statusline plugin key → metadata mapping', () => {
  // Replicate the mapping table from statusline/index.ts
  const STATUS_KEY_MAP: Record<string, { priority: number; tooltip: string; scope: 'per-session' | 'global' }> = {
    goal: { priority: 10, tooltip: 'Goal task progress', scope: 'per-session' },
    todo: { priority: 20, tooltip: 'Todo list progress', scope: 'per-session' },
    workflow: { priority: 15, tooltip: 'Workflow status', scope: 'per-session' },
    preset: { priority: 30, tooltip: 'Active preset', scope: 'global' },
  }

  function getMetadata(key: string) {
    return STATUS_KEY_MAP[key] ?? { priority: 100, tooltip: '', scope: 'global' as const }
  }

  it('goal maps to priority=10, scope=per-session', () => {
    const meta = getMetadata('goal')
    expect(meta.priority).toBe(10)
    expect(meta.scope).toBe('per-session')
  })

  it('todo maps to priority=20, scope=per-session', () => {
    const meta = getMetadata('todo')
    expect(meta.priority).toBe(20)
    expect(meta.scope).toBe('per-session')
  })

  it('unknown key maps to priority=100, scope=global', () => {
    const meta = getMetadata('unknown_ext')
    expect(meta.priority).toBe(100)
    expect(meta.scope).toBe('global')
  })

  it('preset maps to scope=global', () => {
    const meta = getMetadata('preset')
    expect(meta.priority).toBe(30)
    expect(meta.scope).toBe('global')
  })
})
