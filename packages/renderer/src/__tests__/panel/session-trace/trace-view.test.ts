/**
 * A42/A43 trace 视图与行渲染单测（trace-ui）。
 *
 * A42 SegmentedTab「对话 | Trace」per-pane 视图状态：
 * - PanelHeader 渲染 toggle（两段，chat 默认激活）
 * - 切换只改 store 分区 view 字段：不重发 RPC（数据不重建）
 * - TraceView 卸载（切回对话）再挂载：过滤/选中状态保留 + 仍不重拉
 *
 * A43 行组件渲染：
 * - 12 kind + MALFORMED 行摘要齐全（§3.4 渲染模型表）
 * - 影子化降透明（shadowed 行 opacity 类 + data-shadowed）
 * - 选中态 surface-hover + 强调字色（无 ring，v6 §3.4 列表项型 + SearchModal sm-item 例外）
 * - >500 虚拟滚动启用（不全量渲染）；≤500 全量
 * - BASH meta excludeFromContext（core 小改）行内「不进上下文」注记
 * - kind chips / 搜索 / 仅当前 context toggle / context 分界行
 *
 * 三视角：构建者（fixture 快照驱动 rows 派生）/ 使用者（点击 toggle/行/chip 交互）/
 * 观察者（data-testid + data-kind + class DOM 断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-trace/trace-view.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import type { ServerMessageMap } from '@xyz-agent/shared'
import type { DerivedStatus } from '@/types'

// ── mock '@/api' 门面（store 只消费 session.getTraceEntries）──
const apiMock = vi.hoisted(() => ({ getTraceEntries: vi.fn() }))
vi.mock('@/api', () => ({
  session: { getTraceEntries: apiMock.getTraceEntries },
}))

import PanelHeader from '@/components/panel/PanelHeader.vue'
import TraceView from '@/components/panel/trace/TraceView.vue'
import {
  _resetTraceStoreForTest,
  bindTraceSessionId,
  ensureTraceLoaded,
  selectTraceEntry,
  setTraceFilter,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'

const SID = 'sid-trace-view-1'

/** 12 kind + MALFORMED 全覆盖 fixture（线性链 u1→…→u3，compaction c1 firstKept=u2）。 */
function buildFullKindsSnapshot(): ServerMessageMap['session.traceEntries'] {
  const entries: unknown[] = [
    { type: 'custom', id: 'sp1', parentId: null, customType: 'xyz:system-prompt', data: { version: 2, reason: 'resume', hash: 'aabbcc', charCount: 12702 } },
    { type: 'message', id: 'u1', parentId: 'sp1', message: { role: 'user', content: '修一下重试逻辑' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', provider: 'p', model: 'm-pro', content: [{ type: 'thinking', thinking: 'x' }, { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: {} }, { type: 'text', text: 'done' }] } },
    { type: 'message', id: 'tr1', parentId: 'a1', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', isError: false, content: 'file body' } },
    { type: 'message', id: 'b1', parentId: 'tr1', message: { role: 'bashExecution', command: 'npm test', output: 'FAIL', exitCode: 1, excludeFromContext: true } },
    { type: 'custom_message', id: 'cm1', parentId: 'b1', customType: 'demo:notice', content: '通知内容', display: true },
    { type: 'message', id: 'u2', parentId: 'cm1', message: { role: 'user', content: '继续保留区' } },
    { type: 'message', id: 'a2', parentId: 'u2', message: { role: 'assistant', provider: 'p', model: 'm-pro', content: [{ type: 'text', text: '保留区回复' }] } },
    { type: 'compaction', id: 'c1', parentId: 'a2', summary: '压缩摘要正文', firstKeptEntryId: 'u2', tokensBefore: 152311 },
    { type: 'branch_summary', id: 'bs1', parentId: 'c1', fromId: 'u1', summary: '分支摘要正文' },
    { type: 'model_change', id: 'mc1', parentId: 'bs1', provider: 'xiaomi', modelId: 'm-pro' },
    { type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', thinkingLevel: 'max' },
    { type: 'session_info', id: 'si1', parentId: 'tl1', name: 'demo' },
    { type: 'label', id: 'l1', parentId: 'si1', targetId: 'u2', label: 'checkpoint' },
    { type: 'custom', id: 'cd1', parentId: 'l1', customType: 'demo:data', data: { k: 1 } },
    { type: 'message', id: 'u3', parentId: 'cd1', message: { role: 'user', content: 'leaf 消息' } },
    { type: 'handoff_marker', handedOffTo: 'sid-next' },
  ]
  return {
    sessionId: SID,
    source: 'file',
    header: { type: 'session', version: 1, id: 'h0', cwd: '/w/demo' },
    entries,
    malformed: [{ lineNumber: 3, raw: 'not json' }],
    sessionEnd: { type: 'session_end', outcome: 'done' },
    leafId: 'u3',
  }
}

async function mountTraceView(sid = SID): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(TraceView, { props: { sessionId: sid } })
  await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('ready'))
  return wrapper
}

function findRows(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('[data-testid^="trace-row-"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getTraceEntries.mockReset()
  apiMock.getTraceEntries.mockResolvedValue(buildFullKindsSnapshot())
  _resetTraceStoreForTest()
  setActivePinia(createPinia())
  bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
})

describe('A42 SegmentedTab 对话|Trace per-pane 视图状态', () => {
  it('PanelHeader 渲染「对话 | Trace」toggle，默认对话段激活', () => {
    const wrapper = mount(PanelHeader, {
      props: { sessionLabel: 't', sessionDir: '/w', status: 'done' as DerivedStatus, sessionId: SID },
    })
    expect(wrapper.find('[data-testid="trace-view-toggle"]').exists()).toBe(true)
    const chatBtn = wrapper.find('[data-testid="trace-view-toggle-chat"]')
    const traceBtn = wrapper.find('[data-testid="trace-view-toggle-trace"]')
    expect(chatBtn.exists() && traceBtn.exists()).toBe(true)
    expect(chatBtn.attributes('aria-pressed')).toBe('true')
    expect(traceBtn.attributes('aria-pressed')).toBe('false')
  })

  it('切换到 Trace：仅改 view 字段（数据不重拉），切回对话再切回状态保留', async () => {
    // 预加载（模拟此前打开过 Trace）
    ensureTraceLoaded(SID)
    await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('ready'))
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)

    const wrapper = mount(PanelHeader, {
      props: { sessionLabel: 't', sessionDir: '/w', status: 'done' as DerivedStatus, sessionId: SID },
    })
    // 点 Trace 段 → view=trace；不发新 RPC（数据已在分区）
    await wrapper.find('[data-testid="trace-view-toggle-trace"]').trigger('click')
    expect(useSessionTrace().partition.value.view).toBe('trace')
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)

    // TraceView 挂载（Panel 渲染分支切换）→ ready 分区 ensureLoaded no-op
    const view = await mountTraceView()
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)

    // 设过滤 + 选中（per-session 分区）
    setTraceFilter(SID, { activeGroups: ['messages'] })
    selectTraceEntry(SID, 'u2')

    // 切回对话（卸载 TraceView）→ 再切回（重新挂载）：过滤/选中保留 + 仍不重拉
    view.unmount()
    await wrapper.find('[data-testid="trace-view-toggle-chat"]').trigger('click')
    expect(useSessionTrace().partition.value.view).toBe('chat')
    await wrapper.find('[data-testid="trace-view-toggle-trace"]').trigger('click')

    const view2 = await mountTraceView()
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)
    const msgChip = view2.find('[data-testid="trace-chip-messages"]')
    expect(msgChip.classes().join(' ')).toContain('bg-bg-elevated')
    // 选中行仍高亮（u2 = 保留区 USER）
    const selRow = view2.find('[data-testid="trace-row-9"]')
    expect(selRow.classes().join(' ')).toContain('bg-surface-hover')
    view2.unmount()
  })
})

describe('A43 行组件渲染（12 kind + 影子化 + 选中态 + 虚拟滚动）', () => {
  it('12 kind + MALFORMED 行摘要齐全（§3.4 渲染模型），损坏行占位可见', async () => {
    const view = await mountTraceView()
    const kinds = new Set(findRows(view).map((r) => r.attributes('data-kind')))
    for (const kind of ['SESSION', 'SYSTEM', 'MALFORMED', 'USER', 'ASSISTANT', 'TOOL', 'BASH', 'NOTICE', 'COMPACTED', 'BRANCH', 'LIFECYCLE', 'DATA', 'BOUNDARY']) {
      expect(kinds.has(kind), `kind ${kind} 应渲染`).toBe(true)
    }
    // 损坏行 i18n 文案（第 3 行）+ 保留原文于 title
    const malformedRow = view.find('[data-testid="trace-row-3"]')
    expect(malformedRow.text()).toContain('无法解析的 entry')
    expect(malformedRow.attributes('title')).toContain('3')
    view.unmount()
  })

  it('影子化降透明：压缩前可进 context 行 data-shadowed + opacity；保留区/压缩后正常', async () => {
    const view = await mountTraceView()
    // seq 4 = u1（compaction 前、保留区外）→ 影子化
    const shadowed = view.find('[data-testid="trace-row-4"]')
    expect(shadowed.attributes('data-shadowed')).toBe('true')
    expect(shadowed.classes().join(' ')).toContain('opacity-40')
    // seq 9 = u2（保留区起点 firstKept）→ inContext
    const kept = view.find('[data-testid="trace-row-9"]')
    expect(kept.attributes('data-in-context')).toBe('true')
    expect(kept.attributes('data-shadowed')).toBeUndefined()
    // seq 13 = mc1（lifecycle 不可进类型）→ 不影子化 + 「不进 context」标记
    const lifecycle = view.find('[data-testid="trace-row-13"]')
    expect(lifecycle.attributes('data-shadowed')).toBeUndefined()
    expect(lifecycle.text()).toContain('不进 context')
    view.unmount()
  })

  it('选中态：surface-hover + 强调字色、无 ring（SearchModal sm-item 例外登记）', async () => {
    const view = await mountTraceView()
    const row = view.find('[data-testid="trace-row-10"]') // a2 保留区 assistant
    expect(row.classes().join(' ')).not.toContain('bg-surface-hover')
    await row.trigger('click')
    const selected = view.find('[data-testid="trace-row-10"]')
    const cls = selected.classes().join(' ')
    expect(cls).toContain('bg-surface-hover')
    expect(cls).not.toMatch(/\bring/)
    // 摘要强调字色（选中行内的 summary span）
    const summary = selected.find('span.flex-1')
    expect(summary.classes().join(' ')).toContain('text-accent')
    view.unmount()
  })

  it('BASH 行 meta：exitCode + excludeFromContext（core 小改）「不进上下文」注记', async () => {
    const view = await mountTraceView()
    const bashRow = view.find('[data-testid="trace-row-7"]') // b1
    expect(bashRow.attributes('data-kind')).toBe('BASH')
    expect(bashRow.text()).toContain('npm test')
    expect(bashRow.text()).toContain('exit 1')
    expect(bashRow.text()).toContain('不进上下文')
    view.unmount()
  })

  it('context 分界行在最后一次压缩后；「仅当前 context」toggle 隐藏影子化与不进行', async () => {
    const view = await mountTraceView()
    // c1 = seq 11，divider 紧随其后
    expect(view.find('[data-testid="trace-context-divider"]').exists()).toBe(true)
    const divider = view.find('[data-testid="trace-context-divider"]')
    expect(divider.text()).toContain('当前 context')
    const rows = findRows(view)
    const dividerSeqBefore = rows.findIndex((r) => r.attributes('data-testid') === 'trace-row-11')
    expect(dividerSeqBefore).toBeGreaterThan(-1)

    // toggle：只剩 inContext 行（无 shadowed / 无 lifecycle-DATA 等）
    await view.find('[data-testid="trace-context-toggle"]').trigger('click')
    const remaining = findRows(view)
    expect(remaining.length).toBeGreaterThan(0)
    expect(remaining.every((r) => r.attributes('data-in-context') === 'true')).toBe(true)
    expect(view.find('[data-testid="trace-context-divider"]').exists()).toBe(false)
    view.unmount()
  })

  it('kind chips 过滤 + 文本搜索（demo 语义：不匹配隐藏）', async () => {
    const view = await mountTraceView()
    // chips：工具 = TOOL/BASH
    await view.find('[data-testid="trace-chip-tools"]').trigger('click')
    let rows = findRows(view)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => ['TOOL', 'BASH'].includes(r.attributes('data-kind') ?? ''))).toBe(true)
    // 回「全部」
    await view.find('[data-testid="trace-chip-all"]').trigger('click')
    // 搜索：npm test → 仅 BASH b1
    await view.find('[data-testid="trace-search"]').setValue('npm test')
    rows = findRows(view)
    expect(rows.length).toBe(1)
    expect(rows[0]!.attributes('data-kind')).toBe('BASH')
    view.unmount()
  })

  it('>500 启用虚拟滚动（不全量渲染）', async () => {
    // 600 行 fixture（user/assistant 交替线性链，无压缩）
    const many: unknown[] = []
    let parent: string | null = null
    for (let i = 0; i < 600; i++) {
      const id = `g${i}`
      many.push({
        type: 'message',
        id,
        parentId: parent,
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `row ${i}` },
      })
      parent = id
    }
    apiMock.getTraceEntries.mockResolvedValue({
      sessionId: SID,
      source: 'file',
      entries: many,
      malformed: [],
      leafId: 'g599',
    } satisfies ServerMessageMap['session.traceEntries'])

    const view = await mountTraceView()
    const rendered = findRows(view).length
    expect(rendered).toBeLessThan(601) // 虚拟化路径：不全量渲染（happy-dom 下 virtua 窗口可为 0）
    view.unmount()
  })

  it('≤500 全量渲染（免 virtua 测量开销）', async () => {
    // 400 行（<500 阈值 → 直接 v-for）
    const few: unknown[] = []
    let parent: string | null = null
    for (let i = 0; i < 400; i++) {
      const id = `g${i}`
      few.push({
        type: 'message',
        id,
        parentId: parent,
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `row ${i}` },
      })
      parent = id
    }
    apiMock.getTraceEntries.mockResolvedValue({
      sessionId: SID,
      source: 'file',
      entries: few,
      malformed: [],
      leafId: 'g399',
    } satisfies ServerMessageMap['session.traceEntries'])
    const view2 = await mountTraceView()
    expect(findRows(view2).length).toBe(400)
    view2.unmount()
  })
})
