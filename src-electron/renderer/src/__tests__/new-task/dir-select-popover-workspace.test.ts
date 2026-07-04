/**
 * DirSelectPopover 改接 workspaceStore 后的行为测试 —— W3。
 *
 * 覆盖：
 * - T4.1: 首屏渲染 popover 展示 workspaceStore.records（DOM 断言）
 * - T4.2: 空态 DOM（「暂无最近工作区」文案）
 * - T4.3: 搜索过滤
 * - T4.4: 选中失效 cwd → toast + homedir fallback（D-008）
 * - T4.5: 删派生函数 grep 零残留 + 无悬空 import
 *
 * mock 策略：mock workspaceStore 直接控制 records 数据。
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/dir-select-popover-workspace.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'

// mock workspaceStore（vi.mock 自动 hoist）
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(),
}))

import DirSelectPopover from '@/components/new-task/DirSelectPopover.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const mockUseWorkspaceStore = vi.mocked(useWorkspaceStore)

function mkRecord(cwd: string, lastUsedAt: number): RecentWorkspaceRecord {
  return { cwd, lastUsedAt, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}

function setupWorkspaceStore(records: RecentWorkspaceRecord[]) {
  mockUseWorkspaceStore.mockReturnValue({
    records,
    defaultCwd: records[0]?.cwd,
    load: vi.fn(),
  } as ReturnType<typeof useWorkspaceStore>)
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockUseWorkspaceStore.mockReset()
})

describe('T4.1: 首屏渲染 popover 展示 workspaceStore.records', () => {
  it('有 records → 渲染列表项，DOM 含目录名和路径', () => {
    setupWorkspaceStore([
      mkRecord('/repo-a', 300),
      mkRecord('/repo-b', 200),
    ])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    const items = wrapper.findAll('[data-testid="workspace-item"]')
    expect(items).toHaveLength(2)
    // 第一项含目录名和路径
    expect(items[0].text()).toContain('repo-a')
    expect(items[0].text()).toContain('/repo-a')
  })
})

describe('T4.2: 空态 DOM', () => {
  it('records=[] → 渲染「暂无最近工作区」文案 + 「打开文件夹」入口', () => {
    setupWorkspaceStore([])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    expect(wrapper.text()).toContain('暂无最近工作区')
    expect(wrapper.find('[data-testid="action-open-dir"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="workspace-item"]')).toHaveLength(0)
  })
})

describe('T4.3: 搜索过滤', () => {
  it('输入关键词 → 列表即时过滤命中', async () => {
    setupWorkspaceStore([
      mkRecord('/foo-bar', 200),
      mkRecord('/baz-qux', 100),
    ])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    await wrapper.find('input').setValue('foo')
    const items = wrapper.findAll('[data-testid="workspace-item"]')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('/foo-bar')
  })
})

describe('T4.4: select 事件 payload 格式（DirSelectPopover 只 emit {cwd}，降级逻辑在 runtime create + useNewTaskFlow INV-7 测试覆盖）', () => {
  it('select emit 单 payload 对象 { cwd }', async () => {
    setupWorkspaceStore([
      mkRecord('/repo-a', 300),
      mkRecord('/repo-b', 200),
    ])
    const wrapper = mount(DirSelectPopover, { props: { currentCwd: null } })
    await wrapper.findAll('[data-testid="workspace-item"]')[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([[{ cwd: '/repo-b' }]])
  })
})

describe('T4.5: 删派生函数后零残留', () => {
  // vitest 的 cwd 是 src-electron/renderer（vitest.config.ts 所在目录）
  const srcDir = 'src/'

  it('DirSelectPopover 不再 import recentWorkspaces 或旧 RecentWorkspace 类型', () => {
    const fs = require('node:fs')
    const src = fs.readFileSync(srcDir + 'components/new-task/DirSelectPopover.vue', 'utf-8')
    expect(src).not.toContain("from '@/lib/utils'")
    expect(src).not.toContain('recentWorkspaces')
    // 检查旧类型 RecentWorkspace（非 RecentWorkspaceRecord）是否被误用
    expect(src).not.toMatch(/import.*RecentWorkspace[^R]/)
    expect(src).not.toMatch(/:\s*RecentWorkspace[^R]/)
  })

  it('useNewTaskFlow 不再 import resolveDefaultCwd', () => {
    const fs = require('node:fs')
    const src = fs.readFileSync(srcDir + 'composables/features/useNewTaskFlow.ts', 'utf-8')
    expect(src).not.toContain('resolveDefaultCwd')
  })

  it('lib/utils.ts 不再导出 recentWorkspaces / resolveDefaultCwd / RecentWorkspace / MAX_RECENT_WORKSPACES', () => {
    const fs = require('node:fs')
    const src = fs.readFileSync(srcDir + 'lib/utils.ts', 'utf-8')
    expect(src).not.toContain('export function resolveDefaultCwd')
    expect(src).not.toContain('export function recentWorkspaces')
    expect(src).not.toContain('export interface RecentWorkspace')
    expect(src).not.toContain('MAX_RECENT_WORKSPACES')
    // 保留的函数
    expect(src).toContain('export function cn')
    expect(src).toContain('export function deriveSessionLabel')
  })
})
