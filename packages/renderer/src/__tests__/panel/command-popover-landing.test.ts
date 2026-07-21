/**
 * CommandPopover landing 态 slash 命令源 单测（L1-L7）。
 *
 * 验证按 variant 分支：landing 态（variant='landing'）合并 commandStore.getCommands(publicSessionId)
 * （pi extension 命令）∪ settingsStore.skills（config.skills 全局扫描），skill name 归一化为
 * /skill:<name>（pi agent-session.ts:1210 要求 /skill: 路由前缀）；session 态（variant='panel'）
 * 用 commandStore + compact，不并入 settingsStore.skills（配置态/运行态不混淆，ADR-0037）。
 * [HISTORICAL] 根因回归：原 mount 用 sessionId:undefined 模拟 landing，与现实（composerSid 非空，
 * 含 publicSessionId 兜底）脱节，测试全绿但 bug 照出。现 mount 用 variant:'landing' + 非空 sessionId。
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

  /** mount landing 态：variant='landing' + 非空 sessionId（模拟 publicSessionId）。
   *  反映真实运行——Landing.vue:70 composerSid = flow.currentSessionId ?? props.sessionId ??
   *  sessionStore.publicSessionId，publicSessionId 存在时（model 已配置的常态）非空。
   *  sessionId 传 undefined 会走不到根因场景（variant 分支替代 sessionId 分支后，
   *  landing 判定只看 variant，但保留非空 sessionId 确保回归断言有意义）。 */
  async function mountLanding(query = '', skills: SkillInfo[] = LANDING_SKILLS, sid = 'public-sid'): Promise<void> {
    useSettingsStore().skills = skills
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: sid, query },
    })
    await flushPromises()
    await nextTick()
  }

  it('L1 landing（variant=landing + 非空 sessionId）+ skills 7 条 → 渲染 7 项，首项含 code-review（显示去 /skill: 前缀）', async () => {
    // AC-5 根因回归点：非空 sessionId 下仍显示 settingsStore.skills（现状 bug 正是 sessionId 非空走错分支）
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

  it('L5 session 态（variant=panel + sessionId=s1）→ 用 commandStore（3 项 pi 命令）+ 前端注入 compact = 4 项，不被 skills(7) 污染', async () => {
    // AC-3：session 态不并入 settingsStore.skills（配置态/运行态不混淆，ADR-0037 D2）
    useSettingsStore().skills = LANDING_SKILLS
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'panel', sessionId: 's1', query: '' },
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

  it('L7 选中首项 → emit select {type:"slash", name:"/skill:code-review", icon:"star", description:"审查代码变更"}（AC-4：name 带 /skill: 路由前缀，pi 可路由）', async () => {
    // AC-4：landing 选中 skill 后 emit name 形如 /skill:<name>（pi agent-session.ts:1210 要求 /skill: 前缀）
    await mountLanding('')
    const btns = bodyItemButtons()
    await btns[0].click()
    const selectEvents = wrapper!.emitted('select')
    expect(selectEvents).toBeTruthy()
    const payload = selectEvents!.at(-1)![0] as { type: string; name: string; icon?: string; description?: string }
    expect(payload).toEqual({
      type: 'slash',
      name: '/skill:code-review',
      icon: 'star',
      description: '审查代码变更',
    })
  })

  // L9 [AC-2]：landing 合并源验证——同时显示 publicSession 的 pi extension 命令 + skills
  it('L9 landing（variant=landing + sessionId=public-sid + commandStore 有 public-sid 命令）→ 同时显示 pi extension 命令 + skills（合并源）', async () => {
    useSettingsStore().skills = LANDING_SKILLS
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '' },
    })
    await flushPromises()
    // 推 publicSession 的 pi extension 命令（3 条）
    const msg = {
      type: 'session.commands',
      payload: { sessionId: 'public-sid', commands: SESSION_CMDS },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('public-sid', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // 3 pi extension 命令 + 7 skills = 10 项（landing 合并源，无 compact）
    expect(btns).toHaveLength(10)
    // pi extension 命令在列（/commit 来自 SESSION_CMDS）
    expect(btns.some((b) => b.textContent?.includes('commit'))).toBe(true)
    // skills 在列（code-review 来自 LANDING_SKILLS）
    expect(btns.some((b) => b.textContent?.includes('code-review'))).toBe(true)
    // landing 不含 compact（无上下文可压缩）
    expect(btns.some((b) => b.textContent?.includes('compact'))).toBe(false)
  })

  // L10 [R2 fix]：pi 源 skill 命令与 settingsStore skill 同名 → 去重（pi 源优先），不重复显示
  // 真实场景：publicSession 的 pi 扫描全局 skill（如 code-review），settingsStore 也扫到同一个
  // （<piAgentDir>/skills + 全局重叠）。去重后只显一项。pi 源优先（运行态真源）。
  it('L10 landing pi 源 skill 与 settingsStore skill 同名 → 去重（1 项非 2 项，pi 源优先）', async () => {
    // pi 返回的 skill 命令：name='skill:code-review'（pi 真实格式，归一化后 /skill:code-review）
    const piCmdsWithSkill = [
      { name: 'skill:code-review', description: 'pi 扫描的 code-review', source: 'skill' },
      { name: '/goal', description: '目标管理', source: 'extension' },
    ]
    // settingsStore 也有 code-review（同名重叠）+ diagnose（独有，settingsStore 补项目级）
    const skills = [
      LANDING_SKILLS[0], // code-review（与 pi 源重叠，去重）
      LANDING_SKILLS[1], // diagnose（settingsStore 独有）
    ]
    useSettingsStore().skills = skills
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '' },
    })
    await flushPromises()
    const msg = {
      type: 'session.commands',
      payload: { sessionId: 'public-sid', commands: piCmdsWithSkill },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('public-sid', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // pi 源 2 项（skill:code-review + /goal）+ settingsStore 独有 1 项（diagnose）= 3 项
    // code-review 不重复（pi 源优先，settingsStore 的被去重掉）
    expect(btns).toHaveLength(3)
    // code-review 只出现一次（去重验证）
    const codeReviewCount = btns.filter((b) => b.textContent?.includes('code-review')).length
    expect(codeReviewCount).toBe(1)
    // diagnose 在列（settingsStore 独有项保留）
    expect(btns.some((b) => b.textContent?.includes('diagnose'))).toBe(true)
  })

  // L11 [R3 fix]：landing + sessionId=undefined（publicSession 创建失败/model 未配置）→ 仅显 skills 不崩溃
  it('L11 landing + sessionId=undefined → 仅显 skills（不加载 pi 命令，不崩溃）', async () => {
    // publicSession 不可用时 landing composerSid 可能为 undefined（Landing.vue:70 三元 fallback 全 null）
    useSettingsStore().skills = LANDING_SKILLS
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: undefined, query: '' },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // 无 pi 命令源，只显 7 条 skills（extCmds 为空，全部 skills 都是「独有」不过滤）
    expect(btns).toHaveLength(7)
    expect(btns.some((b) => b.textContent?.includes('code-review'))).toBe(true)
    // 无 compact（landing 态）
    expect(btns.some((b) => b.textContent?.includes('compact'))).toBe(false)
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

  // ── W3（cw-2026-07-21-scan-project-agents-skills）：landing 三源合并（projectSkills）──
  // landing 分支合并三源：commandStore(publicSession pi extension) ∪ settingsStore.skills(全局)
  // ∪ projectSkills(当前 cwd 项目 skill，useProjectSkills 按 cwd key 缓存)。按归一化 name 去重。
  it('L12 landing + projectSkills prop → 三源合并（publicSession 命令 + 全局 skills + 项目 skills）', async () => {
    // 全局 skill（settingsStore.skills）2 条
    const globalSkills: SkillInfo[] = [
      { id: 'sk-global-1', name: 'global-skill-1', description: 'g1', enabled: true, source: 'pi', effective: true },
      { id: 'sk-global-2', name: 'global-skill-2', description: 'g2', enabled: true, source: 'pi', effective: true },
    ]
    useSettingsStore().skills = globalSkills
    // 项目 skill（projectSkills prop）2 条
    const projectSkills: SkillInfo[] = [
      { id: 'sk-proj-1', name: 'proj-skill-1', description: 'p1', enabled: true, source: 'agents', effective: true },
      { id: 'sk-proj-2', name: 'proj-skill-2', description: 'p2', enabled: true, source: 'agents', effective: true },
    ]
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '', projectSkills },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // 2 全局 + 2 项目 = 4 项（无 publicSession pi 命令推送，extCmds 空）
    expect(btns).toHaveLength(4)
    expect(btns.some((b) => b.textContent?.includes('global-skill-1'))).toBe(true)
    expect(btns.some((b) => b.textContent?.includes('proj-skill-1'))).toBe(true)
  })

  it('L13 landing 三源去重——全局 skill 与项目 skill 同名 → 去重 1 项（全局优先）', async () => {
    // 全局和项目都有同名 skill（模拟全局 ~/.agents/skills 与项目 .agents/skills 重叠场景）
    const overlap = { id: 'sk-overlap', name: 'overlap-skill', description: 'overlap', enabled: true, source: 'agents', effective: true }
    useSettingsStore().skills = [overlap, { id: 'sk-g', name: 'global-only', description: 'g', enabled: true, source: 'pi', effective: true }]
    const projectSkills: SkillInfo[] = [overlap, { id: 'sk-p', name: 'proj-only', description: 'p', enabled: true, source: 'agents', effective: true }]

    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '', projectSkills },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // overlap-skill 去重 1 项 + global-only 1 项 + proj-only 1 项 = 3 项（非 4 项）
    expect(btns).toHaveLength(3)
    const overlapCount = btns.filter((b) => b.textContent?.includes('overlap-skill')).length
    expect(overlapCount).toBe(1)
  })

  it('L14 landing projectSkills 默认空（未传 prop）→ 仅全局 skill，行为与修复前一致', async () => {
    useSettingsStore().skills = LANDING_SKILLS
    // 不传 projectSkills（默认空）
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '' },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // 仅 7 条全局 skill（projectSkills 空）
    expect(btns).toHaveLength(7)
  })
})
