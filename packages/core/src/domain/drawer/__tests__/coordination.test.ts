/**
 * drawer coordination 协同层单测（TC2）。
 *
 * 覆盖：pendingOpen 置/读/消费（consumePendingOpen 两分支）/ openTasksDrawerOnFirstData
 * 守卫分发（focused 直接 open / 非 focused 置标记 / hasData=false 早退）/ 瞬时参数
 * （selectedCommandName/detailFilePath/browserUrl 设置 + consumeBrowserUrl 消费后清空）/
 * cleanup 注册（triggerSessionCleanups(sid) 清 pendingOpenMap 条目）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/coordination.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 *
 * 状态隔离：beforeEach 调 _resetDrawerForTest() 清模块级单例状态；不调
 * __clearSessionCleanupRegistryForTest()——drawer 域的 cleanup 注册在模块加载时完成（一次），
 * 跨用例保留正确（triggerSessionCleanups 需调得到它），与 renderer useSideDrawer.test 同策略。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { bindDrawerSessionId, useDrawerControl } from '../control'
import {
  setPendingOpenForSid,
  getPendingOpenForSid,
  consumePendingOpen,
  openTasksDrawerOnFirstData,
  openDrawerTab,
  closeDrawer,
  toggleDrawer,
  setDrawerTab,
  toggleDrawerDock,
  selectedCommandName,
  detailFilePath,
  browserUrl,
  consumeBrowserUrl,
  _resetDrawerForTest,
} from '../coordination'
import { triggerSessionCleanups } from '../../../foundation/use-session-scoped-state'

/** 当前测试分区键（每用例新建绑定） */
let sid: Ref<string | null>

function focusSession(s: string | null): void {
  sid.value = s
}

beforeEach(() => {
  sid = ref<string | null>(null)
  bindDrawerSessionId(sid)
  _resetDrawerForTest()
})

describe('pendingOpen 置/读/消费', () => {
  it('setPendingOpenForSid 置标记，getPendingOpenForSid 读回；未置的 sid 返回 false', () => {
    setPendingOpenForSid('A')
    expect(getPendingOpenForSid('A')).toBe(true)
    expect(getPendingOpenForSid('B')).toBe(false) // 未置
  })

  it('consumePendingOpen 消费：标记为 true → open tasks + 清标记（作用于当前分区）', () => {
    focusSession('C')
    setPendingOpenForSid('C')
    expect(getPendingOpenForSid('C')).toBe(true)

    // 用户切到 C（selectSession 内部会调 consumePendingOpen）——此时 focused 已是 C
    consumePendingOpen('C')

    const { isOpen, activeTab } = useDrawerControl()
    expect(isOpen.value).toBe(true)
    expect(activeTab.value).toBe('tasks')
    expect(getPendingOpenForSid('C')).toBe(false)
  })

  it('consumePendingOpen 对无标记 sid no-op（不 open、不清不存在的标记）', () => {
    focusSession('A')
    consumePendingOpen('A') // 无标记
    expect(useDrawerControl().isOpen.value).toBe(false)
    expect(getPendingOpenForSid('A')).toBe(false)
  })
})

describe('openTasksDrawerOnFirstData 守卫分发', () => {
  it('hasData=true 且 focused sid === 入参 sid → 直接 open tasks（当前分区）', () => {
    focusSession('A')
    openTasksDrawerOnFirstData('A', true)

    const { isOpen, activeTab } = useDrawerControl()
    expect(isOpen.value).toBe(true)
    expect(activeTab.value).toBe('tasks')
    expect(getPendingOpenForSid('A')).toBe(false) // 直接 open 不置标记
  })

  it('hasData=true 且 focused sid !== 入参 sid → 只置 pendingOpen，不直接 open', () => {
    focusSession('A')
    openTasksDrawerOnFirstData('B', true) // 后台 B 的 tasks 数据到达

    expect(useDrawerControl().isOpen.value).toBe(false) // A 的 drawer 不被弹开
    expect(getPendingOpenForSid('B')).toBe(true) // 标记待切回消费
  })

  it('hasData=false 直接 return（调用方前置守卫）：不 open 不置标记', () => {
    focusSession('A')
    openTasksDrawerOnFirstData('A', false)
    openTasksDrawerOnFirstData('B', false)

    expect(useDrawerControl().isOpen.value).toBe(false)
    expect(getPendingOpenForSid('A')).toBe(false)
    expect(getPendingOpenForSid('B')).toBe(false)
  })
})

describe('瞬时参数：设置 + 消费后清空', () => {
  it('openDrawerTab 的 opts 写入对应瞬时参数 ref', () => {
    focusSession('A')
    openDrawerTab('doc', { commandName: '/commit' })
    expect(selectedCommandName.value).toBe('/commit')

    openDrawerTab('detail', { filePath: 'src/foo.ts' })
    expect(detailFilePath.value).toBe('src/foo.ts')

    openDrawerTab('browser', { url: 'https://example.com' })
    expect(browserUrl.value).toBe('https://example.com')
  })

  it('consumeBrowserUrl 读取并清空（消费后为 null，不残留劫持下次打开）', () => {
    focusSession('A')
    openDrawerTab('browser', { url: 'https://example.com' })
    expect(browserUrl.value).toBe('https://example.com')

    const consumed = consumeBrowserUrl()
    expect(consumed).toBe('https://example.com')
    expect(browserUrl.value).toBe(null)

    // 未设置时消费返回 null
    expect(consumeBrowserUrl()).toBe(null)
  })

  it('opts 缺省字段不覆盖已有瞬时参数（undefined 不写入）', () => {
    focusSession('A')
    openDrawerTab('doc', { commandName: '/commit' })
    openDrawerTab('git') // 无 opts——不应把 commandName 清掉
    expect(selectedCommandName.value).toBe('/commit')
  })
})

describe('公开 API 薄封装（close/toggle/setTab/toggleDock）', () => {
  it('close 关闭当前分区；toggle 从关到开可指定 tab、从开到关关闭；setTab 切 tab；toggleDock 切换钉住态', () => {
    focusSession('A')
    const { isOpen, activeTab, docked } = useDrawerControl()

    toggleDrawer('git') // 关 → 开（git tab）
    expect(isOpen.value).toBe(true)
    expect(activeTab.value).toBe('git')

    toggleDrawer() // 开 → 关
    expect(isOpen.value).toBe(false)

    setDrawerTab('browser') // 抽屉关闭时仅改 activeTab
    expect(activeTab.value).toBe('browser')
    expect(isOpen.value).toBe(false)

    setDrawerTab('tasks') // tasks tab 自动 docked
    expect(docked.value).toBe(true)

    toggleDrawerDock()
    expect(docked.value).toBe(false)

    closeDrawer()
    expect(isOpen.value).toBe(false)
  })
})

describe('cleanup 注册：session 销毁清 pendingOpen', () => {
  it('triggerSessionCleanups(A) 清掉 A 的 pendingOpen 标记', () => {
    focusSession('A')
    setPendingOpenForSid('A')
    setPendingOpenForSid('B')
    expect(getPendingOpenForSid('A')).toBe(true)

    // session 销毁编排（useSidebar.deleteSession 统一触发）
    triggerSessionCleanups('A')

    expect(getPendingOpenForSid('A')).toBe(false)
    expect(getPendingOpenForSid('B')).toBe(true) // 其他 session 不受影响
  })

  it('_resetDrawerForTest 清 pendingOpen + 瞬时参数（测试隔离钩子）', () => {
    focusSession('A')
    openDrawerTab('doc', { commandName: '/commit' })
    openDrawerTab('browser', { url: 'https://example.com' })
    setPendingOpenForSid('B') // B 非 focused，openDrawerTab 的 FR-9 不会清它
    expect(getPendingOpenForSid('B')).toBe(true)
    expect(browserUrl.value).not.toBe(null)

    _resetDrawerForTest()

    expect(getPendingOpenForSid('B')).toBe(false)
    expect(selectedCommandName.value).toBe(null)
    expect(detailFilePath.value).toBe(null)
    expect(browserUrl.value).toBe(null)
  })
})
