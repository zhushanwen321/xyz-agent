/**
 * useMessageEffects 测试（架构审计 §11.4）。
 *
 * core use-connection 是 headless（零 store），副作用回调实现归位 renderer 本层。
 * 本测试锁定 5 个 InboundEffects 回调的 store/toast 接线 + runtime 清理回调：
 * - onSessionExited → markSessionError + markDead + toast（首行 reason）
 * - onMessageComplete → 算 focusedSid + handleCompletion（aborted 过滤链在
 *   useCompletionNotify.test.ts 覆盖，本层只验证接线）
 * - onSubagents → applyRecords；onWorkflowUpdate → triggerWorkflowReload
 * - onGlobalError → toast
 * - handleRuntimeUnavailable → finalizeAllStreaming + clearAllPending（T5）
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/effects/__tests__/useMessageEffects.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerMessageMap, SubagentRecord } from '@xyz-agent/shared'

const storeMocks = vi.hoisted(() => ({
  markSessionError: vi.fn(),
  finalizeAllStreaming: vi.fn(),
  markDead: vi.fn(),
  clearAllPending: vi.fn(),
  applyRecords: vi.fn(),
  triggerWorkflowReload: vi.fn(),
  // panel store 最小形状（panels 可整体替换模拟聚焦 session 变化）
  panels: [] as Array<{ id: string; sessionId: string | null }>,
  activePanelId: 'root-panel',
  toastError: vi.fn(),
  handleCompletion: vi.fn(),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    markSessionError: storeMocks.markSessionError,
    finalizeAllStreaming: storeMocks.finalizeAllStreaming,
  }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ markDead: storeMocks.markDead }),
}))
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({ panels: storeMocks.panels, activePanelId: storeMocks.activePanelId }),
}))
vi.mock('@/stores/extension-ui', () => ({
  useExtensionUIStore: () => ({ clearAllPending: storeMocks.clearAllPending }),
}))
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({ applyRecords: storeMocks.applyRecords }),
}))
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({ triggerWorkflowReload: storeMocks.triggerWorkflowReload }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: storeMocks.toastError }),
}))
vi.mock('@/composables/effects/useCompletionNotify', () => ({
  handleCompletion: storeMocks.handleCompletion,
}))

import { createInboundEffects, handleRuntimeUnavailable } from '../useMessageEffects'

const effects = createInboundEffects()

describe('createInboundEffects（§11.4 InboundEffects 接线）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.panels = []
    storeMocks.activePanelId = 'root-panel'
  })

  it('onSessionExited → markSessionError + markDead + toast（reason 只取首行）', () => {
    effects.onSessionExited!('s1', { code: 1, reason: 'Session process exited (code: 1)\n\nError: ext load failed' })

    expect(storeMocks.markSessionError).toHaveBeenCalledWith('s1', 'Session process exited (code: 1)\n\nError: ext load failed')
    expect(storeMocks.markDead).toHaveBeenCalledWith('s1')
    expect(storeMocks.toastError).toHaveBeenCalledTimes(1)
    const msg = storeMocks.toastError.mock.calls[0]![0] as string
    // toast 含首行 reason + i18n 文案（zh-CN 默认 locale）
    expect(msg).toContain('Session process exited')
    expect(msg).not.toContain('ext load failed')
  })

  it('onMessageComplete → 从 panel store 算 focusedSid 传给 handleCompletion（stop 直传）', () => {
    storeMocks.panels = [{ id: 'root-panel', sessionId: 's-focus' }]

    effects.onMessageComplete!('s-bg', { stopReason: 'stop' })

    expect(storeMocks.handleCompletion).toHaveBeenCalledWith('s-bg', 'stop', 's-focus')
  })

  it('onMessageComplete → stopReason 缺省按 "stop"（兼容无 stopReason 的 complete）', () => {
    storeMocks.panels = [{ id: 'root-panel', sessionId: 's-focus' }]

    effects.onMessageComplete!('s-bg', {})

    expect(storeMocks.handleCompletion).toHaveBeenCalledWith('s-bg', 'stop', 's-focus')
  })

  it('onMessageComplete → 面板无匹配 session 时 focusedSid 为 null（未知面板结构兜底）', () => {
    storeMocks.panels = [{ id: 'other-panel', sessionId: 's-x' }]

    effects.onMessageComplete!('s-bg', { stopReason: 'error' })

    expect(storeMocks.handleCompletion).toHaveBeenCalledWith('s-bg', 'error', null)
  })

  it('onSubagents → applyRecords(sid, list)', () => {
    const records: SubagentRecord[] = [{ id: 'sa-1', status: 'done' }] as SubagentRecord[]

    effects.onSubagents!('s1', records)

    expect(storeMocks.applyRecords).toHaveBeenCalledWith('s1', records)
  })

  it('onWorkflowUpdate → triggerWorkflowReload(sid, status)；status 缺省按 "unknown"（防御运行时坏形状）', () => {
    effects.onWorkflowUpdate!('s1', { runId: 'wf-1', status: 'running' })
    expect(storeMocks.triggerWorkflowReload).toHaveBeenCalledWith('s1', 'running')

    storeMocks.triggerWorkflowReload.mockClear()
    // protocol SSOT 声明 status 必填，但运行时不可信——缺 status 时兜底 'unknown'（显式 cast 模拟坏形状）
    effects.onWorkflowUpdate!('s1', { runId: 'wf-1' } as ServerMessageMap['session.workflowUpdate']['update'])
    expect(storeMocks.triggerWorkflowReload).toHaveBeenCalledWith('s1', 'unknown')
  })

  it('onGlobalError → toast.error(message)', () => {
    effects.onGlobalError!('config load failed')

    expect(storeMocks.toastError).toHaveBeenCalledWith('config load failed')
  })
})

describe('handleRuntimeUnavailable（T5 runtime 崩溃清理接线）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reason='restart' → finalizeAllStreaming('restart') + clearAllPending", () => {
    handleRuntimeUnavailable('restart')

    expect(storeMocks.finalizeAllStreaming).toHaveBeenCalledWith('restart')
    expect(storeMocks.clearAllPending).toHaveBeenCalledTimes(1)
  })

  it("reason='disconnect' → finalizeAllStreaming('disconnect') + clearAllPending", () => {
    handleRuntimeUnavailable('disconnect')

    expect(storeMocks.finalizeAllStreaming).toHaveBeenCalledWith('disconnect')
    expect(storeMocks.clearAllPending).toHaveBeenCalledTimes(1)
  })
})
