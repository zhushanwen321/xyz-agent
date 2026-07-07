import { describe, it, expect } from 'vitest'
import type { PanelTree } from '@xyz-agent/shared'
import {
  findPanelBySessionId,
  initialWindowState,
  MAX_PANEL_DEPTH,
} from '../window/panel-tree-utils.js'

const leaf = (id: string, sessionId: string | null): PanelTree => ({
  type: 'panel',
  id,
  sessionId,
})
const split = (id: string, a: PanelTree, b: PanelTree): PanelTree => ({
  type: 'split',
  id,
  direction: 'horizontal',
  children: [a, b],
  ratio: 0.5,
})

describe('findPanelBySessionId', () => {
  it('returns id when leaf sessionId matches', () => {
    expect(findPanelBySessionId(leaf('p1', 's1'), 's1')).toBe('p1')
  })

  it('returns null when leaf sessionId does not match', () => {
    expect(findPanelBySessionId(leaf('p1', 's1'), 'other')).toBe(null)
    expect(findPanelBySessionId(leaf('p1', null), 's1')).toBe(null)
  })

  it('finds target in left child of a split', () => {
    const tree = split('root', leaf('left', 's1'), leaf('right', 's2'))
    expect(findPanelBySessionId(tree, 's1')).toBe('left')
  })

  it('finds target in right child of a split', () => {
    const tree = split('root', leaf('left', 's1'), leaf('right', 's2'))
    expect(findPanelBySessionId(tree, 's2')).toBe('right')
  })

  it('returns null when sessionId absent in mixed leaf/split tree', () => {
    const tree = split('root', split('mid', leaf('a', 's1'), leaf('b', null)), leaf('c', 's2'))
    expect(findPanelBySessionId(tree, 'missing')).toBe(null)
  })

  it('returns null when depth exceeds MAX_PANEL_DEPTH (stack overflow guard)', () => {
    // Build a left-heavy chain deeper than MAX_PANEL_DEPTH; target only at the bottom.
    let node: PanelTree = leaf('deep-leaf', 'target')
    for (let i = 0; i < MAX_PANEL_DEPTH + 1; i++) {
      node = split(`split-${i}`, node, leaf(`sib-${i}`, null))
    }
    // target exists deep but exceeds depth limit → must not recurse into it
    expect(findPanelBySessionId(node, 'target')).toBe(null)
  })

  it('finds target when depth is exactly at the limit boundary', () => {
    let node: PanelTree = leaf('deep-leaf', 'target')
    for (let i = 0; i < MAX_PANEL_DEPTH; i++) {
      node = split(`split-${i}`, node, leaf(`sib-${i}`, null))
    }
    expect(findPanelBySessionId(node, 'target')).toBe('deep-leaf')
  })
})

describe('initialWindowState', () => {
  it('produces a single-panel tree with panel- prefix', () => {
    const ws = initialWindowState('win1')
    expect(ws.windowId).toBe('win1')
    expect(ws.panelTree.type).toBe('panel')
  })

  it('uses panel- prefix (not pane-) for panel id', () => {
    const ws = initialWindowState('win1')
    const tree = ws.panelTree
    expect(tree.type === 'panel' && tree.id).toBe('panel-win1')
    expect(tree.type === 'panel' && tree.sessionId).toBe(null)
  })

  it('keeps focusedPanelId consistent with the panel id', () => {
    const ws = initialWindowState('win2')
    expect(ws.focusedPanelId).toBe('panel-win2')
  })

  it('starts with empty sessionIds', () => {
    const ws = initialWindowState('win3')
    expect(ws.sessionIds).toEqual([])
  })
})
