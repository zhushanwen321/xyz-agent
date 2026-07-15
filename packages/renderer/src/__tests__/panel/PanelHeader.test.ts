/**
 * PanelHeader 组件单测：session JSONL 文件名展示与复制。
 *
 * 覆盖：
 * - header 展示短文件名（session id 前 8 位 + .jsonl）
 * - 点击文件名复制磁盘真实绝对路径
 * - sessionFile 为空（pi 延迟写入窗口）时不渲染
 * - i18n 契约
 *
 * 三视角（AGENTS.md 测试规范 #5-8）：
 * - 构建者：props.sessionFile 驱动渲染
 * - 使用者：点击 → clipboard.writeText 被调用
 * - 观察者：DOM 含 testid + 短文件名文本
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

describe('PanelHeader session 文件名展示', () => {
  it('U1: 有 sessionFile 时展示短文件名 019f4698.jsonl', () => {
    const wrapper = mountHeader()
    const el = wrapper.find('[data-testid="panel-session-file"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('019f4698.jsonl')
  })

  it('U2: 无 sessionFile 时不渲染文件名元素', () => {
    const wrapper = mountHeader({ sessionFile: undefined })
    expect(wrapper.find('[data-testid="panel-session-file"]').exists()).toBe(false)
  })

  it('U3: 点击文件名复制磁盘真实绝对路径', async () => {
    const wrapper = mountHeader()
    const el = wrapper.find('[data-testid="panel-session-file"]')
    await el.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SESSION_FILE_PATH)
  })

  it('U4: 点击后显示 ✓ 反馈图标（copied 态）', async () => {
    const wrapper = mountHeader()
    await wrapper.find('[data-testid="panel-session-file"]').trigger('click')
    // copied === 'file' 时渲染 Check 图标（lucide Check 组件 render 为 svg）
    const svgs = wrapper.find('[data-testid="panel-session-file"]').findAll('svg')
    expect(svgs.length).toBeGreaterThanOrEqual(1)
  })

  it('U5: viewingSubagent 态不渲染文件名', () => {
    const wrapper = mountHeader({ viewingSubagent: true, subagentLabel: 'sub' })
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
