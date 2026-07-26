/**
 * SourceImportSection 组件测试（W1 · cw-2026-07-26-migration-other-agents）。
 *
 * 覆盖：
 * - 首屏渲染：mount kind='skill'，mock detectSources 返回 4 源，断言候选数量
 * - 未安装源灰掉：installed=false 候选项 Checkbox disabled
 * - 勾选 + 导入：勾选 claude+codex，点导入，断言 emit('import') 带两路径
 * - 共享池去重：existingDirs 已含某源路径 → 标「已通过共享池生效」且默认不勾选
 * - kind='agent' 只显示 claude（候选项数量为 1）
 * - detectSources 失败降级：mock reject → 显示「检测失败」不崩溃
 *
 * mock 策略：
 *  - vi.mock('@/api')：config.detectSources 用 mockResolvedValue / mockRejectedValue 控制
 *  - i18n 经 vitest-i18n-setup.ts 全局 stub（t() 从 zh-CN 取值，断言中文文案）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/__tests__/SourceImportSection.spec.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { SourceDetectResult } from '@xyz-agent/shared'

// detectSources 的可变 mock 实现，每个 it 单独设置返回值。
const mockDetectSources = vi.fn<() => Promise<SourceDetectResult[]>>()

vi.mock('@/api', () => ({
  config: {
    detectSources: (...args: unknown[]) => mockDetectSources(...(args as [])),
  },
}))

import SourceImportSection from '@/components/settings/SourceImportSection.vue'

// ── fixture ──
const SKILL_FIXTURE: SourceDetectResult[] = [
  { source: 'claude', installed: true, dir: '/Users/u/.claude/skills', skillCount: 8 },
  { source: 'codex', installed: true, dir: '/Users/u/.codex/skills', skillCount: 3 },
  { source: 'pi', installed: false, dir: '/Users/u/.pi/skills' },
  { source: 'zcode', installed: true, dir: '/Users/u/.zcode/skills', skillCount: 5 },
]

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  mockDetectSources.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SourceImportSection', () => {
  it('首屏渲染：kind=skill 显示全部 4 源候选', async () => {
    mockDetectSources.mockResolvedValue(SKILL_FIXTURE)
    wrapper = mount(SourceImportSection, {
      props: { kind: 'skill', existingDirs: [] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="import-from-agents"]').exists()).toBe(true)
    const candidates = wrapper.findAll('[data-testid="import-candidate"]')
    expect(candidates).toHaveLength(4)
  })

  it('未安装源 Checkbox 被禁用（灰掉）', async () => {
    mockDetectSources.mockResolvedValue(SKILL_FIXTURE)
    wrapper = mount(SourceImportSection, {
      props: { kind: 'skill', existingDirs: [] },
    })
    await flushPromises()

    // pi 源 installed=false，找到它对应的候选（含「未安装」文案）
    const candidates = wrapper.findAll('[data-testid="import-candidate"]')
    const piCandidate = candidates.find((c) => c.text().includes('未安装'))
    expect(piCandidate).toBeTruthy()
    // 该候选项内 Checkbox（button[role=checkbox]）disabled
    const checkbox = piCandidate!.find('button[role="checkbox"]')
    expect(checkbox.exists()).toBe(true)
    expect(checkbox.attributes('disabled')).toBeDefined()
  })

  it('勾选 + 导入：选中 claude+codex，emit import 带两路径', async () => {
    mockDetectSources.mockResolvedValue(SKILL_FIXTURE)
    wrapper = mount(SourceImportSection, {
      props: { kind: 'skill', existingDirs: [] },
    })
    await flushPromises()

    const candidates = wrapper.findAll('[data-testid="import-candidate"]')
    const claudeCheckbox = candidates
      .find((c) => c.text().includes('/Users/u/.claude/skills'))!
      .find('button[role="checkbox"]')
    const codexCheckbox = candidates
      .find((c) => c.text().includes('/Users/u/.codex/skills'))!
      .find('button[role="checkbox"]')

    await claudeCheckbox.trigger('click')
    await codexCheckbox.trigger('click')
    await flushPromises()

    const importBtn = wrapper.find('[data-testid="import-selected-btn"]')
    expect(importBtn.exists()).toBe(true)
    expect(importBtn.attributes('disabled')).toBeUndefined()
    await importBtn.trigger('click')

    const emitted = wrapper.emitted('import')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual([
      '/Users/u/.claude/skills',
      '/Users/u/.codex/skills',
    ])
  })

  it('去重：existingDirs 已含某源路径 → 标「已通过共享池生效」且默认不勾选', async () => {
    // claude 路径已在 existingDirs 中 → 应标共享池生效
    mockDetectSources.mockResolvedValue(SKILL_FIXTURE)
    wrapper = mount(SourceImportSection, {
      props: { kind: 'skill', existingDirs: ['/Users/u/.claude/skills'] },
    })
    await flushPromises()

    const candidates = wrapper.findAll('[data-testid="import-candidate"]')
    const claudeCandidate = candidates.find((c) =>
      c.text().includes('/Users/u/.claude/skills'),
    )
    expect(claudeCandidate).toBeTruthy()
    expect(claudeCandidate!.text()).toContain('已通过共享池生效')

    // claude 的 Checkbox 应禁用（共享池已生效）
    const checkbox = claudeCandidate!.find('button[role="checkbox"]')
    expect(checkbox.attributes('disabled')).toBeDefined()
    expect(checkbox.attributes('data-state')).toBe('unchecked')
  })

  it("kind=agent 只显示 claude（候选项数量为 1）", async () => {
    const agentFixture: SourceDetectResult[] = [
      { source: 'claude', installed: true, dir: '/Users/u/.claude/agents', agentCount: 4 },
      // 即便 detectSources 返回其他源（理论上不会），agent 模式也应过滤掉
      { source: 'pi', installed: true, dir: '/Users/u/.pi/skills', skillCount: 2 },
    ]
    mockDetectSources.mockResolvedValue(agentFixture)
    wrapper = mount(SourceImportSection, {
      props: { kind: 'agent', existingDirs: [] },
    })
    await flushPromises()

    const candidates = wrapper.findAll('[data-testid="import-candidate"]')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].text()).toContain('/Users/u/.claude/agents')
    // agent 模式取 agentCount 文案
    expect(candidates[0].text()).toContain('4 个 agent')
  })

  it('detectSources 失败 → 显示「检测失败」不崩溃', async () => {
    mockDetectSources.mockRejectedValue(new Error('boom'))
    wrapper = mount(SourceImportSection, {
      props: { kind: 'skill', existingDirs: [] },
    })
    await flushPromises()

    const err = wrapper.find('[data-testid="detect-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('检测失败')
    // 无候选渲染（不崩溃）
    expect(wrapper.findAll('[data-testid="import-candidate"]')).toHaveLength(0)
  })
})
