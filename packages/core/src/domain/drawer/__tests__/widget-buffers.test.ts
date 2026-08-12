/**
 * drawer widget 缓冲容器单测（TC1）。
 *
 * 覆盖：mapWidgetKeyToTab 路由三分支（terminal 关键词/browser 关键词/unknown fallback）/
 * truncateLines 截断保留尾部 / updateWidget 按 tab 路由写入 + unknown fallback +
 * activeLinesMeta.unknown 标记 / updateWidgetGui 覆盖纯文本（activeGuiComponent 优先）/
 * gui:null 清除（删条目 + 清纯文本 lines）/ updateStatus 同 key 覆盖 / 分区隔离切回恢复。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/widget-buffers.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { createDrawerBuffers, mapWidgetKeyToTab, truncateLines, WIDGET_MAX_LINES, MAX_STATUS_KEYS } from '../widget-buffers'
import type { SideDrawerTab } from '../types'

function mkGui(kind: string): GuiComponent {
  return { kind, props: {} } as unknown as GuiComponent
}

/** 测试夹具：独立的 sessionIdRef + activeTabRef + 容器实例（工厂形态，per-instance 隔离） */
function makeFixture() {
  const sessionIdRef = ref<string | null>('S1')
  const activeTabRef = ref<SideDrawerTab>('terminal')
  const buffers = createDrawerBuffers(sessionIdRef, activeTabRef)
  return { sessionIdRef, activeTabRef, buffers }
}

describe('mapWidgetKeyToTab 路由', () => {
  it('terminal 关键词 → terminal', () => {
    expect(mapWidgetKeyToTab('my-terminal')).toBe('terminal')
    expect(mapWidgetKeyToTab('shell-output')).toBe('terminal')
    expect(mapWidgetKeyToTab('console')).toBe('terminal')
    expect(mapWidgetKeyToTab('bash-run')).toBe('terminal')
  })

  it('browser 关键词 → browser', () => {
    expect(mapWidgetKeyToTab('browser-view')).toBe('browser')
    expect(mapWidgetKeyToTab('web')).toBe('browser')
    expect(mapWidgetKeyToTab('webview')).toBe('browser')
    expect(mapWidgetKeyToTab('live-preview')).toBe('browser')
  })

  it('未匹配 → null（调用方走 fallback）', () => {
    expect(mapWidgetKeyToTab('custom-widget')).toBeNull()
    expect(mapWidgetKeyToTab('')).toBeNull()
  })
})

describe('truncateLines 截断', () => {
  it('超 WIDGET_MAX_LINES 保留尾部最新', () => {
    const lines = Array.from({ length: WIDGET_MAX_LINES + 200 }, (_, i) => `line-${i}`)
    const truncated = truncateLines(lines)
    expect(truncated.length).toBe(WIDGET_MAX_LINES)
    expect(truncated[0]).toBe('line-200')
    expect(truncated[WIDGET_MAX_LINES - 1]).toBe(`line-${WIDGET_MAX_LINES + 199}`)
  })

  it('未超限原样返回', () => {
    const lines = ['a', 'b']
    expect(truncateLines(lines)).toBe(lines)
  })
})

describe('updateWidget 按 tab 路由写入', () => {
  it('terminal 关键词写入 terminalLines，activeLines 跟随', () => {
    const { buffers, activeTabRef } = makeFixture()
    activeTabRef.value = 'terminal'
    buffers.updateWidget('S1', 'terminal-output', ['t1', 't2'])
    expect(buffers.activeLines.value).toEqual(['t1', 't2'])
    expect(buffers.activeLinesMeta.value).toEqual({ unknown: false, key: '' })
  })

  it('browser 关键词写入 browserLines，activeTab=browser 时展示', () => {
    const { buffers, activeTabRef } = makeFixture()
    buffers.updateWidget('S1', 'browser-view', ['b1'])
    activeTabRef.value = 'browser'
    expect(buffers.activeLines.value).toEqual(['b1'])
    expect(buffers.activeLinesMeta.value).toEqual({ unknown: false, key: '' })
  })

  it('unknown widget → fallback：terminal 空时 activeLines 回退 unknownWidget.lines + meta.unknown=true', () => {
    const { buffers, activeTabRef } = makeFixture()
    activeTabRef.value = 'terminal'
    buffers.updateWidget('S1', 'custom-widget', ['c1', 'c2'])
    expect(buffers.activeLines.value).toEqual(['c1', 'c2'])
    expect(buffers.activeLinesMeta.value).toEqual({ unknown: true, key: 'custom-widget' })
  })

  it('unknown widget 后 terminal 有数据 → terminal 优先', () => {
    const { buffers } = makeFixture()
    buffers.updateWidget('S1', 'custom-widget', ['c1'])
    buffers.updateWidget('S1', 'terminal-output', ['t1'])
    expect(buffers.activeLines.value).toEqual(['t1'])
    expect(buffers.activeLinesMeta.value).toEqual({ unknown: false, key: '' })
  })
})

describe('updateWidgetGui 覆盖纯文本 + gui:null 清除', () => {
  it('gui 写入后 activeGuiComponent 命中（优先于纯文本 lines）', () => {
    const { buffers, activeTabRef } = makeFixture()
    activeTabRef.value = 'terminal'
    buffers.updateWidget('S1', 'terminal-output', ['plain'])
    buffers.updateWidgetGui('S1', 'terminal-output', mkGui('markdown'))
    expect(buffers.activeGuiComponent.value).toBeDefined()
  })

  it('未匹配 tab 的 widgetGui 归 terminal', () => {
    const { buffers } = makeFixture()
    buffers.updateWidgetGui('S1', 'custom-gui', mkGui('markdown'))
    expect(buffers.activeGuiComponent.value).toBeDefined()
  })

  it('gui:null 清除：删结构化组件 + 清对应 tab 纯文本 lines', () => {
    const { buffers, activeTabRef } = makeFixture()
    activeTabRef.value = 'terminal'
    buffers.updateWidget('S1', 'terminal-output', ['plain'])
    buffers.updateWidgetGui('S1', 'terminal-output', mkGui('markdown'))
    expect(buffers.activeGuiComponent.value).toBeDefined()
    buffers.updateWidgetGui('S1', 'terminal-output', null)
    expect(buffers.activeGuiComponent.value).toBeUndefined()
    expect(buffers.activeLines.value).toEqual([]) // 纯文本 lines 也被清
  })

  it('browser tab 的 gui:null 清 browser lines', () => {
    const { buffers, activeTabRef } = makeFixture()
    buffers.updateWidget('S1', 'browser-view', ['b1'])
    buffers.updateWidgetGui('S1', 'browser-view', mkGui('webview'))
    activeTabRef.value = 'browser'
    expect(buffers.activeGuiComponent.value).toBeDefined()
    buffers.updateWidgetGui('S1', 'browser-view', null)
    expect(buffers.activeGuiComponent.value).toBeUndefined()
    expect(buffers.activeLines.value).toEqual([])
  })
})

describe('updateStatus 同 key 覆盖', () => {
  it('同 statusKey 覆盖（新 text 替换旧 text）', () => {
    const { buffers } = makeFixture()
    buffers.updateStatus('S1', 'cpu', '10%')
    expect(buffers.statusEntries.value).toEqual([{ statusKey: 'cpu', text: '10%', textRaw: undefined }])
    buffers.updateStatus('S1', 'cpu', '20%', '\x1b[31m20%\x1b[0m')
    expect(buffers.statusEntries.value).toEqual([
      { statusKey: 'cpu', text: '20%', textRaw: '\x1b[31m20%\x1b[0m' },
    ])
  })

  it('多 statusKey 聚合', () => {
    const { buffers } = makeFixture()
    buffers.updateStatus('S1', 'cpu', '10%')
    buffers.updateStatus('S1', 'mem', '50%')
    expect(buffers.statusEntries.value).toHaveLength(2)
  })

  it('statusMap 条目上限（大量唯一 key 内存有界：超限淘汰最早插入的 key）', () => {
    const { buffers } = makeFixture()
    for (let i = 0; i < MAX_STATUS_KEYS + 20; i++) {
      buffers.updateStatus('S1', `key-${i}`, `v-${i}`)
    }
    const entries = buffers.statusEntries.value
    expect(entries).toHaveLength(MAX_STATUS_KEYS)
    // 最早 20 个 key 被淘汰，保留 key-20..key-(MAX+19)，插入序保持
    expect(entries[0]).toEqual({ statusKey: 'key-20', text: 'v-20', textRaw: undefined })
    expect(entries[MAX_STATUS_KEYS - 1]).toEqual({
      statusKey: `key-${MAX_STATUS_KEYS + 19}`,
      text: `v-${MAX_STATUS_KEYS + 19}`,
      textRaw: undefined,
    })
  })

  it('已达上限时覆盖既有 key 不触发淘汰（同 key 覆盖语义不变）', () => {
    const { buffers } = makeFixture()
    for (let i = 0; i < MAX_STATUS_KEYS; i++) {
      buffers.updateStatus('S1', `key-${i}`, `v-${i}`)
    }
    buffers.updateStatus('S1', 'key-0', 'updated')
    expect(buffers.statusEntries.value).toHaveLength(MAX_STATUS_KEYS)
    expect(buffers.statusEntries.value[0]).toEqual({ statusKey: 'key-0', text: 'updated', textRaw: undefined })
  })
})

describe('per-session 分区隔离', () => {
  it('切 sid 隔离 + 切回恢复（AC-4）', () => {
    const { sessionIdRef, buffers, activeTabRef } = makeFixture()
    activeTabRef.value = 'terminal'
    buffers.updateWidget('S1', 'terminal-output', ['s1-line'])
    // 切到 S2：新分区为空
    sessionIdRef.value = 'S2'
    expect(buffers.activeLines.value).toEqual([])
    buffers.updateWidget('S2', 'terminal-output', ['s2-line'])
    expect(buffers.activeLines.value).toEqual(['s2-line'])
    // 切回 S1：恢复缓冲
    sessionIdRef.value = 'S1'
    expect(buffers.activeLines.value).toEqual(['s1-line'])
  })

  it('updateFor 显式 sid：非当前 sid 写入不影响当前分区', () => {
    const { buffers } = makeFixture()
    // 当前 sid=S1；显式写 S2 分区
    buffers.updateWidget('S2', 'terminal-output', ['s2-line'])
    expect(buffers.activeLines.value).toEqual([]) // S1 分区无数据
  })
})
