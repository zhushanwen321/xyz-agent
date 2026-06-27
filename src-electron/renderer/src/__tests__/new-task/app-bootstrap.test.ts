/**
 * App 启动编排集成测试（#1/#3，问题1+3 同源回归防护）。
 *
 * 关键约束：**不 mock useNewTaskFlow**（之前的盲区就在这——组件层 83 测试绿但真实运行时
 * 暴露 state 停 idle）。本测试只 mock 最外层 @/api（session/chat）+ 间接依赖，
 * 让真实 useNewTaskFlow 状态机 + useSidebar.initApp 编排跑通，验证启动后 state 真正进 landing。
 *
 * 防护对象（任一回归立刻红）：
 * - 问题1：首次打开 APP 不是新建任务页（App 启动未自动 startFlow → state 停 idle）
 * - 问题3：目录/分支 chip 点击不生效（state=idle 时 transition('dir-popover') 非法抛错回 idle）
 * 两问题同源：state 从未离开 idle。本测试断言 state==='landing'（不是 idle）。
 *
 * 触发链路模拟：App.vue watch connectionState==='connected' → useSidebar.initApp()。
 * 测试直接调 initApp()（等价于 connected 后），绕过 ws-client 真实握手。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/app-bootstrap.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

// 可控依赖：session.list/create/switchSession/remove + chat.getHistory（initApp 编排路径触达）
const sessionCtrl = vi.hoisted(() => ({
  list: vi.fn<() => Promise<SessionGroup[]>>(),
  create: vi.fn<(cwd?: string) => Promise<SessionSummary>>(),
  switchSession: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
  remove: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const chatCtrl = vi.hoisted(() => ({
  // 返回空历史（首次启动无消息；非首启动 loadSessions 全量 hydrate 用空数组占位）
  getHistory: vi.fn<(id: string) => Promise<unknown[]>>().mockResolvedValue([]),
}))

vi.mock('@/api', () => ({
  session: {
    list: sessionCtrl.list,
    create: sessionCtrl.create,
    switchSession: sessionCtrl.switchSession,
    remove: sessionCtrl.remove,
  },
  chat: { getHistory: chatCtrl.getHistory },
}))

// useNewTaskFlow / useSidebar 均用真实实现（不 mock）——这是本测试的核心价值
import { useSidebar, resetAppBootstrap } from '@/composables/features/useSidebar'
import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  resetAppBootstrap()
  vi.clearAllMocks()
  sessionCtrl.switchSession.mockResolvedValue(undefined)
  sessionCtrl.remove.mockResolvedValue(undefined)
  chatCtrl.getHistory.mockResolvedValue([])
})

function mkSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: over.id ?? 's',
    label: over.label ?? 'label',
    cwd: over.cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 0,
    modelId: 'm',
    tokenCount: 0,
    ...over,
  }
}

describe('App 启动编排（initApp：连接建立后自动进 landing / 恢复最近 session）', () => {
  it('首次启动（无 session）：initApp → startFlow 延迟 create → state=landing（不是 idle）→ chip 可点', async () => {
    sessionCtrl.list.mockResolvedValue([]) // 无历史 → resolveDefaultCwd=undefined → 延迟 create
    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    // 问题1+3 回归防护核心：state 必须离开 idle 进 landing（state 停 idle = 两 bug 同时复现）
    expect(flow.state.value).toBe('landing')
    expect(flow.currentSessionId.value).toBeNull() // 延迟 create，无绑定 session（AC-1.7）
    expect(sessionCtrl.create).not.toHaveBeenCalled() // 首次启动不 create

    // 问题3 防护：state=landing 时 directory chip 的 transition('dir-popover') 合法，不抛错回 idle
    expect(() => flow.openDirPopover()).not.toThrow()
    expect(flow.state.value).toBe('dir-popover')
  })

  it('首次启动：非 git 目录下 branch chip 守卫生效（gitInfo=null → openBranchPopover 抛守卫错，非 state 死锁）', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 首次启动 currentSession=null → session.active=null → gitInfo=null
    // openBranchPopover 命中「非 git 目录」守卫抛错（AC-3.7），这是设计守卫，不是 idle 死锁的非法转换
    expect(flow.gitInfo.value).toBeNull()
    expect(() => flow.openBranchPopover()).toThrow('非 git 目录')
    // 守卫抛错后 state 被 reset 回 idle（AC-3.7 设计），区别于 landing→branch-popover 的合法路径
    expect(flow.state.value).toBe('idle')
  })

  it('非首次启动（有历史 session）：initApp → 恢复最近活跃 session，不 create 新 session（G1.1）', async () => {
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/a', sessions: [mkSession({ id: 'a', cwd: '/a', lastActiveAt: 100 })] },
      { cwd: '/b', sessions: [mkSession({ id: 'recent', cwd: '/b', lastActiveAt: 900 })] },
    ])
    await useSidebar().initApp()

    // G1.1：非首次不强制 new-task（不 create 新 session）
    expect(sessionCtrl.create).not.toHaveBeenCalled()
    // 恢复最近活跃（lastActiveAt=900 → recent），switchSession 载入
    expect(sessionCtrl.switchSession).toHaveBeenCalledWith('recent')
    expect(useSessionStore().activeId).toBe('recent')
    // 非首次启动不进 new-task flow（state 仍 idle，最近 session 走对话流而非 landing）
    expect(useNewTaskFlow().state.value).toBe('idle')
  })

  it('HMR/重连幂等：appBootstrapped 守卫，第二次 initApp 直接 return 不重复编排', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().initApp()
    expect(sessionCtrl.list).toHaveBeenCalledTimes(1)

    // 模拟 HMR 重连 / 断线重连后 state 再次变 connected → App.vue 再次触发 initApp
    await useSidebar().initApp()
    expect(sessionCtrl.list).toHaveBeenCalledTimes(1) // 幂等，未重复 loadSessions
  })

  it('启动失败（list reject）→ 重置 appBootstrapped，允许下次 connected 重试', async () => {
    sessionCtrl.list.mockRejectedValueOnce(new Error('runtime not ready'))
    await useSidebar().initApp() // 首次失败
    expect(useNewTaskFlow().state.value).toBe('idle') // 未进 landing

    sessionCtrl.list.mockResolvedValue([]) // 重连后 list 可用
    await useSidebar().initApp() // 重试
    expect(useNewTaskFlow().state.value).toBe('landing') // 重试成功进 landing
  })
})
