/**
 * A44 drawer inspector 联动单测（trace-ui，设计 D5b/D5c）。
 *
 * 覆盖：
 * - 选中切入临时页：selectTraceEntry 后 drawer default slot 最前注入 TraceInspector
 *   （优先于 activeTab 面板），详情按 kind 渲染（文本全文 / kv / 原始 JSON）
 * - 返回复原前 tab：「← 返回」清 selectedKey → inspector 卸载 → activeTab 内容复原
 * - 未开自动打开：drawer 关闭态点选 → openDrawerTab 自动打开（保持当前 tab）
 * - 单向 main→drawer + SideDrawerTab 体系不变（7 个一级 tab icon 仍在，无新 tab 位）
 *
 * 两层：组件级（mount TraceInspector 断言详情内容）+ 壳路径（mount PanelContainer，
 * stub 桌面面板，对齐 panel-container-drawer-mode.test.ts harness）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-trace/trace-inspector.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, defineComponent, nextTick, reactive } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import type { ServerMessageMap } from '@xyz-agent/shared'
import { bindDrawerSessionId, _resetDrawerForTest } from '@xyz-agent/core/domain/drawer'

// ── mock 壳层依赖（PanelContainer setup 阶段执行，避免真实 WS/session 副作用）──
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// ── mock chatStore（unread badge 计数读 getMessages）──
const chatMock = vi.hoisted(() => {
  let readFn: ((sid: string) => unknown[]) | null = null
  return {
    registerReader(fn: (sid: string) => unknown[]): void {
      readFn = fn
    },
    read(sid: string): unknown[] {
      return readFn ? readFn(sid) : []
    },
  }
})
const reactiveMessages = reactive(new Map<string, unknown[]>())
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ getMessages: (sid: string) => chatMock.read(sid) }),
}))
chatMock.registerReader((sid) => reactiveMessages.get(sid) ?? [])

// ── mock '@/api' 门面：仅覆写 session.getTraceEntries（其余域保留真实导出——
// PanelContainer 依赖链上的 useChat 需要 chat.send/steer 等真存在，整体替换会解构 undefined）──
const apiMock = vi.hoisted(() => ({ getTraceEntries: vi.fn() }))
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return { ...actual, session: { ...actual.session, getTraceEntries: apiMock.getTraceEntries } }
})

// ── mock '@/lib/ipc' revealInFolder（reveal 调用链组件层段落：TraceInspector →
//  lib/ipc；electronAPI 边界归 ipc-reveal-in-folder.test.ts，两段拼接成完整链）──
const ipcMock = vi.hoisted(() => ({ revealInFolder: vi.fn() }))
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>()
  return { ...actual, revealInFolder: ipcMock.revealInFolder }
})

import TraceInspector from '@/components/panel/trace/TraceInspector.vue'
import {
  _resetTraceStoreForTest,
  bindTraceSessionId,
  ensureTraceLoaded,
  selectTraceEntry,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'

const SID = 'sid-inspector-1'

function buildSnapshot(): ServerMessageMap['session.traceEntries'] {
  return {
    sessionId: SID,
    source: 'file',
    filePath: `/pi/sessions/${SID}.jsonl`,
    header: { type: 'session', version: 1, id: 'h0', cwd: '/w/demo' },
    entries: [
      { type: 'message', id: 'u1', parentId: 'h0', message: { role: 'user', content: '帮我修一下重试逻辑' } },
      { type: 'message', id: 'b1', parentId: 'u1', message: { role: 'bashExecution', command: 'npm test', output: 'FAIL 1', exitCode: 1, excludeFromContext: true } },
      { type: 'compaction', id: 'c1', parentId: 'b1', summary: '## 压缩摘要正文', firstKeptEntryId: 'b1', tokensBefore: 152311 },
      { type: 'message', id: 'u2', parentId: 'c1', message: { role: 'user', content: '压缩后的消息' } },
    ],
    malformed: [{ lineNumber: 5, raw: 'not json' }],
    leafId: 'u2',
  }
}

const DesktopStub = (name: string, testid: string) =>
  defineComponent({ name, template: `<div data-testid="${testid}" />` })

const PanelStub = defineComponent({
  name: 'Panel',
  props: { panelId: String, sessionId: { type: String, default: null } },
  template: '<div data-testid="panel" :data-panel-id="panelId" />',
})

async function mountContainer() {
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer, {
    global: {
      stubs: {
        Panel: PanelStub,
        GitPanel: DesktopStub('GitPanel', 'git-panel'),
        CommandDocPanel: DesktopStub('CommandDocPanel', 'doc-panel'),
        DetailPane: DesktopStub('DetailPane', 'detail-panel'),
        BrowserPane: DesktopStub('BrowserPane', 'browser-pane'),
        TerminalView: DesktopStub('TerminalView', 'terminal-panel'),
        SubagentTab: DesktopStub('SubagentTab', 'subagent-panel'),
        WorkflowTab: DesktopStub('WorkflowTab', 'workflow-panel'),
      },
    },
  })
}

async function readyPartition() {
  ensureTraceLoaded(SID)
  await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('ready'))
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getTraceEntries.mockReset()
  apiMock.getTraceEntries.mockResolvedValue(buildSnapshot())
  _resetTraceStoreForTest()
  _resetDrawerForTest()
  setActivePinia(createPinia())
  bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
})

describe('A44 drawer inspector 联动（选中切入临时页 / 返回复原 / 未开自动打开 / SideDrawerTab 不变）', () => {
  it('组件级：选中 USER 行渲染详情（全文 / kv / 原始 JSON），返回清除选中', async () => {
    await readyPartition()
    selectTraceEntry(SID, 'u1')
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    expect(view.find('[data-testid="trace-inspector"]').exists()).toBe(true)
    const body = view.find('[data-testid="trace-inspector-body"]')
    // 文本全文 + 关键 kv + 原始 JSON 兜底
    expect(body.text()).toContain('帮我修一下重试逻辑')
    expect(body.text()).toContain('u1')
    expect(body.text()).toContain('role')
    // 返回 → selectedKey 清除（inspector 数据源为空）
    await view.find('[data-testid="trace-inspector-back"]').trigger('click')
    expect(useSessionTrace().partition.value.selectedKey).toBeNull()
    view.unmount()
  })

  it('组件级：COMPACTED 行 summary 全文 + tokensBefore；BASH 行 command/exitCode/excludeFromContext', async () => {
    await readyPartition()
    selectTraceEntry(SID, 'c1')
    await nextTick()
    const compacted = mount(TraceInspector, { props: { sessionId: SID } })
    const cBody = compacted.find('[data-testid="trace-inspector-body"]')
    expect(cBody.text()).toContain('压缩摘要正文')
    expect(cBody.text()).toContain('152311')
    expect(cBody.text()).toContain('firstKeptEntryId')
    compacted.unmount()

    selectTraceEntry(SID, 'b1')
    await nextTick()
    const bash = mount(TraceInspector, { props: { sessionId: SID } })
    const bBody = bash.find('[data-testid="trace-inspector-body"]')
    expect(bBody.text()).toContain('npm test')
    expect(bBody.text()).toContain('exitCode')
    expect(bBody.text()).toContain('excludeFromContext')
    bash.unmount()
  })

  it('壳路径：未开自动打开 + 选中切入临时页（取代 activeTab 内容）+ 一级 tab 体系不变', async () => {
    await readyPartition()
    const wrapper = await mountContainer()
    await nextTick()
    // drawer 关闭态：无 drawer
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)

    // 选中（drawer 未开）→ 自动打开 + inspector 切入 default slot 最前
    selectTraceEntry(SID, 'u1')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(true)
    // inspector 优先于 activeTab 面板（默认 terminal tab 内容被临时页取代）
    expect(wrapper.find('[data-testid="terminal-panel"]').exists()).toBe(false)

    // SideDrawerTab 体系不变：7 个一级 tab icon 仍在（inspector 不占 tab 位）
    for (const tab of ['terminal', 'browser', 'git', 'doc', 'detail', 'subagent', 'workflow']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${tab}"]`).exists(), `drawer-tab-${tab} 应存在`).toBe(true)
    }

    // 返回 → inspector 卸载 + 复原前 tab 内容（activeTab 未被改过，默认 terminal）
    await wrapper.find('[data-testid="trace-inspector-back"]').trigger('click')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="terminal-panel"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('单向 main→drawer：inspector 期间点其它一级 tab = 显式离开（清选中，切 tab 内容），drawer 不反向写 main 状态', async () => {
    await readyPartition()
    const wrapper = await mountContainer()
    selectTraceEntry(SID, 'u1')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(true)

    // 用户点 git tab（明确意图离开临时页）→ 清 selectedKey + git 面板接管
    await wrapper.find('[data-testid="drawer-tab-git"]').trigger('click')
    await nextTick()
    expect(useSessionTrace().partition.value.selectedKey).toBeNull()
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trace-inspector"]').exists()).toBe(false)
    // main 侧过滤/视图状态不被 drawer 操作改写
    expect(useSessionTrace().partition.value.view).toBe('chat')
    expect(useSessionTrace().partition.value.searchText).toBe('')
    wrapper.unmount()
  })
})

describe('C2 MALFORMED 行「打开所在目录」（reveal-in-folder IPC 接线，§3.1 损坏行恢复指引）', () => {
  it('选中损坏行 + 快照带 filePath → 按钮可点，点击调 lib/ipc.revealInFolder(filePath)', async () => {
    await readyPartition()
    selectTraceEntry(SID, 'malformed:5')
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    const actions = view.find('[data-testid="trace-malformed-actions"]')
    expect(actions.exists()).toBe(true)
    const revealBtn = view.find('[data-testid="trace-malformed-reveal"]')
    expect(revealBtn.exists()).toBe(true)
    expect(revealBtn.attributes('disabled')).toBeUndefined()

    ipcMock.revealInFolder.mockResolvedValueOnce(true)
    await revealBtn.trigger('click')
    expect(ipcMock.revealInFolder).toHaveBeenCalledTimes(1)
    expect(ipcMock.revealInFolder).toHaveBeenCalledWith(`/pi/sessions/${SID}.jsonl`)
    view.unmount()
  })

  it('快照无 filePath（未落盘/路径未知）→ 按钮置灰且点击不触发 IPC', async () => {
    const snap = buildSnapshot()
    delete snap.filePath
    apiMock.getTraceEntries.mockResolvedValue(snap)
    await readyPartition()
    selectTraceEntry(SID, 'malformed:5')
    await nextTick()
    const view = mount(TraceInspector, { props: { sessionId: SID } })
    const revealBtn = view.find('[data-testid="trace-malformed-reveal"]')
    expect(revealBtn.attributes('disabled')).toBeDefined()
    await revealBtn.trigger('click')
    expect(ipcMock.revealInFolder).not.toHaveBeenCalled()
    view.unmount()
  })
})
