/**
 * useWorkflowDrawerTabs 单测（workflow DAG 可视化 W1 wave）。
 *
 * 覆盖二级 tab 状态管理（per-session 隔离 Map 分区）的 3 个场景：
 * 1. open/close/isOpened 基本流程
 * 2. 切 session 隔离（A 打开的 run 不在 B 出现）
 * 3. 重复 open 更新时间戳排序（最近打开在前）
 *
 * 运行：npx vitest run src/composables/workflow/__tests__/use-workflow-drawer-tabs.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import { useWorkflowDrawerTabs } from '../use-workflow-drawer-tabs'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

/** 在独立 effectScope 内运行 composable，测试后 dispose 模拟卸载（防状态泄漏）。 */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

beforeEach(() => {
  // 清空模块级 cleanup 注册表，防跨用例污染
  __clearSessionCleanupRegistryForTest()
})

describe('W1 useWorkflowDrawerTabs: 二级 tab 状态管理', () => {
  it('场景1 open/close/isOpened：open 后 isWorkflowOpened=true 且列表含该 run；close 后清空', async () => {
    const sid = ref<string | null>('session-A')
    const { result, dispose } = runWithScope(() => useWorkflowDrawerTabs(sid))

    try {
      // 初始无打开
      expect(result.isWorkflowOpened('wf-001')).toBe(false)
      expect(result.openedRunIds.value).toEqual([])

      // open wf-001
      result.openWorkflow('wf-001')
      await nextTick()
      expect(result.isWorkflowOpened('wf-001')).toBe(true)
      expect(result.openedRunIds.value).toContain('wf-001')

      // close wf-001
      result.closeWorkflow('wf-001')
      await nextTick()
      expect(result.isWorkflowOpened('wf-001')).toBe(false)
      expect(result.openedRunIds.value).toEqual([])
    } finally {
      dispose()
    }
  })

  it('场景2 切 session 隔离：A 打开的 run 不在 B 的 openedRunIds 出现', async () => {
    const sid = ref<string | null>('session-A')
    const { result, dispose } = runWithScope(() => useWorkflowDrawerTabs(sid))

    try {
      // 在 A 打开 wf-001
      result.openWorkflow('wf-001')
      await nextTick()
      expect(result.openedRunIds.value).toContain('wf-001')

      // 切到 session-B：B 分区独立，不含 A 打开的 run
      sid.value = 'session-B'
      await nextTick()
      expect(result.openedRunIds.value).toEqual([])
      expect(result.isWorkflowOpened('wf-001')).toBe(false)

      // 切回 A：A 分区数据保留（不丢失）
      sid.value = 'session-A'
      await nextTick()
      expect(result.openedRunIds.value).toContain('wf-001')
      expect(result.isWorkflowOpened('wf-001')).toBe(true)
    } finally {
      dispose()
    }
  })

  it('场景3 重复 open 更新时间戳排序：最近打开的排前（DESC）', async () => {
    // 用 fake timers 让 Date.now() 在每次 open 时递增，确保时间戳可区分排序
    let now = 1_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      const t = now
      now += 1000 // 每次 Date.now() 调用递增 1s
      return t
    })

    const sid = ref<string | null>('session-A')
    const { result, dispose } = runWithScope(() => useWorkflowDrawerTabs(sid))

    try {
      // open wf-001（t=1000000）
      result.openWorkflow('wf-001')
      // open wf-002（t=1001000）
      result.openWorkflow('wf-002')
      // 再次 open wf-001（t=1002000，更新为最新）→ wf-001 应排前
      result.openWorkflow('wf-001')
      await nextTick()

      // 最近打开在前（DESC）：wf-001（最新）→ wf-002
      expect(result.openedRunIds.value).toEqual(['wf-001', 'wf-002'])
    } finally {
      dispose()
      dateSpy.mockRestore()
    }
  })
})
