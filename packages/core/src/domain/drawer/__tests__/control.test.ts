/**
 * drawer control 分区契约单测（TC1）。
 *
 * 覆盖：bindDrawerSessionId 绑定 / per-session 分区隔离 + 切回恢复 / null sid no-op /
 * tasks tab 强制 docked 仅当前分区 / 手动 open 清当前 sid pendingOpen（FR-9，经 coordination
 * 公开 API 验证——openDrawerTab 是唯一带 FR-9 清理的公开入口）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/control.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。core vitest 环境为 node（vue reactivity
 * ref/computed 在 node 环境可跑，无 DOM 依赖）。
 *
 * 状态隔离：drawer 域是模块级单例（controlState/pendingOpenMap/瞬时参数跨用例残留），
 * beforeEach 调 _resetDrawerForTest()（coordination 导出，组合清 control 分区 + pendingOpen
 * + 瞬时参数）。绑定目标 ref 每个用例新建（bindDrawerSessionId 新 ref 覆盖语义）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { bindDrawerSessionId, useDrawerControl, getBoundSessionId } from '../control'
import { openDrawerTab, setPendingOpenForSid, getPendingOpenForSid, _resetDrawerForTest } from '../coordination'

/** 当前测试分区键（每用例新建，bindDrawerSessionId 覆盖绑定） */
let sid: Ref<string | null>

/** 切换当前 focused session（模拟 selectSession 改 active panel 的 session 绑定） */
function focusSession(s: string | null): void {
  sid.value = s
}

beforeEach(() => {
  sid = ref<string | null>(null)
  bindDrawerSessionId(sid)
  _resetDrawerForTest()
})

describe('drawer control 分区隔离与切回恢复', () => {
  it('A 开 tasks，切 B 为默认态，切回 A 恢复三态（isOpen/activeTab/docked）', () => {
    focusSession('A')
    const { isOpen, activeTab, docked } = useDrawerControl()
    openDrawerTab('tasks') // tasks tab 强制 docked=true（仅 A 分区）
    expect(isOpen.value).toBe(true)
    expect(activeTab.value).toBe('tasks')
    expect(docked.value).toBe(true)

    // 切到 B（B 独立操作，不影响 A 分区）
    focusSession('B')
    const drawerB = useDrawerControl()
    expect(drawerB.isOpen.value).toBe(false)
    expect(drawerB.activeTab.value).toBe('terminal')
    expect(drawerB.docked.value).toBe(false)

    // 切回 A
    focusSession('A')
    const drawerA = useDrawerControl()
    expect(drawerA.isOpen.value).toBe(true)
    expect(drawerA.activeTab.value).toBe('tasks')
    expect(drawerA.docked.value).toBe(true)
  })

  it('tasks tab 强制 docked 仅当前分区，不污染其他 session', () => {
    focusSession('A')
    openDrawerTab('tasks')
    expect(useDrawerControl().docked.value).toBe(true)

    focusSession('B')
    expect(useDrawerControl().docked.value).toBe(false) // B 默认，不被 A 污染

    focusSession('A')
    expect(useDrawerControl().docked.value).toBe(true)
  })

  it('切 sid 后 isOpen 立即为 true（reactive 容器契约回归：plain object init 会失效）', () => {
    // 回归：init 工厂漏 reactive() 时，sid 稳定下 open 的 mutate 不触发 computed 重算，
    // isOpen 缓存旧值 false。修复后 reactive 容器使 mutate 正确传播。
    focusSession('A')
    const { isOpen, activeTab } = useDrawerControl()
    expect(isOpen.value).toBe(false) // 缓存建立（模拟组件已渲染）

    openDrawerTab('git') // 手动 toggle，sid 未变化

    expect(isOpen.value).toBe(true) // 修复前为 false（bug）
    expect(activeTab.value).toBe('git')
  })
})

describe('null sid no-op 语义', () => {
  it('绑定值为 null（绑定前等价态）时公开 API 不抛错、不写 Map 分区', () => {
    // sid 初始为 null（未绑定任何 session）。null sid 时 controlState.current 返回
    // 临时默认实例（不写 Map），update no-op——对 null 实例的 mutate 不持久。
    expect(getBoundSessionId()).toBe(null)
    expect(() => {
      openDrawerTab('git')
      openDrawerTab('tasks', { commandName: '/commit' })
    }).not.toThrow()
    // 手动 open 的 FR-9 清理在 null sid 下跳过（sid null 不清 pendingOpen）——不抛错即可
    expect(() => setPendingOpenForSid('ghost')).not.toThrow()

    // 绑定真实 sid 后，其分区是默认态（isOpen=false/activeTab=terminal）——
    // 证明 null sid 期的 open 没有泄漏进任何真实分区
    focusSession('X')
    const drawer = useDrawerControl()
    expect(drawer.isOpen.value).toBe(false)
    expect(drawer.activeTab.value).toBe('terminal')
    expect(drawer.docked.value).toBe(false)
  })

  it('bindDrawerSessionId 幂等：重复绑定同一 ref 不报错，新 ref 覆盖', () => {
    const refA = ref<string | null>('A')
    bindDrawerSessionId(refA)
    expect(getBoundSessionId()).toBe('A')

    bindDrawerSessionId(refA) // 同 ref 重复绑定
    expect(getBoundSessionId()).toBe('A')

    const refB = ref<string | null>('B')
    bindDrawerSessionId(refB) // 新 ref 覆盖
    expect(getBoundSessionId()).toBe('B')

    refA.value = 'A2' // 旧 ref 不再生效（已解绑）
    expect(getBoundSessionId()).toBe('B')
  })
})

describe('FR-9：手动 open 清当前 sid pendingOpen', () => {
  it('A 有 pendingOpen=true，手动 open("git") 后清标记', () => {
    focusSession('A')
    setPendingOpenForSid('A')
    expect(getPendingOpenForSid('A')).toBe(true)

    openDrawerTab('git') // 手动 open（任意 tab）→ 清当前 sid 标记

    expect(getPendingOpenForSid('A')).toBe(false)
  })

  it('手动 open 只清当前 sid，不动其他 sid 的 pendingOpen', () => {
    focusSession('A')
    setPendingOpenForSid('B') // 后台 B 有事件
    expect(getPendingOpenForSid('B')).toBe(true)

    openDrawerTab('git') // 手动 open 当前 A

    expect(getPendingOpenForSid('B')).toBe(true) // B 的标记保留（用户切回 B 时消费）
    expect(getPendingOpenForSid('A')).toBe(false)
  })
})
