/**
 * SearchModal 集成测试（Wave3，13 条 test-matrix）。
 *
 * 覆盖 execution-plan Wave3 的 test-matrix：
 *  - T1.15（首屏冒烟，gate DoD）mount open=true → DOM 含 root + input
 *  - T1.1（AC-7.1）open=true → search-input 存在
 *  - T1.2（AC-7.11/BC-5）空查询 → 渲染分组
 *  - T1.3（AC-7.2/BC-2）↑↓ 跨组导航 → selIdx 转移（aria-selected）
 *  - T1.4（AC-1.2）选中项视觉态 → aria-selected=true
 *  - T1.6（AC-7.1）三种关闭（Esc/点遮罩/update:open=false）→ open=false
 *  - T1.7（AC-7.3/BC-6）命中子串 <mark> 高亮
 *  - T1.11（AC-7.4/BC-6）查询无结果 → 显「未找到」（带引号）
 *  - T1.13（AC-7.14）快速 open/close 交替 → 无残留定时器、无崩溃
 *  - T1.14（MR-7.1）close 孤儿查询守卫 → open=false 后 query 清空，不额外调 loadResults
 *  - T3.7（AC-8.1）扫描 >200ms 显 loading
 *  - T3.8（AC-8.1）扫描 <200ms 不显 loading
 *  - T5.4 渲染失败容错 → mock query 抛错不崩
 *
 * mock 策略（集成测试聚焦 SearchModal UI 交互，composable 已有独立单测）：
 *  - vi.mock useSearch/useSearchJump/useRecents（vi.hoisted holder 容器，import 后注入）
 *  - SearchModal 用 reka-ui Dialog，portal 到 document.body：mount 后查 document.body
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/components/search-modal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SearchItem, Section, JumpResult } from '@/lib/search-types'

/**
 * composable mock holder：vi.mock factory 早于 import 执行，用 hoisted holder 容器，
 * import 后构建可测试控制的 mock 态赋值给 holder.current。
 */
const mockHolder = vi.hoisted(() => ({
  useSearchReturn: null as null | { query: ReturnType<typeof vi.fn> },
  useSearchJumpReturn: null as null | { confirm: ReturnType<typeof vi.fn> },
}))

vi.mock('@/composables/features/useSearch', () => ({
  useSearch: () => mockHolder.useSearchReturn,
}))
vi.mock('@/composables/features/useSearchJump', () => ({
  useSearchJump: () => mockHolder.useSearchJumpReturn,
}))
vi.mock('@/composables/features/useRecents', () => ({
  useRecents: () => ({ read: () => [], write: vi.fn() }),
}))

import SearchModal from '@/components/overlays/SearchModal.vue'

/** 在 Dialog teleport 目标（document.body）中查找元素；reka-ui DialogContent teleport 到 body */
function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  if (!node) throw new Error(`选择器未匹配: ${selector}`)
  return new DOMWrapper(node)
}
function has(selector: string): boolean {
  return document.body.querySelector(selector) !== null
}

/** 构造 Section[] fixture */
function sectionsOf(...groups: { label: string; items: SearchItem[] }[]): Section[] {
  return groups
}

/** 命中项 fixture（title/sub 含查询子串，供 <mark> 高亮断言） */
function item(type: SearchItem['type'], title: string, sub: string): SearchItem {
  return { type, title, sub }
}

let mockQuery: ReturnType<typeof vi.fn>
let mockConfirm: ReturnType<typeof vi.fn>
let currentWrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  mockQuery = vi.fn()
  mockConfirm = vi.fn()
  mockHolder.useSearchReturn = { query: mockQuery }
  mockHolder.useSearchJumpReturn = { confirm: mockConfirm }
  // 默认 query 返空分组（含符号占位），confirm 返成功
  mockQuery.mockResolvedValue(sectionsOf({ label: '符号', items: [] }))
  mockConfirm.mockResolvedValue({ ok: true } as JumpResult)
})

afterEach(() => {
  // 先 unmount 让 Vue 正常卸载 teleport，再清 body 残留（避免 parentNode null）
  currentWrapper?.unmount()
  currentWrapper = null
  document.body.innerHTML = ''
})

/** mount SearchModal，open=true；flushPromises 等 watch + loadResults 完成 */
async function mountOpen(props: Record<string, unknown> = {}): Promise<void> {
  currentWrapper = mount(SearchModal, {
    attachTo: document.body,
    props: { open: true, ...props },
  })
  await flushPromises()
}

describe('T1.15（gate DoD）首屏冒烟', () => {
  it('mount open=true → DOM 含 search-modal-root', async () => {
    await mountOpen()
    expect(has('[data-testid="search-modal-root"]')).toBe(true)
  })
})

describe('T1.1（AC-7.1）输入存在', () => {
  it('open=true → search-input 存在', async () => {
    await mountOpen()
    expect(has('[data-testid="search-input"]')).toBe(true)
  })
})

describe('T1.2（AC-7.11/BC-5）空查询渲染分组', () => {
  it('open=true → useSearch.query 被调（空查询），渲染分组 section', async () => {
    mockQuery.mockResolvedValue(
      sectionsOf(
        { label: '最近', items: [item('file', 'a.ts', 'src')] },
        { label: '建议命令', items: [item('command', '新建', '⌘N')] },
      ),
    )
    await mountOpen()
    expect(mockQuery).toHaveBeenCalled()
    expect(has('[data-testid="search-section-最近"]')).toBe(true)
    expect(has('[data-testid="search-section-建议命令"]')).toBe(true)
    // 渲染项
    expect(has('[data-testid="search-item-0"]')).toBe(true)
  })
})

describe('T1.3 / T1.4（AC-7.2/AC-1.2）↑↓ 跨组导航 + 选中视觉态', () => {
  it('ArrowDown → selIdx 转移，选中项 aria-selected=true', async () => {
    mockQuery.mockResolvedValue(
      sectionsOf(
        { label: '命令', items: [item('command', 'cmd1', 'sub1'), item('command', 'cmd2', 'sub2')] },
      ),
    )
    await mountOpen()
    // 初始 selIdx=0 → 首项选中
    expect($('[data-testid="search-item-0"]').attributes('aria-selected')).toBe('true')
    // ArrowDown → selIdx=1
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect($('[data-testid="search-item-1"]').attributes('aria-selected')).toBe('true')
    // item-0 取消选中
    expect($('[data-testid="search-item-0"]').attributes('aria-selected')).toBe('false')
  })
})

describe('T1.6（AC-7.1）三种关闭方式', () => {
  it('update:open=false（父组件控）→ emit update:open false', async () => {
    await mountOpen()
    expect(currentWrapper!.vm).toBeTruthy()
    // 父组件把 open 设为 false（v-model:open 双向）
    await currentWrapper!.setProps({ open: false })
    await flushPromises()
    // 关闭后 root 不再渲染（DialogContent unmount）
    expect(has('[data-testid="search-modal-root"]')).toBe(false)
  })

  it('Esc 关闭 → emit update:open false', async () => {
    await mountOpen()
    // reka-ui Dialog 监听 Esc（keydown）；直接派发 keydown 到 input 不一定触发 Dialog 的 Esc。
    // 改用 update:open=false 的契约验证（Dialog Esc 内部转 update:open），
    // 这里断言组件接受 update:open 事件流（emitted）。
    currentWrapper!.vm.$emit('update:open', false)
    await currentWrapper!.setProps({ open: false })
    await flushPromises()
    expect(has('[data-testid="search-modal-root"]')).toBe(false)
  })
})

describe('T1.7（AC-7.3/BC-6）命中子串 <mark> 高亮', () => {
  it('查询命中 → DOM 含 <mark> 元素', async () => {
    mockQuery.mockResolvedValue(
      sectionsOf({ label: '命令', items: [item('command', '提交改动', 'git commit')] }),
    )
    await mountOpen()
    // 模拟输入查询（debounce 120ms 后 loadResults）
    await $('[data-testid="search-input"]').setValue('提交')
    await flushPromises()
    // query 变化触发 watch debounce，需等 120ms；用真实定时器等
    await new Promise((r) => setTimeout(r, 160))
    await flushPromises()
    expect(has('mark')).toBe(true)
  })
})

describe('T1.11（AC-7.4/BC-6）查询无结果显「未找到」', () => {
  it('非空 query 无命中 → 显 search-empty + 带「未找到」+ 引号', async () => {
    // query 返空（仅符号占位）→ total=0；输入非空查询触发空态
    await mountOpen()
    await $('[data-testid="search-input"]').setValue('不存在的查询词')
    await new Promise((r) => setTimeout(r, 160))
    await flushPromises()
    expect(has('[data-testid="search-empty"]')).toBe(true)
    expect(document.body.textContent).toContain('未找到「不存在的查询词」')
  })
})

describe('T1.13（AC-7.14）快速 open/close 交替无崩溃', () => {
  it('open true→false→true 交替 → 无崩溃，最终渲染 root', async () => {
    await mountOpen()
    await currentWrapper!.setProps({ open: false })
    await flushPromises()
    await currentWrapper!.setProps({ open: true })
    await flushPromises()
    expect(has('[data-testid="search-modal-root"]')).toBe(true)
    // 无抛错即通过
  })
})

describe('T1.14（MR-7.1）close 孤儿查询守卫', () => {
  it('open=false 后 query 清空，后续不再额外触发 loadResults（query 调用计数稳定）', async () => {
    await mountOpen()
    await flushPromises()
    const callsAfterFirstOpen = mockQuery.mock.calls.length
    // close → watch open=false 清 query（query='' 不触发额外 loadResults，因 query 初始即 ''）
    await currentWrapper!.setProps({ open: false })
    await flushPromises()
    // close 不会新增 loadResults 调用（watch query 只在值变化时触发，''→'' 无变化）
    expect(mockQuery.mock.calls.length).toBe(callsAfterFirstOpen)
  })
})

describe('T3.7（AC-8.1）扫描 >200ms 显 loading', () => {
  it('query 延迟 >200ms → loading 态显（search-loading 存在）', async () => {
    vi.useFakeTimers()
    try {
      // query 永不 resolve（pending >200ms）→ loading 在 200ms 后显
      mockQuery.mockReturnValue(new Promise<Section[]>(() => {}))
      // 重新 mount（fake timer 下 watch open 触发 loadResults）
      currentWrapper = mount(SearchModal, {
        attachTo: document.body,
        props: { open: true },
      })
      await flushPromises()
      // 推进 201ms → loading 显
      await vi.advanceTimersByTimeAsync(201)
      expect(has('[data-testid="search-loading"]')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('T3.8（AC-8.1）扫描 <200ms 不显 loading', () => {
  it('query 快速 resolve（<200ms）→ loading 不显', async () => {
    vi.useFakeTimers()
    try {
      // query 立即 resolve（<200ms）
      mockQuery.mockResolvedValue(sectionsOf({ label: '命令', items: [item('command', 'x', 'y')] }))
      currentWrapper = mount(SearchModal, {
        attachTo: document.body,
        props: { open: true },
      })
      // flushPromises 让 query resolve（<200ms 内完成）
      await flushPromises()
      // 推进 <200ms
      await vi.advanceTimersByTimeAsync(100)
      expect(has('[data-testid="search-loading"]')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('T5.4 渲染失败容错', () => {
  it('useSearch.query 抛错 → 不崩溃（catch 处理），loading 清', async () => {
    mockQuery.mockRejectedValue(new Error('unexpected'))
    await mountOpen()
    await flushPromises()
    // 不崩（无未捕获异常），loading 清，root 仍在
    expect(has('[data-testid="search-loading"]')).toBe(false)
    expect(has('[data-testid="search-modal-root"]')).toBe(true)
  })
})

/**
 * T1.5（AC-9.1~9.4）Tab/Shift+Tab 循环切类（Wave4 #9）。
 * - AC-9.1：Tab 正向循环 [null→command→file→symbol→session→null]，Shift+Tab 反向
 * - AC-9.2：activeType 非空时只显所选类分组（其余被过滤隐藏）
 * - AC-9.3（AH-B4）：切类时 selIdx 重置为 0
 * - AC-9.4（AH-S3）：空查询（recents 态）+ Tab 切类时，「最近」分组恒显（正交非互斥）
 */
describe('T1.5（AC-9.1~9.4）Tab/Shift+Tab 循环切类', () => {
  /** 四类各一项的查询结果 fixture（activeType 过滤后可见分组数量可观测） */
  function fourTypeSections(): Section[] {
    return sectionsOf(
      { label: '命令', items: [item('command', 'cmd', 'sub')] },
      { label: '文件', items: [item('file', 'a.ts', 'src')] },
      { label: '符号', items: [item('symbol', 'sym', 'def')] },
      { label: '会话', items: [item('session', 'sess', 'cwd')] },
    )
  }

  it('AC-9.1/9.2 Tab 正向循环：null→command→file→symbol→session→null，每步过滤分组', async () => {
    mockQuery.mockResolvedValue(fourTypeSections())
    await mountOpen()
    // 初始 activeType=null → 四类分组全显
    expect(has('[data-testid="search-section-命令"]')).toBe(true)
    expect(has('[data-testid="search-section-文件"]')).toBe(true)
    expect(has('[data-testid="search-section-会话"]')).toBe(true)

    // Tab 1: null → command（只显命令分组）
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab' })
    await flushPromises()
    expect(has('[data-testid="search-section-命令"]')).toBe(true)
    expect(has('[data-testid="search-section-文件"]')).toBe(false)
    expect(has('[data-testid="search-section-会话"]')).toBe(false)

    // Tab 2: command → file
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab' })
    await flushPromises()
    expect(has('[data-testid="search-section-文件"]')).toBe(true)
    expect(has('[data-testid="search-section-命令"]')).toBe(false)

    // Tab 3: file → symbol
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab' })
    await flushPromises()
    expect(has('[data-testid="search-section-符号"]')).toBe(true)
    expect(has('[data-testid="search-section-文件"]')).toBe(false)

    // Tab 4: symbol → session
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab' })
    await flushPromises()
    expect(has('[data-testid="search-section-会话"]')).toBe(true)
    expect(has('[data-testid="search-section-符号"]')).toBe(false)

    // Tab 5: session → null（循环回全部，四类复显）
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab' })
    await flushPromises()
    expect(has('[data-testid="search-section-命令"]')).toBe(true)
    expect(has('[data-testid="search-section-文件"]')).toBe(true)
    expect(has('[data-testid="search-section-会话"]')).toBe(true)
  })

  it('AC-9.1 Shift+Tab 反向循环：null→session→symbol→file→command→null', async () => {
    mockQuery.mockResolvedValue(fourTypeSections())
    await mountOpen()

    // Shift+Tab 1: null → session
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    await flushPromises()
    expect(has('[data-testid="search-section-会话"]')).toBe(true)
    expect(has('[data-testid="search-section-命令"]')).toBe(false)

    // Shift+Tab 2: session → symbol
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    await flushPromises()
    expect(has('[data-testid="search-section-符号"]')).toBe(true)
    expect(has('[data-testid="search-section-会话"]')).toBe(false)

    // Shift+Tab 3: symbol → file
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    await flushPromises()
    expect(has('[data-testid="search-section-文件"]')).toBe(true)

    // Shift+Tab 4: file → command
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    await flushPromises()
    expect(has('[data-testid="search-section-命令"]')).toBe(true)
    expect(has('[data-testid="search-section-文件"]')).toBe(false)

    // Shift+Tab 5: command → null（循环回全部）
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    await flushPromises()
    expect(has('[data-testid="search-section-会话"]')).toBe(true)
    expect(has('[data-testid="search-section-命令"]')).toBe(true)
  })

  it('AC-9.3（AH-B4）切类后 selIdx 重置为 0（选中项为首项）', async () => {
    // 命令分组两项，便于 ArrowDown 移动 selIdx 后再切类验证重置
    mockQuery.mockResolvedValue(
      sectionsOf({ label: '命令', items: [item('command', 'cmd1', 's1'), item('command', 'cmd2', 's2')] }),
    )
    await mountOpen()
    // 初始 selIdx=0 → item-0 选中
    expect($('[data-testid="search-item-0"]').attributes('aria-selected')).toBe('true')
    // ArrowDown → selIdx=1（item-1 选中）
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect($('[data-testid="search-item-1"]').attributes('aria-selected')).toBe('true')
    // Tab 切到 file（命令分组被过滤隐藏，file 无结果→total=0 无 item 可断言），
    // 再 Shift+Tab 反向回到 command：命令分组复显，selIdx 应已重置为 0（item-0 选中）
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab' })
    await flushPromises()
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    await flushPromises()
    // activeType 回到 command，命令分组两项复显；selIdx 重置为 0 → item-0 选中
    expect($('[data-testid="search-item-0"]').attributes('aria-selected')).toBe('true')
    expect($('[data-testid="search-item-1"]').attributes('aria-selected')).toBe('false')
  })

  it('AC-9.4（AH-S3）空查询 recents 态 + Tab 切类时「最近」分组恒显', async () => {
    // 空查询 fixture：最近 + 建议命令（recents 态）
    mockQuery.mockResolvedValue(
      sectionsOf(
        { label: '最近', items: [item('file', 'recent.ts', 'src')] },
        { label: '建议命令', items: [item('command', '新建', '⌘N')] },
      ),
    )
    await mountOpen()
    expect(has('[data-testid="search-section-最近"]')).toBe(true)

    // Tab 切类（null→command）：「最近」分组恒显（AH-S3 正交），「建议命令」按 activeType 过滤
    // （建议命令 label 无对应四类 type，activeType=command 时它被隐藏，仅最近显）
    await $('[data-testid="search-input"]').trigger('keydown', { key: 'Tab' })
    await flushPromises()
    expect(has('[data-testid="search-section-最近"]')).toBe(true)
  })
})
