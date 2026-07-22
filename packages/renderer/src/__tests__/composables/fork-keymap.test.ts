/**
 * W3 fork 快捷键红灯测试（TDD：实现缺失，测试必须 fail）。
 *
 * 覆盖 U15-U16：
 * - U15 ⌘G / ⌘⇧G 触发 + shift 守卫（forkFromLastAssistant / enterForkModeFromLastAssistant）
 * - U16 composer focus 时禁用全局快捷键
 *
 * 实现现状（红灯基线）：Sidebar.vue keymap 只有 'k'/'n'/'b' 三项（Sidebar.vue:371-375），
 * 无 'g' 条目、无 fork 快捷键、无 composer focus 守卫。
 *
 * 策略：
 * - keymap 是 Sidebar.vue <script setup> 内的模块级 const，直接 mount Sidebar 需大量 store mock
 *   （参照 sidebar-layout.test.ts 注释「整体 mount 依赖多个 store/composable，成本高」）。
 *   故对 keymap 内容用源码断言（稳定，且 keymap 本就是配置数据），并对 useEventListener 派发
 *   做 mount 级验证（用最小 stub 排除子组件）。
 *
 * 红灯预期：keymap 无 'g' 条目、无 forkFromLastAssistant/enterForkModeFromLastAssistant、
 * 无 composer focus 守卫，下列用例应全 fail。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/fork-keymap.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'

// Sidebar.vue 引用构建期 vite define 注入的 __APP_VERSION__，测试环境无定义 → mount 抛 ReferenceError。
// 先在 globalThis 声明，让 mount 成功，从而让真实断言（fork 未被调用）成为失败点。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).__APP_VERSION__ = '0.0.0-test'

// ── mock useSidebar：暴露 forkFromLastAssistant / enterForkModeFromLastAssistant（W3 新增）──
const forkFromLastAssistantMock = vi.fn(() => Promise.resolve())
const enterForkModeFromLastAssistantMock = vi.fn(() => Promise.resolve())
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({
    forkFromLastAssistant: forkFromLastAssistantMock,
    enterForkModeFromLastAssistant: enterForkModeFromLastAssistantMock,
    loadSessions: vi.fn(),
    selectSession: vi.fn(),
    newSession: vi.fn(),
    goOverview: vi.fn(),
    toggleCollapse: vi.fn(),
    syncSessionToPanel: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    focusedSessionId: { value: null },
    focusedSession: { value: null },
  }),
}))
vi.mock('@/composables/features/useSubagentListSync', () => ({ useSubagentListSync: vi.fn() }))
vi.mock('@/composables/features/useWorkflowListSync', () => ({ useWorkflowListSync: vi.fn() }))
vi.mock('@/composables/features/useSessionDerivations', () => ({
  useSessionDerivations: () => ({
    derivedStatus: vi.fn(() => 'idle'),
    sessionDigest: vi.fn(() => ''),
    invalidateStatusCache: vi.fn(),
  }),
  invalidateStatusCache: vi.fn(),
}))
vi.mock('@/composables/features/useSidebarSubagentActions', () => ({
  useSidebarSubagentActions: () => ({ stopSubagent: vi.fn() }),
}))
vi.mock('@/composables/features/useSearchModal', () => ({
  useSearchModal: () => ({ open: vi.fn(), toggle: vi.fn(), close: vi.fn(), isOpen: { value: false } }),
}))
vi.mock('@/api/events', () => ({
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))
vi.mock('@/api', () => ({
  extension: { scan: vi.fn() },
}))

import Sidebar from '@/components/sidebar/Sidebar.vue'
import { useCommandStore } from '@/stores/command'

beforeEach(() => {
  setActivePinia(createPinia())
  forkFromLastAssistantMock.mockReset()
  enterForkModeFromLastAssistantMock.mockReset()
  // happy-dom: 清掉可能残留的 composer 焦点（body.blur 让 activeElement 回到 body）
  document.body.focus?.()
})

function sidebarPath(): string {
  return path.resolve(__dirname, '../../components/sidebar/Sidebar.vue')
}

function mountSidebar() {
  return mount(Sidebar, {
    global: {
      plugins: [createPinia()],
      stubs: {
        SegmentedTab: true,
        SessionList: true,
        FileView: true,
        SubagentList: true,
        WorkflowList: true,
        WorkflowDetail: true,
        RenameSessionDialog: true,
        SearchModal: true,
      },
    },
  })
}

/** 派发 window keydown（Sidebar useEventListener(window, 'keydown') 监听） */
function dispatchKey(opts: { key: string; meta?: boolean; shift?: boolean }): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: opts.key,
      metaKey: !!opts.meta,
      shiftKey: !!opts.shift,
      bubbles: true,
      cancelable: true,
    }),
  )
}

/** 模拟 composer 聚焦：插入 composer-box 元素并 .focus()（happy-dom 让 activeElement 跟随） */
function focusComposer(): void {
  // composer-box 必须可聚焦（tabindex=0），否则 .focus() 在 happy-dom 不会更新 activeElement
  const composerEl = document.createElement('div')
  composerEl.setAttribute('data-testid', 'composer-box')
  composerEl.classList.add('composer-box')
  composerEl.setAttribute('tabindex', '0')
  document.body.appendChild(composerEl)
  composerEl.focus()
}

// ── U15：⌘G / ⌘⇧G 触发 + shift 守卫 ────────────────────────────────────
describe('U15：⌘G / ⌘⇧G 触发 fork 动作 + shift 守卫', () => {
  it('keymap 含 g 条目（源码断言：当前只有 k/n/b，无 g）', () => {
    const source = fs.readFileSync(sidebarPath(), 'utf-8')
    // 红灯：当前 keymap 无 'g' 条目（尾 \b 对 'g' 形式无效——' 后无词边界，去掉）
    expect(source).toMatch(/\bkey:\s*'g'/)
  })

  it('keymap 含 shift 修饰的 g 条目（⌘⇧G）', () => {
    const source = fs.readFileSync(sidebarPath(), 'utf-8')
    // 红灯：当前无 shift+g / enterForkModeFromLastAssistant
    expect(source).toMatch(/enterForkModeFromLastAssistant/)
    expect(source).toMatch(/forkFromLastAssistant/)
  })

  it('⌘G（无 shift）触发 forkFromLastAssistant', async () => {
    const wrapper = mountSidebar()
    // 红灯：当前 keymap 无 g，⌘G 不会命中 → forkFromLastAssistant 未被调
    dispatchKey({ key: 'g', meta: true })
    await wrapper.vm.$nextTick()
    expect(forkFromLastAssistantMock).toHaveBeenCalledTimes(1)
  })

  it('⌘⇧G（含 shift）触发 enterForkModeFromLastAssistant', async () => {
    const wrapper = mountSidebar()
    dispatchKey({ key: 'g', meta: true, shift: true })
    await wrapper.vm.$nextTick()
    expect(enterForkModeFromLastAssistantMock).toHaveBeenCalledTimes(1)
  })

  it('⌘G（无 shift）触发 forkFromLastAssistant 且不误触发 shift 项 enterForkModeFromLastAssistant', async () => {
    const wrapper = mountSidebar()
    dispatchKey({ key: 'g', meta: true })
    await wrapper.vm.$nextTick()
    // 前置：⌘G 必须先真正触发 forkFromLastAssistant（当前 keymap 无 g → 此断言红灯）
    expect(forkFromLastAssistantMock).toHaveBeenCalledTimes(1)
    // shift 守卫：⌘G（无 shift）不应同时触发 shift 项
    expect(enterForkModeFromLastAssistantMock).not.toHaveBeenCalled()
  })
})

// ── U16：composer focus 时禁用全局快捷键 ─────────────────────────────────
describe('U16：composer focus 时 ⌘G 不触发 fork', () => {
  it('composer 输入聚焦时 ⌘G → forkFromLastAssistant 未被调用（非聚焦时正常触发）', async () => {
    // 前置：非聚焦态 ⌘G 必须正常触发（当前 keymap 无 g → 此断言红灯，避免空绿）
    const wrapperUnfocused = mountSidebar()
    dispatchKey({ key: 'g', meta: true })
    await wrapperUnfocused.vm.$nextTick()
    expect(forkFromLastAssistantMock).toHaveBeenCalledTimes(1)
    wrapperUnfocused.unmount()

    // 聚焦 composer 后再按 ⌘G：focus 守卫应拦截，不触发 fork
    forkFromLastAssistantMock.mockClear()
    const wrapper = mountSidebar()
    focusComposer()
    dispatchKey({ key: 'g', meta: true })
    await wrapper.vm.$nextTick()
    expect(forkFromLastAssistantMock).not.toHaveBeenCalled()
  })

  it('源码含 composer focus 守卫（activeElement / composer-box 检测）', () => {
    const source = fs.readFileSync(sidebarPath(), 'utf-8')
    // 红灯：当前 keydown handler 无 focus 检测逻辑
    expect(source).toMatch(/composer-box|activeElement|isComposerFocused/i)
  })
})
