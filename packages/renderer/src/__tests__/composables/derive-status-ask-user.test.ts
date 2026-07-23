/**
 * CW wave `session-active-ssot` T3：ask-user pending 接入 DerivedStatus waiting 态。
 *
 * 锁定改动：deriveStatus 新增 hasAskUserPending 参数（默认 false，向后兼容），
 * 当 ask-user 富交互请求 pending 时返回 'waiting'（优先级最高，与 toolCall running 并列）。
 *
 * ask-user 走 extension.ui_request 通道，不产生 toolCall running，故需独立判定：
 * agent 阻塞等待用户输入期间，即使后续有流式文本也不应脱离 waiting。
 *
 * 覆盖（TC3）：
 * - ask-user pending + 无 toolCall running + 无 streaming → waiting
 * - ask-user pending + 有 streaming → 仍 waiting（优先级高于 streaming）
 * - ask-user pending + 有 toolCall running → waiting（两者都触发 waiting，结果一致）
 * - 无 ask-user pending + 无 toolCall → 回落下游态（done）
 * - hasAskUserPending 默认 false（向后兼容）：不传第 7 参数行为不变
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/derive-status-ask-user.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { deriveStatus } from '@/composables/logic/sessionStatus'

describe('T3: deriveStatus ask-user pending → waiting（纯函数）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('ask-user pending + 无 toolCall running + 无 streaming → waiting', () => {
    const chat = useChatStore()
    // 未 hydrate（无消息）+ 非活跃 → 单独看会兜底 done；ask-user pending 应改判 waiting
    expect(deriveStatus('s1', chat, false, false, false, undefined, true)).toBe('waiting')
  })

  it('ask-user pending + 有 streaming → 仍 waiting（优先级高于 streaming）', () => {
    const chat = useChatStore()
    // 触发流式：message_start 创建 streaming 实体 → isGenerating=true
    chat.applyMessageEvent('s1', {
      type: 'message.message_start',
      payload: { sessionId: 's1', messageId: 'a1' },
    })
    expect(chat.isGenerating('s1')).toBe(true)
    // 即使流式中，ask-user pending 仍占最高优先级 → waiting
    expect(deriveStatus('s1', chat, true, false, false, undefined, true)).toBe('waiting')
  })

  it('ask-user pending + 有 toolCall running → waiting（两者都触发 waiting，结果一致）', () => {
    const chat = useChatStore()
    // hydrate 一条 assistant 消息，末尾 toolCall 处于 running（独立触发 waiting）
    chat.hydrate('s1', [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        timestamp: 1,
        toolCalls: [{ id: 't1', toolName: 'bash', input: {}, status: 'running', startTime: 0 }],
      },
    ])
    // 不传 hasAskUserPending（false）→ toolCall running 已是 waiting
    expect(deriveStatus('s1', chat, false, false, false)).toBe('waiting')
    // 传 hasAskUserPending=true → 仍是 waiting（两个触发源并列，结果一致）
    expect(deriveStatus('s1', chat, false, false, false, undefined, true)).toBe('waiting')
  })

  it('无 ask-user pending + 无 toolCall → 回落下游态（done）', () => {
    const chat = useChatStore()
    // 未 hydrate + 非活跃 + 无 ask-user → 兜底 done
    expect(deriveStatus('s1', chat, false, false, false, undefined, false)).toBe('done')
  })

  it('hasAskUserPending 默认 false（向后兼容）：不传第 7 参数行为不变', () => {
    const chat = useChatStore()
    // 不传 hasAskUserPending，应与显式 false 一致
    expect(deriveStatus('s1', chat, false, false, false, undefined)).toBe('done')
    expect(deriveStatus('s1', chat, false, false, false, undefined, false)).toBe('done')
  })
})

describe('T3: useSessionDerivations 注入 extensionUIStore.hasPendingAskUser（集成）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('extensionUIStore 有 ask-user pending → derivedStatus 响应式 = waiting；respond 后回落 done', async () => {
    // 延迟 import：invalidateStatusCache 需在每次 pinia 重置后清理模块级缓存，
    // 避免 computed 持有上个用例的旧 store 闭包（对齐 session-active-state.test.ts 模式）
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/useSessionDerivations'
    )
    const { useExtensionUIStore } = await import('@/stores/extension-ui')
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const extensionUIStore = useExtensionUIStore()
    const sessionId = 's-int'

    // 初始无 pending → 未 hydrate + 非活跃 → done
    expect(derivedStatus(sessionId).value).toBe('done')

    // push 一个 ask-user 请求（askUser=true）
    extensionUIStore.addRequest(sessionId, {
      sessionId,
      requestId: 'r1',
      method: 'select',
      askUser: true,
    })
    // 响应式：computed 应重算为 waiting
    expect(derivedStatus(sessionId).value).toBe('waiting')

    // respond（removeRequest）后回落 done
    extensionUIStore.removeRequest(sessionId, 'r1')
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})
