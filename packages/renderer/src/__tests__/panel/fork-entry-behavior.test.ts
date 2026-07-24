/**
 * W2 入口 + 行为层红灯测试（TDD：实现缺失，测试必须 fail）。
 *
 * 覆盖 U7-U11：
 * - U7  首屏冒烟：streaming/pending 态每条 assistant 有 fork 后台 + fork 提问按钮
 * - U8  forkSession 不再调 panel.split + selectSession（后台 fork 不切焦点）
 * - U9  forkSessionAsk send 失败自动回滚（sessionApi.remove + removeFromList）
 * - U10 ForkNotice 反馈行 transient 渲染 + 查看降级（sessionDeleted 时纯文本不可点）
 * - U11 ForkConfirmModal 已删除（文件不存在 + Turn.vue 无 import）
 *
 * 红灯预期：W2 未实现，下列用例应全 fail（import 失败 / 门控未放宽 / 函数未新增 / 组件未删除）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/fork-entry-behavior.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'
import { useToast } from '@/composables/useToast'

// useChat mock（Turn 编辑路径依赖；forkSessionAsk 复用其 ensureStreamSubscription/disposeSession）。
// disposeSession 用模块级 spy，让 U9 W7 断言可断言「回滚时被调」（拆流式订阅 + 清 store per-session 状态）。
// ensureStreamSubscription 导出作 no-op stub：U9 测回滚编排，不验真实流式订阅。
const disposeSessionMock = vi.fn()
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn(), disposeSession: disposeSessionMock, setHistoryTruncated: vi.fn() }),
  ensureStreamSubscription: vi.fn(),
}))
vi.mock('@/composables/features/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

// 延迟到 mock 声明之后 import 被测组件。
// 注意：不 mock useSidebar —— U8/U9 需要测真实 forkSession/forkSessionAsk 行为。
// Turn 仅在 setup 时取 forkSession 引用（不立即调用），真实 useSidebar 在 pinia 下可工作。
import Turn from '@/components/panel/message-stream/Turn.vue'
import { useChatStore } from '@/stores/chat'

/** 构造 assistant message（content 是 string，status 可控） */
function makeAssistant(over: Partial<Message> = {}): Message {
  return {
    id: over.id ?? 'a1',
    role: 'assistant',
    content: over.content ?? 'AI 回复内容',
    status: over.status ?? 'complete',
    timestamp: over.timestamp ?? Date.now(),
    ...over,
  } as Message
}

function makeTurn(assistants: Message[]): MessageTurn {
  return {
    index: 1,
    user: {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '问题' }],
      status: 'complete',
      timestamp: Date.now(),
    },
    assistants,
    isStreaming: false,
    hasFoldable: false,
  }
}

/**
 * mount Turn —— 复用外部 setActivePinia 的 pinia 实例（streaming 态需先在 store 写入状态）。
 * 不新建 pinia：组件内 chat.isActive(sessionId) 必须读到 beforeEach 设置的同一 store。
 */
function mountTurn(turn: MessageTurn, sessionId = 's1') {
  return mount(Turn, {
    props: { turn, sessionId },
    global: {
      stubs: {
        Block: true,
        ChangeSetCard: true,
        MarkdownRenderer: true,
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  // 模块级 mock（disposeSessionMock）需跨用例清调用记录，避免 U9 断言被先前用例污染。
  vi.clearAllMocks()
  // useToast 是模块级单例，跨用例共享 → 清空残留 toast（U9-fail 断言 toasts 内容）。
  const { toasts } = useToast()
  toasts.value = []
})

// ── U7：首屏冒烟 —— streaming/pending 态每条 assistant 有 fork 按钮 ────────
describe('U7 首屏冒烟：streaming 态每条 assistant 有 fork 后台 + fork 提问按钮', () => {
  it('streaming 态（isSessionActive=true）下 fork 按钮可见（当前门控 !isSessionActive 应放宽）', () => {
    const chat = useChatStore()
    const sid = 's-stream'
    // 制造 streaming → isActive=true → isSessionActive=true
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(chat.isActive(sid)).toBe(true)

    const turn = makeTurn([makeAssistant({ id: 'a1', status: 'streaming' })])
    const wrapper = mountTurn(turn, sid)
    // 当前实现 v-if="!isSessionActive" 在 streaming 时隐藏 fork 按钮（title=克隆并分叉到另一面板）
    // W2 放宽门控后 streaming 态也应有 fork 按钮
    const forkBtns = wrapper.findAll('button').filter((b) =>
      b.attributes('title')?.includes('分叉') || b.attributes('title')?.includes('fork'),
    )
    expect(forkBtns.length).toBeGreaterThan(0)
  })

  it('多条 assistant 消息时，summary action 行有 fork 后台 + fork 提问按钮（与复制同行）', () => {
    const turn = makeTurn([
      makeAssistant({ id: 'a1', content: '第一条回复' }),
      makeAssistant({ id: 'a2', content: '第二条回复' }),
    ])
    const wrapper = mountTurn(turn, 's-idle')
    // fork 按钮在 summary action 行（与复制/复制MD 同行），末条 assistant 位 1 组
    const forkBackgroundBtns = wrapper.findAll('[data-testid="fork-background-btn"]')
    expect(forkBackgroundBtns.length).toBe(1)
    const forkAskBtns = wrapper.findAll('[data-testid="fork-ask-btn"]')
    expect(forkAskBtns.length).toBe(1)
    // fork 按钮与复制按钮在同一容器（action 行）
    const actionRow = forkBackgroundBtns[0]?.element.parentElement
    expect(actionRow?.querySelector('[data-testid="fork-ask-btn"]')).toBeTruthy()
    // 同行还应有复制按钮（Copy icon button）
    expect(actionRow?.querySelectorAll('button').length).toBeGreaterThanOrEqual(4)
  })
})

// ── U8：forkSession 不调 panel.split + selectSession ──────────────────────
describe('U8：forkSession 后台 fork 不切焦点（不调 panel.split + selectSession）', () => {
  it('fork 后台后焦点留在原 session（不切换面板）', async () => {
    // 直接对真实 useSidebar 行为做断言：forkSession 内部不应再调 panel.split。
    const { useSidebar } = await import('@/composables/features/useSidebar')
    const sidebar = useSidebar()

    const panelStore = (await import('@/stores/panel')).usePanelStore()
    const sessionStore = (await import('@/stores/session')).useSessionStore()
    const sessionApi = (await import('@/api')).session

    // 准备一条可被 fork 的消息
    const chatStore = useChatStore()
    const sid = 's-fork-src'
    chatStore.hydrate(sid, [makeAssistant({ id: 'm1', piEntryId: 'e1' })])

    // mock fork RPC 返回新 session；先 append 进 sessionStore 让 selectSession 不炸
    const forked = { id: 'new-fork', label: 'fork', cwd: '/tmp' } as never
    vi.spyOn(sessionApi, 'fork').mockResolvedValue(forked)
    // 预注册新 session 到 store（appendSession 入组），并 mock switchSession 避免命中 mock runtime
    sessionStore.appendSession(forked)
    vi.spyOn(sessionApi, 'switchSession' as never).mockResolvedValue(undefined as never)
    vi.spyOn(sessionApi, 'getCommands' as never).mockResolvedValue({ commands: [] } as never)
    vi.spyOn(sessionApi, 'getContext' as never).mockResolvedValue({} as never)

    const splitSpy = vi.spyOn(panelStore, 'split')
    const beforeActive = sessionStore.activeId

    await sidebar.forkSession(sid, 'm1', { includeFrom: true, openInStandby: true })

    // 红灯：当前实现 openInStandby 会 panel.split()（useSidebar.ts:466）→ splitSpy 被调
    expect(splitSpy).not.toHaveBeenCalled()
    // activeId 不应变（不切焦点）
    expect(sessionStore.activeId).toBe(beforeActive)
  })
})

// ── U9：forkSessionAsk send 失败自动回滚 ─────────────────────────────────
describe('U9：forkSessionAsk send 失败自动回滚（disposeSession + sessionApi.remove + removeFromList）', () => {
  it('fork 提问发送失败后不留空白分支（回滚清理）', async () => {
    const { useSidebar } = await import('@/composables/features/useSidebar')
    const sidebar = useSidebar()

    const sessionApi = (await import('@/api')).session
    const sessionStore = (await import('@/stores/session')).useSessionStore()
    const removeSpy = vi.spyOn(sessionApi, 'remove').mockResolvedValue(undefined as never)
    const removeFromListSpy = vi.spyOn(sessionStore, 'removeFromList')

    // fork 成功（创建占位 session），但随后 send reject
    vi.spyOn(sessionApi, 'fork').mockResolvedValue({
      id: 'fork-placeholder',
      label: 'fork',
      cwd: '/tmp',
    } as never)
    const chatApi = (await import('@/api')).chat
    vi.spyOn(chatApi, 'send' as never).mockRejectedValue(new Error('send failed') as never)

    // [W1] forkSessionAsk 现在 rethrow 而非吞错 resolve（错误反馈职责上移到调用方）。
    // 资源清理（disposeSession + remove + removeFromList）仍在 catch 内 rethrow 前执行。
    await expect(sidebar.forkSessionAsk('s-src', 'm1', '追问内容')).rejects.toThrow('send failed')

    // 回滚三件套均被调（W7 补 disposeSession 断言：拆流式订阅 + 清 chat store per-session 状态）
    expect(disposeSessionMock).toHaveBeenCalledWith('fork-placeholder')
    expect(removeSpy).toHaveBeenCalledWith('fork-placeholder')
    expect(removeFromListSpy).toHaveBeenCalledWith('fork-placeholder')
  })
})

// ── U10：ForkNotice 反馈行 transient 渲染 + 查看降级 ─────────────────────
describe('U10：ForkNotice 反馈行（transient，非 banner）+ 查看降级', () => {
  // ForkNotice.vue 是 W2 新建组件，当前不存在 → import 失败（红灯）。
  // 用动态拼接的 specifier 让 Vite 不在构建期静态解析（否则整个文件 collection 失败），
  // 只让 U10 两个用例在运行期 import 时单独抛错失败。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noticePath = ('@/components' + '/panel/ForkNotice.vue') as any

  it('ForkNotice 渲染为反馈行（fork-notice class），含查看链接', async () => {
    const ForkNotice = (await import(noticePath)).default
    const wrapper = mount(ForkNotice, {
      props: { sessionDeleted: false },
      global: { plugins: [createPinia()] },
    })
    // 反馈行 class（区别于 banner）
    expect(wrapper.find('.fork-notice').exists()).toBe(true)
    expect(wrapper.find('.banner').exists()).toBe(false)
    // 含查看链接（可点击，session 未删）
    const viewLink = wrapper.find('[data-testid="fork-notice-view"]')
    expect(viewLink.exists()).toBe(true)
    expect(viewLink.attributes('disabled')).toBeFalsy()
  })

  it('sessionDeleted=true 时查看降级为纯文本不可点', async () => {
    const ForkNotice = (await import(noticePath)).default
    const wrapper = mount(ForkNotice, {
      props: { sessionDeleted: true },
      global: { plugins: [createPinia()] },
    })
    const viewLink = wrapper.find('[data-testid="fork-notice-view"]')
    // session 已删 → 查看降级为纯文本，不可点（无 role=button / disabled 或非 <a>/<button>）
    expect(viewLink.exists()).toBe(true)
    // 降级态：不应是可交互元素（无 role=button，或 aria-disabled）
    const interactive =
      viewLink.attributes('role') === 'button' ||
      viewLink.element.tagName === 'A' ||
      viewLink.element.tagName === 'BUTTON'
    expect(interactive).toBe(false)
  })
})

// ── U11：ForkConfirmModal 已删除 ─────────────────────────────────────────
describe('U11：ForkConfirmModal 已删除（文件不存在 + Turn.vue 无 import）', () => {
  it('ForkConfirmModal.vue 文件已不存在', () => {
    const modalPath = path.resolve(
      __dirname,
      '../../components/panel/message-stream/ForkConfirmModal.vue',
    )
    // 红灯：当前文件存在 → existsSync 返回 true → 断言 false 失败
    expect(fs.existsSync(modalPath)).toBe(false)
  })

  it('Turn.vue 源码不再 import ForkConfirmModal', () => {
    const turnPath = path.resolve(
      __dirname,
      '../../components/panel/message-stream/Turn.vue',
    )
    const source = fs.readFileSync(turnPath, 'utf-8')
    // 红灯：当前 Turn.vue:298 `import ForkConfirmModal from './ForkConfirmModal.vue'`
    expect(source).not.toContain('ForkConfirmModal')
  })
})

// ── 盲区 2（renderer）：fork 失败反馈（W2 修复验证） ──────────────────────
// sessionApi.fork reject → Turn.onFork 被 catch → toastError 被调（W2 加 try/catch + toastError）。
// 回归防护：若 W2 回退（onFork 无 catch），reject 变 unhandled rejection，toast 不弹，此用例 fail。
describe('盲区 2：fork 后台 RPC 失败 → toast 错误反馈（W2 onFork try/catch）', () => {
  it('点 fork 后台按钮 → sessionApi.fork reject → toast 弹出 fork 失败文案', async () => {
    const sessionApi = (await import('@/api')).session
    // fork RPC reject（runtime 侧源文件不存在 / fork 点找不到 等场景透传到此）
    vi.spyOn(sessionApi, 'fork').mockRejectedValue(new Error('source not found') as never)

    const turn = makeTurn([makeAssistant({ id: 'a1', piEntryId: 'pi-a1' })])
    const wrapper = mountTurn(turn, 's-fork-fail')

    // 点 fork 后台按钮（触发 onFork → forkSession → sessionApi.fork reject）
    await wrapper.find('[data-testid="fork-background-btn"]').trigger('click')
    // onFork 是 async（await forkSession），需 flush 微任务让 catch 跑完 + toast 入列
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // toast 弹出：含 fork 失败语义文案（i18n key panel.message.forkFailed = 「fork 后台失败：…」）
    const { toasts } = useToast()
    expect(toasts.value.length).toBeGreaterThan(0)
    const lastToast = toasts.value[toasts.value.length - 1]
    expect(lastToast.type).toBe('error')
    expect(lastToast.message).toContain('fork')
  })
})
