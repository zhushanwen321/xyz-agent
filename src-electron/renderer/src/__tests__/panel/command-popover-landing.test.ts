/**
 * CommandPopover landing 态 slash 命令源 单测（L1-L7）。
 *
 * 验证双源切换：session 态用 commandStore（pi get_commands），landing 态（无 session）
 * fallback 到 settingsStore.skills（config.skills 全局扫描）。landing 命令归一化为
 * SessionCommand（补 / 前缀、icon='star'），与 runtime get_commands name 格式对齐。
 *
 * 覆盖三视角：
 * - 构建者（白盒）：items 来源（commandStore vs skills）、归一化字段
 * - 使用者（黑盒）：输入 / → 能看到并选中 skill 命令（L7 select）
 * - 观察者（形态）：命令项 DOM、svg 图标渲染、PopoverContent 显隐
 *
 * mock 策略：
 * - pinia 测试模式（beforeEach setActivePinia），useSettingsStore().skills 直接赋值注入
 * - session 源用 events.dispatchSession 推 session.commands（与 composer-slash-trigger 同模式）
 * - reka-ui PopoverContent teleport 到 body：body 内查 button/svg
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/command-popover-landing.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, SkillInfo } from '@xyz-agent/shared'
import * as events from '@/api/events'
import { useSettingsStore } from '@/stores/settings'
import CommandPopover from '@/components/panel/CommandPopover.vue'

// fixture：对照 api/mock/settings-data.ts fixtureSkills（7 条，name 不带 /）
const LANDING_SKILLS: SkillInfo[] = [
  { id: 'sk-code-review', name: 'code-review', description: '审查代码变更', enabled: true, source: 'agents', triggers: ['review'], effective: true },
  { id: 'sk-diagnose', name: 'diagnose', description: '诊断 bug 和性能问题', enabled: true, source: 'agents', triggers: ['diagnose'], effective: true },
  { id: 'sk-impeccable', name: 'impeccable', description: '前端界面设计与优化', enabled: true, source: 'claude', triggers: ['impeccable'], effective: true },
  { id: 'sk-fallow', name: 'fallow', description: '代码库健康分析', enabled: true, source: 'pi', triggers: ['fallow'], effective: true },
  { id: 'sk-tavily', name: 'tavily-web-search', description: '网络搜索', enabled: true, source: 'agents', triggers: ['搜索'], effective: true },
  { id: 'sk-batch-tracer', name: 'batch-tracer', description: '批量代码分析', enabled: true, source: 'agents', triggers: ['批量分析'], effective: true },
  { id: 'sk-pi-goal', name: 'pi-goal', description: '目标驱动的任务管理', enabled: true, source: 'piinstall', triggers: ['goal'], effective: true },
]

// session 源 fixture：对照 command-store.test.ts RAW（4 条，name 带 /）
const SESSION_CMDS = [
  { name: '/commit', description: '提交改动', source: 'extension' },
  { name: '/review', description: '代码审查', source: 'extension' },
  { name: '/fix', description: '修复问题', source: 'skill' },
  { name: '/compact', source: 'builtin' },
]

/** reka-ui PopoverContent teleport 到 body：在 body 内找命令项按钮（v-for Button 渲染为 native <button>，文本含 /） */
function bodyItemButtons(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('button')).filter((b) =>
    /\//.test(b.textContent ?? ''),
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('CommandPopover landing 态用 config.skills（L1-L7）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  async function mountLanding(query = '', skills: SkillInfo[] = LANDING_SKILLS): Promise<void> {
    useSettingsStore().skills = skills
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', sessionId: undefined, query },
    })
    await flushPromises()
    await nextTick()
  }

  it('L1 landing 无 session + skills 7 条 → 渲染 7 项，首项含 /code-review', async () => {
    await mountLanding('')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(7)
    expect(btns[0].textContent).toContain('/code-review')
  })

  it('L2 query="co" → 仅 /code-review（1 项）', async () => {
    await mountLanding('co')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toContain('/code-review')
  })

  it('L3 query="zzz" → 0 项，PopoverContent 不渲染（v-if items.length>0）', async () => {
    await mountLanding('zzz')
    expect(bodyItemButtons()).toHaveLength(0)
    expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  })

  it('L4 skills 空 → 0 项', async () => {
    await mountLanding('', [])
    expect(bodyItemButtons()).toHaveLength(0)
  })

  it('L5 session 态（sessionId=s1）→ 用 commandStore（4 项含 /compact），不被 skills(7) 污染', async () => {
    useSettingsStore().skills = LANDING_SKILLS
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', sessionId: 's1', query: '' },
    })
    await flushPromises()
    // 推 session 源命令（4 条）
    const msg = {
      type: 'session.commands',
      payload: { sessionId: 's1', commands: SESSION_CMDS },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('s1', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    expect(btns).toHaveLength(4) // 来自 commandStore，非 7 条 skills
    expect(btns.some((b) => b.textContent?.includes('/compact'))).toBe(true) // builtin，skills 里没有
  })

  it('L6 每个命令项含 svg（icon=star 渲染）', async () => {
    await mountLanding('')
    const btns = bodyItemButtons()
    for (const b of btns) {
      expect(b.querySelector('svg')).toBeTruthy()
    }
  })

  it('L7 选中首项 → emit select {type:"slash", name:"/code-review", icon:"star", description:"审查代码变更"}', async () => {
    await mountLanding('')
    const btns = bodyItemButtons()
    await btns[0].click()
    const selectEvents = wrapper!.emitted('select')
    expect(selectEvents).toBeTruthy()
    const payload = selectEvents!.at(-1)![0] as { type: string; name: string; icon?: string; description?: string }
    expect(payload).toEqual({
      type: 'slash',
      name: '/code-review',
      icon: 'star',
      description: '审查代码变更',
    })
  })
})
