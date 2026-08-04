/**
 * PanelContainer 集成测试 —— 单 panel + Drawer 壳路径（W4 drawer-shell-integration）。
 *
 * 迁移自旧 panel-container-drawer-mode.test.ts（SideDrawer stub → DrawerPanel 真实渲染）
 * + 旧 side-drawer.test.ts / SideDrawer.test.ts 的行为断言壳路径版（D6 triage：行为型迁移
 * 改写为壳路径断言，内部断言/mock spy 型删除）。
 *
 * 壳路径（mount PanelContainer，test-strategy 集成章节要求）：
 * - PanelContainer 渲染跨端共享容器 DrawerPanel（@xyz-agent/ui/features/drawer，W3），
 *   断言 drawer-tab-* 五 tab 按钮 + drawer-panel + drawer-content DOM 存在（AC9/AC12 壳层载体）
 * - drawerOpen=true：DrawerPanel 作 SplitterPanel 子项挂载（split 布局）
 * - drawerOpen=false：连同 ResizeHandle 一起卸载，退化为单 panel（v-if 门控）
 * - ESC 关闭（window keydown）+ close 按钮关闭 → drawer 卸载（旧 side-drawer.test.ts 行为迁移）
 * - widget 缓冲壳路径渲染：mock useSessionEvents 捕获 handler → emit extension:widget →
 *   core createDrawerBuffers 经 props 喂 DrawerPanel → drawer-widget-lines 渲染
 *   （旧 SideDrawer.test.ts AC-4 壳路径版；per-session 隔离核心语义由 core W2 覆盖）
 * - unread badge（AC-13）：chatStore 消息数增长 → header-extra slot 内 drawer-unread-badge
 *   出现并显示计数；关 drawer 清零
 *
 * 控制态经 core drawer 域直连（PanelContainer 自持 bindDrawerSessionId，不消费 useSideDrawer
 * 兼容层——C1）：测试同样直连 core（bindDrawerSessionId + openDrawerTab + _resetDrawerForTest）。
 * 桌面独占面板（GitPanel/CommandDocPanel/DetailPane/BrowserPane/TerminalView）
 * stub 为占位 div（避免真实组件依赖，对齐旧测试 stub 策略）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-container-drawer-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, ref, computed, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  _resetDrawerForTest,
} from '@xyz-agent/core/domain/drawer'
import type { ServerMessage } from '@xyz-agent/shared'

// ── mock 壳层依赖（PanelContainer setup 阶段执行，避免真实 WS/session 副作用）──
vi.mock('@/composables/features/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// ── mock chatStore：unread badge（AC-13）可控消息数 ──
// PanelContainer 用 chatStore.getMessages(sessionId).length 感知 agent 新消息。
// vitest 的 vi.mock 工厂无法引用非 hoisted 顶层 import（reactive），故用 hoisted 容器做转发：
// 响应式 Map（reactiveMessages，模块体创建，vue 已加载）经 registerReader 注册，工厂内 read() 转发。
// 响应式 Map 让 set() 触发 watch 源（panelSessionId + messages.length）重算（普通 Map + 普通数组
// 无响应式依赖，watch 永不触发）。
const chatMock = vi.hoisted(() => {
  let readFn: ((sid: string) => unknown[]) | null = null
  return {
    registerReader(fn: (sid: string) => unknown[]): void {
      readFn = fn
    },
    read(sid: string): unknown[] {
      return readFn ? readFn(sid) : []
    },
  }
})
// 模块级响应式消息表（测试侧 set/clear 的入口；vue 已加载，可安全用 reactive）
const reactiveMessages = reactive(new Map<string, unknown[]>())
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    getMessages: (sid: string) => chatMock.read(sid),
  }),
}))
// 注册 reader：工厂首次执行（PanelContainer 动态 import）时 read() 已能转发到响应式 Map
chatMock.registerReader((sid) => reactiveMessages.get(sid) ?? [])

// ── mock useSessionEvents：捕获 onMessage 注册的 handler（emitTo 模式，对齐旧 SideDrawer.test）──
// 真实 useSessionEvents：subscribe(sid) 闭包捕获订阅时 sid，分发时把它传给 handler（第二参数）。
// 本 mock 对齐此语义：注册时快照 sidRef.value，emitTo(sid) 只触发「快照 sid === sid」的 handler，
// 并把快照 sid 作为第二参数传给 handler（调用方 updateFor(sid) 写该 sid 分区）。
const mockState = vi.hoisted(() => ({
  registrations: [] as Array<{ sidAtRegistration: string; type: string; handler: (msg: unknown, sid: string) => void }>,
}))
vi.mock('@/composables/features/useSessionEvents', () => ({
  useSessionEvents: (sidRef: { value: string | null }) => {
    return (type: string, handler: (msg: unknown, sid: string) => void) => {
      const sid = sidRef.value
      if (sid == null) return
      mockState.registrations.push({ sidAtRegistration: sid, type, handler })
    }
  },
}))

/** 向某 sid 的某 type 推送消息（只触发注册时快照 sid === sid 的 handler） */
function emitTo(sid: string, type: string, msg: ServerMessage): void {
  for (const entry of mockState.registrations) {
    if (entry.sidAtRegistration === sid && entry.type === type) {
      entry.handler(msg, entry.sidAtRegistration)
    }
  }
}

function mkWidgetMsg(widgetKey: string, lines: string[]): ServerMessage<'extension:widget'> {
  return {
    type: 'extension:widget' as const,
    payload: { widgetKey, lines },
  } as unknown as ServerMessage<'extension:widget'>
}

// ── 桌面独占面板 stub（DrawerPanel 默认 slot 注入的内容；真实组件依赖重，stub 为占位）──
const DesktopStub = (name: string, testid: string) =>
  defineComponent({
    name,
    template: `<div data-testid="${testid}" />`,
  })

// Panel stub：占位，避免 Panel 内部的 chat/session 依赖
const PanelStub = defineComponent({
  name: 'Panel',
  props: { panelId: String, sessionId: { type: String, default: null } },
  template: '<div data-testid="panel" :data-panel-id="panelId" />',
})

async function mountContainer() {
  // 动态 import 让 vi.mock 先生效
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer, {
    global: {
      stubs: {
        Panel: PanelStub,
        GitPanel: DesktopStub('GitPanel', 'git-panel'),
        CommandDocPanel: DesktopStub('CommandDocPanel', 'doc-panel'),
        DetailPane: DesktopStub('DetailPane', 'detail-panel'),
        BrowserPane: DesktopStub('BrowserPane', 'browser-pane'),
        TerminalView: DesktopStub('TerminalView', 'terminal-panel'),
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  // 直连 core 控制态：绑定分区键（panel store focusedSessionId）+ 清模块级状态（测试隔离）
  bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  _resetDrawerForTest()
  mockState.registrations.length = 0
  reactiveMessages.clear()
})

// [HISTORICAL] 用例间 wrapper 必须自动 unmount：PanelContainer 未卸载时其内部 watch（unread
// watch 源含 panelSessionId → leaf → panel.currentLeaf）在下个用例 reset 的 version bump 时
// 排队重算，求值旧 pinia store 的 getter 触发 pinia 内部 setActivePinia(旧 pinia)，污染全局
// activePinia，导致下个用例 usePanelStore() 解析到旧 pinia、读到旧 sid、drawer 打不开。
enableAutoUnmount(afterEach)

describe('PanelContainer 单 panel + Drawer 壳路径（AC9/AC12 冒烟载体）', () => {
  it('drawerOpen=true：DOM 含 drawer-panel + drawer-tab-* 五 tab + drawer-content（W4 换新入口）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-smoke')
    openDrawerTab('git') // 打开 drawer（git tab）

    const wrapper = await mountContainer()
    await nextTick()

    // DrawerPanel 渲染（@xyz-agent/ui/features/drawer）
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
    // 五基础 tab 按钮（AC9/AC12：drawer-tab-* DOM 断言）
    for (const key of ['terminal', 'browser', 'git', 'doc', 'detail']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
    expect(wrapper.find('[data-testid="drawer-content"]').exists()).toBe(true)
    // git tab 内容面板经 slot 注入（C2 v-if chain）
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
  }, 60_000)

  it('drawerOpen=false：无 drawer-panel，退化为单 panel（v-if 卸载）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-closed')

    const wrapper = await mountContainer()
    await nextTick()

    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="panel"]')).toHaveLength(1)
  }, 60_000)
})

describe('PanelContainer 壳行为迁移（旧 side-drawer.test.ts 行为断言壳路径版）', () => {
  it('ESC 键 → drawer 关闭（壳层 window keydown，旧 SideDrawer onKeyDown 迁移）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-esc')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)

    // ESC keydown → PanelContainer closeDrawer → drawer 卸载
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
    // close 后 keydown 监听已卸（drawer 关闭态不再抢全局 keydown）
    expect(wrapper.find('[data-testid="panel"]').exists()).toBe(true)
  }, 60_000)

  it('close 按钮点击 → drawer 关闭（DrawerPanel emit close → 壳 closeDrawer）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-close-btn')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)

    await wrapper.find('[data-testid="drawer-close"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
  }, 60_000)
})

describe('PanelContainer widget 缓冲壳路径渲染（旧 SideDrawer.test.ts AC-4 壳路径版）', () => {
  it('extension:widget 推送 → DrawerPanel 经 props 渲染缓冲行（browser tab 无 url 走内置 widget 区）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-widget')
    openDrawerTab('browser') // browser tab；无 browserUrl → 不注入 BrowserPane → widget 区 fallback

    const wrapper = await mountContainer()
    await nextTick()

    // C2 contract：browser 无 url 时不注入 BrowserPane，DrawerPanel 内置 widget 区 fallback
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(false)

    // emit widget 消息 → 壳 handler → core createDrawerBuffers.updateFor(sid) → props → 渲染
    emitTo('s-widget', 'extension:widget', mkWidgetMsg('browser', ['line-1', 'line-2']))
    await nextTick()

    const codeEls = wrapper.findAll('code')
    expect(codeEls.length).toBe(2)
    expect(codeEls[0].text()).toBe('line-1')
  }, 60_000)

  it('无 widget 数据时 DrawerPanel 空态 fallback（drawer-widget-empty）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-empty')
    openDrawerTab('browser')

    const wrapper = await mountContainer()
    await nextTick()

    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(true)
  }, 60_000)
})

describe('PanelContainer unread badge 壳侧补回（AC-13，旧 SideDrawer 逻辑迁移）', () => {
  it('drawer 打开期间 chatStore 消息数增长 → header-extra slot 内 badge 出现并显示计数', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-badge')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    // 初始无消息 → 无 badge
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(false)

    // 消息数增长（模拟 agent 新消息到达）→ unreadCount 累加 → badge 出现
    reactiveMessages.set('s-badge', [1, 2])
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').text()).toContain('2')
  }, 60_000)

  it('关 drawer（回对话流）→ unreadCount 清零，badge 消失', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's-badge-close')
    openDrawerTab('git')

    const wrapper = await mountContainer()
    await nextTick()
    reactiveMessages.set('s-badge-close', [1, 2])
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(true)

    // 关 drawer → 清零 → badge 消失
    await wrapper.find('[data-testid="drawer-close"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(false)
  }, 60_000)
})
