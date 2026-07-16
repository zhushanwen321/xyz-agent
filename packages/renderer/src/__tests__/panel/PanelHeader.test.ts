/**
 * PanelHeader 组件单测：session JSONL 文件名展示与复制。
 *
 * 覆盖：
 * - 正常态：右侧按钮组内展示短文件名（前 8 位 + .jsonl），点击复制绝对路径
 * - overlay 态（subagent/agent call）：用 overlaySessionFile 渲染，也复制对应路径
 * - sessionFile/overlaySessionFile 均为空时不渲染
 * - i18n 契约
 *
 * 三视角（AGENTS.md 测试规范 #5-8）：
 * - 构建者：props 驱动 displayFile computed
 * - 使用者：点击 → clipboard.writeText 被调用
 * - 观察者：DOM 含 testid + 短文件名文本 + 位置在右侧按钮组
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/PanelHeader.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PanelHeader from '@/components/panel/PanelHeader.vue'
import type { DerivedStatus } from '@/types'

const SESSION_FILE_PATH =
  '/Users/u/.xyz-agent/pi/agent/sessions/cwd-hash/2026-07-09T11-16-46-632Z_019f4698-2fa8-791c-858f-d02ba39d9676.jsonl'
const OVERLAY_FILE_PATH =
  '/Users/u/.xyz-agent/pi/agent/subagents/cwd-hash/sessions/2026-07-13T05-41-22-097Z_019f59fe-aaaa-bbbb.jsonl'

function mountHeader(overrides: Record<string, unknown> = {}) {
  return mount(PanelHeader, {
    props: {
      sessionLabel: 'test',
      sessionDir: '/repo',
      status: 'done' as DerivedStatus,
      active: true,
      isDual: false,
      isFirstPanel: false,
      sessionFile: SESSION_FILE_PATH,
      ...overrides,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  })
})

describe('PanelHeader session 文件名展示（正常态）', () => {
  it('U1: 有 sessionFile 时展示短文件名 019f4698.jsonl', () => {
    const wrapper = mountHeader()
    const el = wrapper.find('[data-testid="panel-session-file"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('019f4698.jsonl')
  })

  it('U2: 无 sessionFile 且无 overlaySessionFile 时不渲染', () => {
    const wrapper = mountHeader({ sessionFile: undefined })
    expect(wrapper.find('[data-testid="panel-session-file"]').exists()).toBe(false)
  })

  it('U3: 点击文件名复制主 session 绝对路径', async () => {
    const wrapper = mountHeader()
    await wrapper.find('[data-testid="panel-session-file"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SESSION_FILE_PATH)
  })

  it('U4: 文件名按钮在右侧按钮组内（drawer 按钮之前）', () => {
    const wrapper = mountHeader()
    const fileBtn = wrapper.find('[data-testid="panel-session-file"]')
    const drawerBtn = wrapper.find('[data-testid="drawer-toggle"]')
    expect(fileBtn.exists()).toBe(true)
    // 两个按钮在同一个右侧容器内（父元素含 ml-auto）
    const rightGroup = wrapper.find('.ml-auto')
    expect(rightGroup.exists()).toBe(true)
    expect(rightGroup.element.contains(fileBtn.element)).toBe(true)
    // 文件名按钮在 drawer 按钮之前（DOM 顺序）
    expect(fileBtn.element.compareDocumentPosition(drawerBtn.element as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })
})

describe('PanelHeader overlay 态文件名展示', () => {
  it('U5: overlay 态用 overlaySessionFile 渲染短文件名', () => {
    const wrapper = mountHeader({
      viewingSubagent: true,
      subagentLabel: 'sub',
      sessionFile: undefined,
      overlaySessionFile: OVERLAY_FILE_PATH,
    })
    const el = wrapper.find('[data-testid="panel-session-file"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('019f59fe.jsonl')
  })

  it('U6: overlay 态点击复制 overlay 文件路径', async () => {
    const wrapper = mountHeader({
      viewingSubagent: true,
      subagentLabel: 'sub',
      sessionFile: undefined,
      overlaySessionFile: OVERLAY_FILE_PATH,
    })
    await wrapper.find('[data-testid="panel-session-file"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(OVERLAY_FILE_PATH)
  })

  it('U7: overlay 态无 overlaySessionFile 时不渲染', () => {
    const wrapper = mountHeader({
      viewingSubagent: true,
      subagentLabel: 'sub',
      sessionFile: SESSION_FILE_PATH,
      overlaySessionFile: undefined,
    })
    // overlay 态优先 overlaySessionFile，为空则不渲染（不 fallback 到主 sessionFile）
    expect(wrapper.find('[data-testid="panel-session-file"]').exists()).toBe(false)
  })
})

describe('PanelHeader i18n 契约', () => {
  it('E1: 中英文 locale 均包含 copySessionFile 文案', async () => {
    const { default: zh } = await import('@/i18n/locales/zh-CN/panel')
    const { default: en } = await import('@/i18n/locales/en-US/panel')
    expect(zh.header.copySessionFile).toBe('复制 session 文件路径')
    expect(en.header.copySessionFile).toBe('Copy session file path')
  })
})
