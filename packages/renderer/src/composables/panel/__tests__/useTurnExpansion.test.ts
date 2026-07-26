/**
 * useTurnExpansion 单测——w1 wave IF1 契约验证。
 *
 * 覆盖：默认折叠、per-session 隔离、toggle/expand/collapse 边沿、批量操作、
 * null sid no-op、cleanup 后重置、响应式（expand 触发下游 effect 重跑）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref, effectScope, effect } from 'vue'
import { useTurnExpansion } from '../useTurnExpansion'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'

beforeEach(() => {
  // 重置模块级 cleanup 注册表，防上例注册残留污染下例（useSessionScopedState 每实例自动注册）
  __clearSessionCleanupRegistryForTest()
})

describe('useTurnExpansion (w1 wave IF1)', () => {
  it('TC-w1-1 isExpanded 默认折叠（key 不存在返回 false）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded } = useTurnExpansion(sid)
    expect(isExpanded(0)).toBe(false)
  })

  it('TC-w1-2 per-session 隔离：s1 expand(0) 不影响 s2', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)
    expand(0)
    expect(isExpanded(0)).toBe(true)

    // 切到 s2：同一 api 的 current computed 随 sid.value 变化重算，查到 s2 空分区
    sid.value = 's2'
    expect(isExpanded(0)).toBe(false)

    // 切回 s1：分区数据保留，仍 true（Map 切 sid 不丢数据）
    sid.value = 's1'
    expect(isExpanded(0)).toBe(true)
  })

  it('TC-w1-3 toggle 边沿：两次翻转回到原态', () => {
    const sid = ref<string | null>('s1')
    const { toggle, isExpanded } = useTurnExpansion(sid)

    toggle(1)
    expect(isExpanded(1)).toBe(true)

    toggle(1)
    expect(isExpanded(1)).toBe(false)
  })

  it('TC-w1-4 expandAll/collapseAll 批量设置', () => {
    const sid = ref<string | null>('s1')
    const { expandAll, collapseAll, isExpanded } = useTurnExpansion(sid)
    const indices = [0, 1, 2]

    expandAll(indices)
    for (const i of indices) {
      expect(isExpanded(i)).toBe(true)
    }

    collapseAll(indices)
    for (const i of indices) {
      expect(isExpanded(i)).toBe(false)
    }
  })

  it('TC-w1-5 null sessionId：所有写方法 no-op 不抛，isExpanded 返回 false', () => {
    const sid = ref<string | null>(null)
    const { isExpanded, toggle, expand, collapse, expandAll, collapseAll } = useTurnExpansion(sid)

    expect(() => {
      toggle(0)
      expand(0)
      collapse(0)
      expandAll([0, 1, 2])
      collapseAll([0, 1, 2])
    }).not.toThrow()

    expect(isExpanded(0)).toBe(false)
  })

  it('TC-w1-6 cleanup 后状态重置（triggerSessionCleanups 移除分区）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)
    expand(0)
    expect(isExpanded(0)).toBe(true)

    // 触发该 sid 的所有 cleanup（useSessionScopedState 自动注册了删 Map 分区）
    triggerSessionCleanups('s1')

    // 分区被 cleanup 移除，current 重算时惰性新建空分区 → isExpanded 回到默认 false
    expect(isExpanded(0)).toBe(false)
  })

  it('TC-w1-7 响应式：expand 后下游 effect 重跑（依赖失效）', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand } = useTurnExpansion(sid)

    let runCount = 0
    const scope = effectScope()
    scope.run(() => {
      effect(() => {
        // 读 isExpanded 建立对 reactive 容器中该 key 的响应式依赖
        void isExpanded(0)
        runCount++
      })
    })

    expect(runCount).toBe(1) // 首次跑建立依赖

    expand(0) // mutate reactive 容器，effect 应失效重跑

    expect(runCount).toBe(2) // effect 重跑
    expect(isExpanded(0)).toBe(true)

    scope.stop() // 清理 effect
  })

  describe('TC-w1-8 hasAnyExpanded（IF1 公开方法）', () => {
    it('全折叠时 hasAnyExpanded([0,1,2]) 返回 false', () => {
      const sid = ref<string | null>('s1')
      const { hasAnyExpanded } = useTurnExpansion(sid)
      expect(hasAnyExpanded([0, 1, 2])).toBe(false)
    })

    it('部分展开（expand(1) 后）hasAnyExpanded([0,1,2]) 返回 true', () => {
      const sid = ref<string | null>('s1')
      const { expand, hasAnyExpanded } = useTurnExpansion(sid)
      expand(1)
      expect(hasAnyExpanded([0, 1, 2])).toBe(true)
    })

    it('空数组 hasAnyExpanded([]) 返回 false', () => {
      const sid = ref<string | null>('s1')
      const { hasAnyExpanded } = useTurnExpansion(sid)
      expect(hasAnyExpanded([])).toBe(false)
    })

    it('展开的 turnIndex 不在传入数组时不受其他 idx 影响（expand(5) 后 hasAnyExpanded([0,1]) 仍 false）', () => {
      const sid = ref<string | null>('s1')
      const { expand, hasAnyExpanded } = useTurnExpansion(sid)
      expand(5)
      expect(hasAnyExpanded([0, 1])).toBe(false)
    })
  })

  it('TC-w1-9 响应式：collapse（false↔true 来回切）effect 持续重跑', () => {
    const sid = ref<string | null>('s1')
    const { isExpanded, expand, collapse } = useTurnExpansion(sid)

    let runCount = 0
    const scope = effectScope()
    scope.run(() => {
      effect(() => {
        // 读 isExpanded 建立对 reactive 容器中该 key 的响应式依赖
        void isExpanded(0)
        runCount++
      })
    })

    expect(runCount).toBe(1) // 首次跑建立依赖

    expand(0) // mutate reactive 容器（false→true），effect 失效重跑
    expect(runCount).toBe(2)
    expect(isExpanded(0)).toBe(true)

    collapse(0) // 再次 mutate（true→false，赋值不 delete），effect 应再次失效重跑
    expect(runCount).toBe(3)
    expect(isExpanded(0)).toBe(false)

    scope.stop() // 清理 effect
  })
})
