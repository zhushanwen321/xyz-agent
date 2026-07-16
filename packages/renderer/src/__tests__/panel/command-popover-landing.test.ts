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
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/command-popover-landing.test.ts
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

// session 源 fixture：对照 command-store.test.ts RAW（3 条 pi 动态命令，name 带 /）。
// compact 不在此列——pi get_commands 不返回 builtin（仅服务 pi TUI autocomplete），
// 由 CommandPopover slashCommands computed 在前端注入。此处若再加 compact 会与前端注入重复。
const SESSION_CMDS = [
  { name: '/commit', description: '提交改动', source: 'extension' },
  { name: '/review', description: '代码审查', source: 'extension' },
  { name: '/fix', description: '修复问题', source: 'skill' },
]

/** reka-ui PopoverContent teleport 到 body：在 body 内找命令项按钮（v-for Button 渲染为 native <button>）。
 *  按 item 列表容器（.max-h-[180px]）定位——不依赖 button 文本含 /（skill 项显示去掉了 / 前缀）。 */
function bodyItemButtons(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  return Array.from((list ?? document.body).querySelectorAll('button'))
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

  it('L1 landing 无 session + skills 7 条 → 渲染 7 项，首项含 code-review（显示去 /skill: 前缀）', async () => {
    await mountLanding('')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(7)
    // 显示层：skill 只显名字（icon 已表示类型），不含 /skill: 或 / 前缀
    expect(btns[0].textContent).toContain('code-review')
  })

  it('L2 query="co" → 仅 code-review（1 项）', async () => {
    await mountLanding('co')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toContain('code-review')
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

  it('L5 session 态（sessionId=s1）→ 用 commandStore（3 项 pi 命令）+ 前端注入 compact = 4 项，不被 skills(7) 污染', async () => {
    useSettingsStore().skills = LANDING_SKILLS
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', sessionId: 's1', query: '' },
    })
    await flushPromises()
    // 推 session 源命令（3 条 pi 动态命令）
    const msg = {
      type: 'session.commands',
      payload: { sessionId: 's1', commands: SESSION_CMDS },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('s1', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    expect(btns).toHaveLength(4) // 3 pi 命令 + 1 前端注入 compact，非 7 条 skills
    expect(btns.some((b) => b.textContent?.includes('/compact'))).toBe(true) // 前端注入的 builtin，skills 里没有
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

  // L8:回归防护 — 浮层宽度严格对齐 composer-box（w=anchor-width），不溢出。
  // [HISTORICAL] 事故：原 min-w + max-w-[820px] 让浮层可扩展到 >composer 宽度（slash 命令
  // 提示词列撑宽），landing 720px composer 时浮层右边缘溢出 ~70px。改 w-[anchor-width] 固定。
  // happy-dom 无布局，仅断言 class 含 w-[var(--reka-popper-anchor-width)]（宽度对齐 SSOT）。
  // 真实布局验证靠 CDP 实测（width/left/right 三项 match）。
  it('L8 PopoverContent class 含 w-[anchor-width]（固定宽度对齐 composer-box，不溢出）', async () => {
    await mountLanding('')
    const content = document.body.querySelector('[data-side]')
    expect(content).toBeTruthy()
    // 关键：w-[var(--reka-popper-anchor-width)] 让浮层宽度=composer-box 宽度
    expect(content!.className).toContain('w-[var(--reka-popper-anchor-width)]')
    // 不应再含旧的 min-w（min-w 允许内容撑宽导致溢出）
    expect(content!.className).not.toContain('min-w-[var(--reka-popper-anchor-width)]')
    // max-w 兜底防视口溢出（非旧的 820px 固定值）
    expect(content!.className).toContain('max-w-[calc(100vw-16px)]')
  })
})
