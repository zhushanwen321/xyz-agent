/**
 * useTerminal 重连清 scrollback + 重新 attach 测试（wave3 P2-s4 TC26/TC27，spec §6.3）。
 *
 * 覆盖：
 * - TC26: clearScrollback 清当前分区 scrollback（保留 reactive 容器 + ptyAlive/cols/rows 不变）
 * - TC27: bumpReconnectEpoch 触发 useTerminal 自清当前 sid 分区 scrollback
 * - TC28: 重连清空后若 terminal 活跃（ptyAlive=true）→ 重新 attach 触发服务端回灌（spec §6.3
 *   「重新 attach → 服务端回灌全量」+ §七改善表「重连后切到 terminal tab → attach 回灌补齐」）
 *
 * clearScrollback 是 useTerminal 内部方法（不暴露在 return）——通过宿主组件 setup 内
 * expose 拿到引用，或通过 reconnect 信号间接验证（TC27）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/useTerminal-clear.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// ── mock terminalApi（隔离 RPC）────────────────────────────────────────────
const terminalApiMock = vi.hoisted(() => ({
  spawn: vi.fn(() => Promise.resolve()),
  write: vi.fn(() => Promise.resolve()),
  resize: vi.fn(() => Promise.resolve()),
  kill: vi.fn(() => Promise.resolve()),
  attach: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

import { useTerminal } from '@/composables/features/useTerminal'
import { useSessionEvents } from '@/composables/features/useSessionEvents'
import { bumpReconnectEpoch, useReconnectEpoch } from '@/lib/terminal-reconnect-signal'
import type { ServerMessage } from '@xyz-agent/shared'

/**
 * 测试宿主组件：在 setup 内调 useTerminal，expose terminal + 内部 clearScrollback
 *（clearScrollback 不在 useTerminal return，通过闭包捕获 expose 给测试）。
 */
function makeHost(sessionId: string | null) {
  let exposedClear: ((sid: string) => void) | null = null
  const Host = defineComponent({
    setup() {
      const sidRef = ref(sessionId)
      const terminal = useTerminal(sidRef)
      // useTerminal 内部 clearScrollback 不 expose——测试通过 reconnect 信号间接触发（TC27）。
      // TC26 直接调 clearScrollback：通过 useSessionScopedState 的 updateFor 不便暴露，
      // 故 TC26 改为通过 terminal.data 推送积累 + reconnect 信号清空的端到端验证（与 TC27 合并思路）。
      return { terminal, sidRef }
    },
    render: () => h('div'),
  })
  return { Host, getClear: () => exposedClear }
}

beforeEach(() => {
  setActivePinia(createPinia())
  terminalApiMock.spawn.mockClear()
  terminalApiMock.write.mockClear()
  terminalApiMock.resize.mockClear()
  terminalApiMock.kill.mockClear()
  terminalApiMock.attach.mockClear()
})

/**
 * 工具：通过 useSessionEvents 注册的 handler 模拟 terminal.data 推送到指定 session 分区。
 * useTerminal setup 内 onMessage('terminal.data', handler) 注册到 useSessionEvents，
 * 测试通过 useSessionEvents 直接 emit 模拟 server 推送。
 */
function emitTerminalData(sid: string, data: string): void {
  // useSessionEvents 内部用 events.dispatchSession 路由；测试直接调 events 模块。
  // 但 useTerminal 的 onMessage 是经 useSessionEvents 注册的回调——需通过其内部机制触发。
  // 简化：直接读 useTerminal 的 current 并 push（绕过事件路由，验证 clearScrollback 逻辑本身）。
  // 实际通过 mount 后 reactive 容器可直接 mutate（与实现 updateFor 等价）。
  void sid
  void data
}

// ──────────────────────────────────────────────────────────
// TC26: clearScrollback 清 scrollback 不清 PTY 状态
// ──────────────────────────────────────────────────────────
describe('TC26: clearScrollback 清 scrollback 保留 PTY 状态', () => {
  it('scrollback 积累后清空，ptyAlive/cols/rows 不变', async () => {
    const { Host } = makeHost('s1')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as ReturnType<typeof useTerminal>

    // 积累 scrollback（直接 mutate reactive 容器，等价于 terminal.data 推送）
    terminal.current.value.scrollback.push('line1', 'line2', 'line3')
    terminal.current.value.ptyAlive = true
    terminal.current.value.cols = 120
    terminal.current.value.rows = 40
    expect(terminal.current.value.scrollback).toHaveLength(3)

    // clearScrollback 不在 return——通过 reconnect 信号触发（与 TC27 同机制），
    // 此处验证信号清空后 PTY 状态保留（合并 TC26/27 的端到端断言）。
    bumpReconnectEpoch()
    await wrapper.vm.$nextTick()

    // scrollback 清空
    expect(terminal.current.value.scrollback).toEqual([])
    // PTY 状态保留（clearScrollback 只清缓冲数据非 PTY 状态）
    expect(terminal.current.value.ptyAlive).toBe(true)
    expect(terminal.current.value.cols).toBe(120)
    expect(terminal.current.value.rows).toBe(40)
    wrapper.unmount()
  })
})

// ──────────────────────────────────────────────────────────
// TC27: bumpReconnectEpoch 触发 useTerminal 自清 scrollback
// ──────────────────────────────────────────────────────────
describe('TC27: reconnect 信号触发自清', () => {
  it('未 bump 时 scrollback 不清；bump 后清空当前 sid 分区', async () => {
    const { Host } = makeHost('s1')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as ReturnType<typeof useTerminal>

    // 积累 scrollback
    terminal.current.value.scrollback.push('a', 'b')
    expect(terminal.current.value.scrollback).toHaveLength(2)

    // 未 bump：scrollback 不清
    await wrapper.vm.$nextTick()
    expect(terminal.current.value.scrollback).toHaveLength(2)

    // bump（模拟重连）：watch 触发自清
    bumpReconnectEpoch()
    await wrapper.vm.$nextTick()
    expect(terminal.current.value.scrollback).toEqual([])
    wrapper.unmount()
  })

  it('null sid 时 bump 不报错（no-op，sessionIdRef.value 为 null）', async () => {
    const { Host } = makeHost(null)
    const wrapper = mount(Host)
    // bump 不应抛（sid null 守卫）
    expect(() => bumpReconnectEpoch()).not.toThrow()
    await wrapper.vm.$nextTick()
    wrapper.unmount()
  })

  it('useReconnectEpoch 返回只读递增计数器', () => {
    const epoch = useReconnectEpoch()
    const before = epoch.value
    bumpReconnectEpoch()
    expect(epoch.value).toBe(before + 1)
  })
})

// ──────────────────────────────────────────────────────────
// TC28: 重连清空后若 terminal 活跃（ptyAlive=true）→ 重新 attach（spec §6.3 + §七改善表）
// ──────────────────────────────────────────────────────────
describe('TC28: 重连后若 terminal 活跃则重新 attach 触发服务端回灌', () => {
  it('ptyAlive=true 时 bump 后清 scrollback 并重新 attach', async () => {
    const { Host } = makeHost('s1')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as ReturnType<typeof useTerminal>

    // 模拟 PTY 已 spawn（TerminalView mount 后 spawn 成功的服务端反馈）
    terminal.current.value.ptyAlive = true
    // 积累 scrollback（断线前输出）
    terminal.current.value.scrollback.push('line1', 'line2')
    expect(terminalApiMock.attach).not.toHaveBeenCalled()

    // bump（模拟重连）：watch 触发清空 + 重新 attach
    bumpReconnectEpoch()
    await wrapper.vm.$nextTick()

    // scrollback 清空（断线前缓冲与回灌重复显示规避）
    expect(terminal.current.value.scrollback).toEqual([])
    // 重新 attach 触发服务端回灌全量 scrollback（spec §6.3「重新 attach → 服务端回灌全量」）
    expect(terminalApiMock.attach).toHaveBeenCalledWith('s1')
    expect(terminalApiMock.attach).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('ptyAlive=false（未打开过 terminal tab）时 bump 后清 scrollback 但不 attach', async () => {
    const { Host } = makeHost('s1')
    const wrapper = mount(Host)
    const terminal = wrapper.vm.terminal as ReturnType<typeof useTerminal>

    // PTY 未 spawn（用户没打开过 terminal tab）
    terminal.current.value.ptyAlive = false
    terminal.current.value.scrollback.push('a', 'b')

    bumpReconnectEpoch()
    await wrapper.vm.$nextTick()

    // scrollback 仍清空（清空逻辑不依赖 ptyAlive）
    expect(terminal.current.value.scrollback).toEqual([])
    // 不 attach——未打开过 terminal tab，attach 会浪费资源（无 PTY session 可回灌）
    expect(terminalApiMock.attach).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
