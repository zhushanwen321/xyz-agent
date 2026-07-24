/**
 * W6: deriveStatus 未 hydrate session 的元数据 status 兜底。
 *
 * 覆盖：
 * - 未 hydrate（messages 为空）+ metaStatus='error' → 返回 error
 * - 未 hydrate + metaStatus='stopped' → 返回 stopped
 * - 未 hydrate + metaStatus='idle'（历史 session）→ 返回 done（兜底）
 * - 未 hydrate + 无 metaStatus → 返回 done（兜底）
 * - 已 hydrate（有消息）→ 仍走原有末条消息派生逻辑（metaStatus 不干扰）
 *
 * 运行：npx vitest run src/__tests__/composables/derive-status-meta.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { deriveStatus } from '@/composables/logic/sessionStatus'

describe('W6: deriveStatus 未 hydrate session 元数据兜底', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('未 hydrate（空消息）+ metaStatus=error → 返回 error', () => {
    const chat = useChatStore()
    // 不 hydrate，getMessages 返回空
    expect(chat.getMessages('s1')).toHaveLength(0)
    expect(deriveStatus('s1', chat, false, false, false, 'error')).toBe('error')
  })

  it('未 hydrate + metaStatus=stopped → 返回 stopped', () => {
    const chat = useChatStore()
    expect(deriveStatus('s1', chat, false, false, false, 'stopped')).toBe('stopped')
  })

  it('未 hydrate + metaStatus=done → 返回 done', () => {
    const chat = useChatStore()
    expect(deriveStatus('s1', chat, false, false, false, 'done')).toBe('done')
  })

  it('未 hydrate + metaStatus=idle（历史 session）→ 兜底 done', () => {
    const chat = useChatStore()
    // 历史 session 无 session_end，scanner 返回 idle，前端兜底 done
    expect(deriveStatus('s1', chat, false, false, false, 'idle')).toBe('done')
  })

  it('未 hydrate + 无 metaStatus（undefined）→ 兜底 done', () => {
    const chat = useChatStore()
    expect(deriveStatus('s1', chat, false, false, false)).toBe('done')
  })

  it('未 hydrate + metaStatus=active → 仍兜底 done（active 是内存态，不应出现在元数据兜底分支）', () => {
    const chat = useChatStore()
    // active 走 isActive 参数，不走 metaStatus；metaStatus 收到 active 也兜底 done
    expect(deriveStatus('s1', chat, false, false, false, 'active')).toBe('done')
  })
})

describe('W6: deriveStatus 已 hydrate 不受 metaStatus 干扰', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('已 hydrate 且末条 error → 返回 error（忽略 metaStatus）', () => {
    const chat = useChatStore()
    chat.hydrate('s1', [
      { id: 'm1', role: 'assistant', content: 'oops', status: 'error', timestamp: 1 },
    ])
    // metaStatus 传 done，但已 hydrate 应走末条消息 status=error
    expect(deriveStatus('s1', chat, false, false, false, 'done')).toBe('error')
  })

  it('已 hydrate 且末条 complete → 返回 done', () => {
    const chat = useChatStore()
    chat.hydrate('s1', [
      { id: 'm1', role: 'assistant', content: 'ok', status: 'complete', timestamp: 1 },
    ])
    expect(deriveStatus('s1', chat, false, false, false, 'error')).toBe('done')
  })
})
