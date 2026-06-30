/**
 * DirSelectPopover 组件单测（#5，T3.2 + 列表选择 + 搜索过滤）。
 *
 * 覆盖：
 * - T3.2 recentWorkspaces=[] → 渲染空态文案（spec §6）
 * - 列表项点击 → emit('select', { cwd })
 * - 搜索输入 → 即时过滤命中
 * - 「打开文件夹」动作项 → emit('open-dir-dialog')
 *
 * mock 策略：真 pinia + useSessionStore().setGroups 填充 list（与 use-new-task-flow.test.ts 同模式），
 * recentWorkspaces 真跑（纯函数）。组件动作为 emit（presentational for actions）。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/dir-select-popover.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'
import DirSelectPopover from '@/components/new-task/DirSelectPopover.vue'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
})

function mkSession(cwd: string, label: string, lastActiveAt = 100): SessionSummary {
  return {
    id: cwd,
    label,
    cwd,
    status: 'idle',
    lastActiveAt,
    modelId: 'm',
    tokenCount: 0,
  }
}

/** 填充 session store（按 cwd 归组，与 store.appendSession 语义一致） */
function setSessions(sessions: SessionSummary[]): void {
  const byCwd = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const arr = byCwd.get(s.cwd) ?? []
    arr.push(s)
    byCwd.set(s.cwd, arr)
  }
  useSessionStore().setGroups(
    Array.from(byCwd, ([cwd, ss]): SessionGroup => ({ cwd, sessions: ss })),
  )
}

describe('DirSelectPopover 空态（T3.2）', () => {
  it('recentWorkspaces=[] → 渲染空态文案，无列表项', () => {
    // store 默认 groups=[] → list=[] → recentWorkspaces=[]
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(wrapper.text()).toContain('暂无最近工作区')
    expect(wrapper.findAll('[data-testid="workspace-item"]')).toHaveLength(0)
  })

  it('空态仍渲染「打开文件夹」入口（Primary 入口，spec §6 三要素）', () => {
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(wrapper.find('[data-testid="action-open-dir"]').exists()).toBe(true)
  })
})

describe('DirSelectPopover 列表选择', () => {
  it('有 workspaces → 渲染列表，当前 cwd 命中 Card-Active', () => {
    setSessions([mkSession('/repo-a', 'repo-a', 200), mkSession('/repo-b', 'repo-b', 100)])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: '/repo-a' } })
    const items = wrapper.findAll('[data-testid="workspace-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].attributes('data-active')).toBe('true')
    expect(items[1].attributes('data-active')).toBe('false')
  })

  it('点击列表项 → emit select 单 payload 对象 { cwd }', async () => {
    setSessions([mkSession('/repo-a', 'repo-a', 200), mkSession('/repo-b', 'repo-b', 100)])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: '/repo-a' } })
    await wrapper.findAll('[data-testid="workspace-item"]')[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([[{ cwd: '/repo-b' }]])
  })

  it('点击「打开文件夹」→ emit open-dir-dialog', async () => {
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    await wrapper.find('[data-testid="action-open-dir"]').trigger('click')
    expect(wrapper.emitted('open-dir-dialog')).toBeTruthy()
  })
})

describe('DirSelectPopover 搜索过滤', () => {
  it('输入关键词 → 列表即时过滤命中（按 cwd 匹配，basename 是其子串）', async () => {
    setSessions([mkSession('/work/alpha', 'alpha'), mkSession('/work/beta', 'beta')])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    await wrapper.find('input').setValue('alpha')
    const items = wrapper.findAll('[data-testid="workspace-item"]')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('alpha')
  })

  it('搜索无命中 → 空态文案（无崩溃）', async () => {
    setSessions([mkSession('/work/alpha', 'alpha')])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    await wrapper.find('input').setValue('zzz-no-match')
    expect(wrapper.findAll('[data-testid="workspace-item"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('暂无最近工作区')
  })
})

/**
 * [回归] 列表项主标题渲染目录名（cwd basename），不渗入 session 名。
 * 事故：session 被 rename 后 session.label 变自定义文本，旧逻辑把它当目录名展示。
 * 本块做渲染 gate：mount 组件断言 DOM 文案，防止 recentWorkspaces 改回取 s.label。
 */
describe('DirSelectPopover 列表项显示目录名（非 session 名）[回归]', () => {
  it('session 被 rename 后，列表项 DOM 含目录名、不含 session 自定义名', () => {
    // label='我的自定义会话名' 模拟 rename 后的 session 名；cwd basename 是 'bar'
    setSessions([mkSession('/foo/bar', '我的自定义会话名', 100)])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    const item = wrapper.find('[data-testid="workspace-item"]')
    expect(item.exists()).toBe(true)
    expect(item.text()).toContain('bar') // 目录名
    expect(item.text()).not.toContain('我的自定义会话名') // session 名不应渗入
  })
})
