/**
 * NavigateInterceptor 单测 — 覆盖 4 条分支（report round5 must-fix #3）。
 *
 * NavigateInterceptor 是纯装饰器，拦截 pi extension 的 navigate-result custom message，
 * 之前无直接测试（session-service.test.ts 把整个模块 mock 成空实现）。parse/取消语义错
 * 会丢消息或卡 Promise。
 *
 * 分支覆盖：
 *  ① customType 命中 + JSON parse 成功 → resolve + 抑制转发（不调用 downstream）
 *  ② customType 命中 + parse 失败 → 放行转发（让 timeout 兜底）
 *  ③ onMessageEnd 且 resolver pending → resolve {cancelled:true}
 *  ④ 无 resolver → 直接 downstream
 *
 * 运行：cd src-electron/runtime && npx vitest run test/navigate-interceptor.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { NavigateInterceptor, NavigateInterceptorFactory } from '../src/infra/pi/navigate-interceptor.js'
import type { ServerMessage } from '@xyz-agent/shared'

function makeMsg(payload: Record<string, unknown>): ServerMessage {
  return { type: 'message.message_start', payload }
}

describe('NavigateInterceptor', () => {
  describe('① customType 命中 + JSON parse 成功', () => {
    it('resolve resolver 并抑制转发（downstream 不被调用）', () => {
      const downstream = vi.fn()
      const interceptor = new NavigateInterceptor(downstream)
      const resolver = vi.fn()
      interceptor.setResolver(resolver)

      const data = { newLeafId: 'leaf-2', editorText: 'hello' }
      interceptor.send(makeMsg({
        customType: 'xyz-navigate-result',
        content: JSON.stringify(data),
      }))

      expect(resolver).toHaveBeenCalledTimes(1)
      expect(resolver).toHaveBeenCalledWith(data)
      expect(downstream).not.toHaveBeenCalled()
    })
  })

  describe('② customType 命中 + JSON parse 失败', () => {
    it('放行转发，resolver 不被调用（由 timeout 兜底）', () => {
      const downstream = vi.fn()
      const interceptor = new NavigateInterceptor(downstream)
      const resolver = vi.fn()
      interceptor.setResolver(resolver)

      interceptor.send(makeMsg({
        customType: 'xyz-navigate-result',
        content: '{not valid json',
      }))

      expect(resolver).not.toHaveBeenCalled()
      expect(downstream).toHaveBeenCalledTimes(1)
      expect(downstream.mock.calls[0]![0]).toMatchObject({ type: 'message.message_start' })
    })
  })

  describe('③ onMessageEnd 且 resolver pending', () => {
    it('resolve resolver 为 {cancelled:true}', () => {
      const downstream = vi.fn()
      const interceptor = new NavigateInterceptor(downstream)
      const resolver = vi.fn()
      interceptor.setResolver(resolver)

      interceptor.onMessageEnd()

      expect(resolver).toHaveBeenCalledTimes(1)
      expect(resolver).toHaveBeenCalledWith({ cancelled: true })
    })

    it('onMessageEnd 后 resolver 被清空，再次 onMessageEnd 不重复 resolve', () => {
      const interceptor = new NavigateInterceptor(vi.fn())
      const resolver = vi.fn()
      interceptor.setResolver(resolver)

      interceptor.onMessageEnd()
      interceptor.onMessageEnd()

      expect(resolver).toHaveBeenCalledTimes(1)
    })
  })

  describe('④ 无 resolver → 直接 downstream', () => {
    it('未 setResolver 时所有消息透传', () => {
      const downstream = vi.fn()
      const interceptor = new NavigateInterceptor(downstream)

      // 即使带 customType，无 resolver 也不拦截
      interceptor.send(makeMsg({
        customType: 'xyz-navigate-result',
        content: JSON.stringify({ x: 1 }),
      }))

      expect(downstream).toHaveBeenCalledTimes(1)
    })

    it('clearResolver 后不再拦截，消息透传', () => {
      const downstream = vi.fn()
      const interceptor = new NavigateInterceptor(downstream)
      const resolver = vi.fn()
      interceptor.setResolver(resolver)
      interceptor.clearResolver()

      interceptor.send(makeMsg({
        customType: 'xyz-navigate-result',
        content: JSON.stringify({ x: 1 }),
      }))

      expect(resolver).not.toHaveBeenCalled()
      expect(downstream).toHaveBeenCalledTimes(1)
    })
  })

  describe('非 navigate 消息透传', () => {
    it('customType 不匹配时透传（resolver 保持不消费）', () => {
      const downstream = vi.fn()
      const interceptor = new NavigateInterceptor(downstream)
      const resolver = vi.fn()
      interceptor.setResolver(resolver)

      interceptor.send(makeMsg({ customType: 'other-type', content: '{}' }))
      // 另发一条 text_delta 类型消息也应透传
      interceptor.send({ type: 'message.text_delta', payload: { text: 'x' } })

      expect(resolver).not.toHaveBeenCalled()
      expect(downstream).toHaveBeenCalledTimes(2)
    })
  })

  describe('NavigateInterceptorFactory', () => {
    it('create 返回的实例实现 INavigateInterceptor', () => {
      const factory = new NavigateInterceptorFactory()
      const interceptor = factory.createNavigateInterceptor(vi.fn())
      expect(typeof interceptor.send).toBe('function')
      expect(typeof interceptor.onMessageEnd).toBe('function')
      expect(typeof interceptor.setResolver).toBe('function')
      expect(typeof interceptor.clearResolver).toBe('function')
    })
  })
})
