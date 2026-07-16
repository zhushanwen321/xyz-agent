/**
 * composer-injection store 单元测试（W2, U5）。
 *
 * 验证 pendingInjection 单值消息槽：覆盖语义 + clearInjection + routeToLanding。
 * 参照 commandStore.pendingSlash 模式。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useComposerInjectionStore } from '@/stores/composer-injection'

describe('composer-injection store（W2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('U5: pendingInjection 单值覆盖（后者覆盖前者）', () => {
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection?.path).toBe('a.ts')
    store.requestInjection({ target: 'current', path: 'b.ts', sessionId: 's1' })
    expect(store.pendingInjection?.path).toBe('b.ts')
  })

  it('U5b: requestInjection 内部补 ts', () => {
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection?.ts).toBeTypeOf('number')
  })

  it('U5c: clearInjection 置 null', () => {
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    store.clearInjection()
    expect(store.pendingInjection).toBeNull()
  })

  it('U5d: payload 含 lineStart/lineEnd 时透传', () => {
    const store = useComposerInjectionStore()
    store.requestInjection({
      target: 'current',
      path: 'a.ts',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 's1',
    })
    expect(store.pendingInjection?.lineStart).toBe(10)
    expect(store.pendingInjection?.lineEnd).toBe(20)
  })

  it('U5e: target=new 时 sessionId 强制 null（新对话落地 landing composer）', () => {
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'new', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection?.target).toBe('new')
    expect(store.pendingInjection?.sessionId).toBeNull()
  })

  it('U5f: routeToLanding 把 target 从 new 改 current 并重置 ts', () => {
    const store = useComposerInjectionStore()
    store.requestInjection({ target: 'new', path: 'a.ts', sessionId: 's1' })
    const tsBefore = store.pendingInjection!.ts
    store.routeToLanding()
    expect(store.pendingInjection?.target).toBe('current')
    expect(store.pendingInjection?.sessionId).toBeNull()
    expect(store.pendingInjection!.ts).toBeGreaterThanOrEqual(tsBefore)
  })

  it('U5g: routeToLanding 无 pendingInjection 时 no-op', () => {
    const store = useComposerInjectionStore()
    store.routeToLanding()
    expect(store.pendingInjection).toBeNull()
  })
})
