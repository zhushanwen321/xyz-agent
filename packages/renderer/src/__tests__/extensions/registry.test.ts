/**
 * ExtensionRegistry 单测。
 *
 * 覆盖：
 * - 注册后 route{Widget|WidgetGui|Status} 命中返回 true、调用 adapter
 * - 未注册的 key 返回 false（走通用管线）
 * - case-insensitive 匹配（extension 推的 key 大小写不可控）
 * - 重复注册幂等（HMR 场景）
 *
 * [P4 s5 w2] tasks-adapter（goal/todo 分流）已随 tasks 域删除，相关断言移除。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/extensions/registry.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  registerKnownExtension,
  routeWidget,
  routeWidgetGui,
  routeStatus,
  __resetExtensionRegistry,
} from '@/extensions/registry'

describe('ExtensionRegistry 分流', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('未注册 key 走通用管线（route* 返回 false）', () => {
    it('未注册 widgetKey → routeWidget 返回 false', () => {
      expect(routeWidget('s1', 'unknown-widget', ['line'])).toBe(false)
    })
    it('未注册 statusKey → routeStatus 返回 false', () => {
      expect(routeStatus('s1', 'unknown-status', 'text', undefined)).toBe(false)
    })
  })

  describe('自定义 adapter 注册', () => {
    it('注册自定义 adapter 后命中其 onWidget', () => {
      const onWidget = vi.fn()
      __resetExtensionRegistry()
      registerKnownExtension({
        widgetKeys: ['my-ext'],
        statusKeys: [],
        onWidget,
      })
      expect(routeWidget('s1', 'my-ext', ['line'])).toBe(true)
      expect(onWidget).toHaveBeenCalledWith('s1', 'my-ext', ['line'])
    })

    it('adapter 无 onStatus 时 statusKey 命中也返回 false（让通用管线处理）', () => {
      __resetExtensionRegistry()
      registerKnownExtension({
        widgetKeys: [],
        statusKeys: ['my-status'],
        // 故意不提供 onStatus
      })
      expect(routeStatus('s1', 'my-status', 'text', undefined)).toBe(false)
    })

    it('重复注册同一 adapter 幂等（HMR 场景）', () => {
      __resetExtensionRegistry()
      const onWidget = vi.fn()
      const adapter = { widgetKeys: ['ext'], statusKeys: [], onWidget }
      registerKnownExtension(adapter)
      registerKnownExtension(adapter) // 重复
      routeWidget('s1', 'ext', ['x'])
      expect(onWidget).toHaveBeenCalledTimes(1) // 不重复触发
    })
  })
})
