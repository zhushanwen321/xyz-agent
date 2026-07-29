/**
 * bashStart / bashResult effect 单测（composer-bash-execute W3 TK7）。
 *
 * 验证 message.bashStart → 创建 streaming 态 system 消息（bashExecution.command 正确），
 * message.bashResult → 同消息转 complete 态并填充 output/exitCode/cancelled。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-message-effects-bash.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import type { ServerMessage } from '@xyz-agent/shared'

describe('bash effect（message.bashStart / message.bashResult）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('T1: bashStart → 末尾 system 消息 status=streaming，bashExecution.command 正确', () => {
    const store = useChatStore()
    const sid = 's-bash-1'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hello', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    const m = msgs[0]
    expect(m.role).toBe('system')
    expect(m.status).toBe('streaming')
    expect(m.bashExecution?.command).toBe('echo hello')
    expect(m.bashExecution?.output).toBe('')
    expect(m.bashExecution?.exitCode).toBeNull()
    expect(m.bashExecution?.excludeFromContext).toBe(false)
  })

  it('T2: bashStart 后 bashResult → 同消息 status=complete，output/exitCode 填充', () => {
    const store = useChatStore()
    const sid = 's-bash-2'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'ls', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'ls',
        output: 'file1\nfile2',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    const m = msgs[0]
    expect(m.status).toBe('complete')
    expect(m.bashExecution?.output).toBe('file1\nfile2')
    expect(m.bashExecution?.exitCode).toBe(0)
    expect(m.bashExecution?.cancelled).toBe(false)
  })

  it('T3: bashResult cancelled=true → bashExecution.cancelled=true（abortBash 路径）', () => {
    const store = useChatStore()
    const sid = 's-bash-3'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 5', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'sleep 5',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    const m = msgs[0]
    expect(m.status).toBe('complete')
    expect(m.bashExecution?.cancelled).toBe(true)
  })

  it('excludeFromContext 透传：bashStart 携带 true → 消息 bashExecution.excludeFromContext=true', () => {
    const store = useChatStore()
    const sid = 's-bash-4'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'secret', excludeFromContext: true, timestamp: 1000 },
    } as ServerMessage)
    expect(store.getMessages(sid)[0].bashExecution?.excludeFromContext).toBe(true)
  })
})
