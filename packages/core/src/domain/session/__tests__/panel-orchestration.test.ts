/**
 * panel-orchestration 单测（IF3 / DM1 / ES3 语义锁定）。
 *
 * 端口注入 mock：PanelOrchestrationPort 用 vi.fn() 构造；模块级 pendingOpenMap 真实使用
 * （Map 行为是契约本体，不 mock）。beforeEach 清理用到的 sid 防跨测试污染。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  setPendingOpenForSid,
  getPendingOpenForSid,
  openPanelOnSessionEvent,
  consumePendingOpen,
  clearPendingOpen,
} from '../effects/panel-orchestration'
import type { PanelOrchestrationPort } from '../effects/panel-orchestration'

function makePort(focused: string | null) {
  return {
    focusedSessionId: vi.fn(() => focused),
    activePanelId: vi.fn(() => 'p1'),
    findPanelBySession: vi.fn(() => null),
    loadSession: vi.fn(),
    openPanel: vi.fn(),
  } satisfies PanelOrchestrationPort
}

describe('openPanelOnSessionEvent', () => {
  beforeEach(() => {
    clearPendingOpen('sid-1')
    clearPendingOpen('sid-2')
    clearPendingOpen('no-mark-sid')
  })

  it('TC-1 focused 命中：openPanel 直调，不置 pendingOpen', () => {
    const port = makePort('sid-1')
    openPanelOnSessionEvent('sid-1', 'tasks', false, port)
    expect(port.openPanel).toHaveBeenCalledTimes(1)
    expect(port.openPanel).toHaveBeenCalledWith('tasks', 'sid-1')
    expect(getPendingOpenForSid('sid-1')).toBeNull()
  })

  it('TC-2 非 focused：setPendingOpen 存 panelId，不调 openPanel', () => {
    const port = makePort('sid-2')
    openPanelOnSessionEvent('sid-1', 'sideDrawer', false, port)
    expect(port.openPanel).not.toHaveBeenCalled()
    expect(getPendingOpenForSid('sid-1')).toBe('sideDrawer')
  })

  it('TC-3 hadDataBefore=true 守卫：即使 focused 命中也不弹、不置标记', () => {
    const port = makePort('sid-1')
    openPanelOnSessionEvent('sid-1', 'tasks', true, port)
    expect(port.openPanel).not.toHaveBeenCalled()
    expect(getPendingOpenForSid('sid-1')).toBeNull()
    // hadDataBefore=false 时 focused 分支正常触发
    openPanelOnSessionEvent('sid-1', 'tasks', false, port)
    expect(port.openPanel).toHaveBeenCalledTimes(1)
  })
})

describe('consumePendingOpen', () => {
  beforeEach(() => {
    clearPendingOpen('sid-1')
    clearPendingOpen('no-mark-sid')
  })

  it('TC-4 消费后按 panelId openPanel + 清标记（幂等）', () => {
    setPendingOpenForSid('sid-1', 'tasks')
    const port = makePort('sid-1')
    consumePendingOpen('sid-1', port)
    expect(port.openPanel).toHaveBeenCalledTimes(1)
    expect(port.openPanel).toHaveBeenCalledWith('tasks', 'sid-1')
    expect(getPendingOpenForSid('sid-1')).toBeNull()
    // 二次消费 no-op（幂等）
    consumePendingOpen('sid-1', port)
    expect(port.openPanel).toHaveBeenCalledTimes(1)
  })

  it('TC-5 无标记时 no-op（不调 openPanel）', () => {
    const port = makePort('sid-1')
    consumePendingOpen('no-mark-sid', port)
    expect(port.openPanel).not.toHaveBeenCalled()
    expect(getPendingOpenForSid('no-mark-sid')).toBeNull()
  })

  it('TC-6 clearPendingOpen：ES3 删除前清理（幂等）', () => {
    setPendingOpenForSid('sid-1', 'tasks')
    clearPendingOpen('sid-1')
    expect(getPendingOpenForSid('sid-1')).toBeNull()
    expect(() => clearPendingOpen('sid-1')).not.toThrow()
  })
})
