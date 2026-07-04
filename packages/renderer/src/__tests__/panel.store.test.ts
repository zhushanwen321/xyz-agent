/**
 * Panel store 单测 —— PanelTree 状态机（单/双 panel 切换 + 不可变更新）。
 *
 * 覆盖：
 * - 初始态：isDual=false、panels 长度 1、activePanelId=ROOT_PANEL_ID
 * - split：单→双、isDual=true、active=left.id、layout 对象替换（不可变）
 * - split 已 dual 时 no-op
 * - close：双→单、active=kept.id
 * - close 已 single 时 no-op
 * - loadSession：不可变更新触发响应式（leaf 对象替换）
 * - loadSession 对不存在的 panelId no-op
 * - setActive 已知 id / 未知 id no-op
 * - findPanelBySession 命中 / null
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel.store.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'

describe('usePanelStore PanelTree 状态机', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('初始态：单 panel、isDual=false、panels 长度 1', () => {
    const panel = usePanelStore()
    expect(panel.isDual).toBe(false)
    expect(panel.panels).toHaveLength(1)
    expect(panel.panels[0].id).toBe(ROOT_PANEL_ID)
    expect(panel.activePanelId).toBe(ROOT_PANEL_ID)
  })

  it('split：单→双，isDual=true，active=left.id（原根保留为左）', () => {
    const panel = usePanelStore()
    const layoutBefore = panel.layout
    panel.split()
    expect(panel.isDual).toBe(true)
    expect(panel.panels).toHaveLength(2)
    expect(panel.panels[0].id).toBe(ROOT_PANEL_ID) // 左 = 原根
    expect(panel.activePanelId).toBe(ROOT_PANEL_ID)
    // layout 对象被替换（不可变，触发响应式）
    expect(panel.layout).not.toBe(layoutBefore)
  })

  it('split 已 dual 时 no-op', () => {
    const panel = usePanelStore()
    panel.split()
    const layoutBefore = panel.layout
    panel.split()
    expect(panel.layout).toBe(layoutBefore)
    expect(panel.panels).toHaveLength(2)
  })

  it('close：双→单，关闭左侧则 active=右侧 id', () => {
    const panel = usePanelStore()
    panel.split()
    const [left, right] = panel.panels
    panel.close(left.id) // 关左 → 保留右
    expect(panel.isDual).toBe(false)
    expect(panel.panels).toHaveLength(1)
    expect(panel.panels[0].id).toBe(right.id)
    expect(panel.activePanelId).toBe(right.id)
  })

  it('close：双→单，关闭右侧则 active=左侧 id', () => {
    const panel = usePanelStore()
    panel.split()
    const [left, right] = panel.panels
    panel.close(right.id) // 关右 → 保留左
    expect(panel.isDual).toBe(false)
    expect(panel.panels).toHaveLength(1)
    expect(panel.panels[0].id).toBe(left.id)
    expect(panel.activePanelId).toBe(left.id)
  })

  it('close 已 single 时 no-op', () => {
    const panel = usePanelStore()
    panel.close(ROOT_PANEL_ID)
    expect(panel.isDual).toBe(false)
    expect(panel.panels).toHaveLength(1)
  })

  it('loadSession：目标 leaf 不可变替换（原 leaf 对象引用改变）', () => {
    const panel = usePanelStore()
    const leafBefore = panel.panels[0]
    panel.loadSession(ROOT_PANEL_ID, 's-load')
    const leafAfter = panel.panels[0]
    expect(leafAfter.sessionId).toBe('s-load')
    // leaf 对象被替换（不可变更新，非就地突变），保证 Vue 响应式触发
    expect(leafAfter).not.toBe(leafBefore)
  })

  it('loadSession 对不存在的 panelId 是 no-op', () => {
    const panel = usePanelStore()
    const layoutBefore = panel.layout
    panel.loadSession('no-such-panel', 's1')
    expect(panel.layout).toBe(layoutBefore)
  })

  it('setActive 已知 panel id → activePanelId 更新', () => {
    const panel = usePanelStore()
    panel.split()
    const [, right] = panel.panels
    panel.setActive(right.id)
    expect(panel.activePanelId).toBe(right.id)
  })

  it('setActive 未知 id → no-op（不越界设值）', () => {
    const panel = usePanelStore()
    const before = panel.activePanelId
    panel.setActive('unknown-id')
    expect(panel.activePanelId).toBe(before)
  })

  it('findPanelBySession：命中返回叶子，未命中返回 null', () => {
    const panel = usePanelStore()
    expect(panel.findPanelBySession('s1')).toBeNull()
    panel.loadSession(ROOT_PANEL_ID, 's-x')
    const found = panel.findPanelBySession('s-x')
    expect(found?.id).toBe(ROOT_PANEL_ID)
  })
})
