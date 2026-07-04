/**
 * CommandDocPanel 单测（drawer Doc tab 内容）。
 *
 * 覆盖：
 * - skill 命令 join SkillInfo 命中 → 渲染完整 SKILL.md（content）+ 元信息
 * - extension 命令（非 skill）→ 退化信息卡（description + source 标签）
 * - 未选择命令 → 空态
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/command-doc-panel.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CommandDocPanel from '@/components/panel/CommandDocPanel.vue'
import { useCommandStore } from '@/stores/command'
import { useSettingsStore } from '@/stores/settings'
import { useSideDrawer, resetSideDrawer } from '@/composables/features/useSideDrawer'
import type { SkillInfo } from '@xyz-agent/shared'

// MarkdownRenderer 异步加载 shiki，单测内 stub 成同步渲染 content（断言文档正文到达即可）
vi.mock('@/components/panel/message-stream/MarkdownRenderer.vue', () => ({
  default: defineComponent({
    name: 'MarkdownRenderer',
    props: { content: { type: String, default: '' } },
    template: '<div class="md-stub">{{ content }}</div>',
  }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  resetSideDrawer()
})

const SKILLS: SkillInfo[] = [
  {
    id: 'sk-fix',
    name: 'fix',
    description: '修复 bug 的 skill',
    enabled: true,
    source: 'agents',
    triggers: ['fix', '修复'],
    sourcePath: '~/.agents/skills/fix/SKILL.md',
    content: '# Fix Skill\n\n用于修复问题。',
    effective: true,
  },
]

/** 预置 commandStore + settings，返回 drawer 控制器 */
async function setup(sessionId: string): Promise<void> {
  const commandStore = useCommandStore()
  commandStore.applyCommands(sessionId, [
    { name: '/fix', description: '修复问题', source: 'skill' },
    { name: '/commit', description: '提交改动', source: 'extension' },
    { name: '/compact', source: 'builtin' },
  ])
  const settings = useSettingsStore()
  settings.skills = SKILLS as typeof settings.skills
}

describe('CommandDocPanel', () => {
  it('skill 命令 join 命中 → 渲染完整 SKILL.md（content）+ source 标签「Skill」', async () => {
    await setup('s1')
    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/fix' })

    const wrapper = mount(CommandDocPanel, { props: { sessionId: 's1' } })
    await flushPromises()

    // header 含命令名 + Skill 标签
    expect(wrapper.text()).toContain('/fix')
    expect(wrapper.text()).toContain('Skill')
    // skill 完整文档正文
    expect(wrapper.text()).toContain('用于修复问题')
    // sourcePath 元信息
    expect(wrapper.text()).toContain('~/.agents/skills/fix/SKILL.md')
  })

  it('extension 命令（非 skill）→ 退化信息卡（description + 无完整文档提示）', async () => {
    await setup('s1')
    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/commit' })

    const wrapper = mount(CommandDocPanel, { props: { sessionId: 's1' } })
    await flushPromises()

    expect(wrapper.text()).toContain('/commit')
    expect(wrapper.text()).toContain('Extension')
    expect(wrapper.text()).toContain('提交改动')
    expect(wrapper.text()).toContain('无完整文档')
  })

  it('builtin 命令无 description → 显示「无详细描述」占位', async () => {
    await setup('s1')
    const drawer = useSideDrawer()
    drawer.open('doc', { commandName: '/compact' })

    const wrapper = mount(CommandDocPanel, { props: { sessionId: 's1' } })
    await flushPromises()

    expect(wrapper.text()).toContain('/compact')
    expect(wrapper.text()).toContain('内置')
    expect(wrapper.text()).toContain('无详细描述')
  })

  it('未选择命令 → 空态（点击 chip 提示）', async () => {
    await setup('s1')
    // 不调 open（selectedCommandName 仍为 null）

    const wrapper = mount(CommandDocPanel, { props: { sessionId: 's1' } })
    await flushPromises()

    expect(wrapper.text()).toContain('未选择命令')
  })
})
