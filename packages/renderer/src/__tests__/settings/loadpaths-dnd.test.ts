/**
 * LoadPaths 拖拽排序 watch 守卫竞态测试（W2）。
 *
 * bug 根因（见 LoadPaths.vue 顶部说明）：
 *  onDragEnd 先清 dragIndex=null 再 emit；广播回路把 props.dirs 改回时，
 *  watch 守卫 if(dragIndex!==null) return 失效（已清空）→ localDirs 被广播覆盖。
 *
 * 覆盖：
 *  - U2：拖拽 emit 后广播回来 enabled 顺序一致 → localDirs 顺序保持（不回弹）。
 *        并验证 awaitingBroadcast 标志在抑制后正确复位（不卡住）——
 *        紧接着第二次 setProps（顺序一致）仍按「广播回显」处理，再之后真实变更仍同步。
 *  - U2-stale：拖拽 emit 后广播回来一个「不同顺序」（网络乱序/外部并发变更）→ localDirs 同步广播值。
 *  - U3：非拖拽状态下外部 dirs 真实变更（新增路径）→ localDirs 同步。
 *
 * 测试策略：
 *  - forcedDirs=[] 使所有 font-mono span 都是可选目录，按 DOM 文本顺序断言顺序。
 *  - 拖拽用真实事件序列：findAll('[draggable="true"]') 拿到行，trigger
 *    dragstart→dragenter→drop→dragend。trigger(type, options) 把 dataTransfer 透传给
 *    合成事件（happy-dom 默认不挂 dataTransfer，onDragStart 守卫需要它）。
 *  - 捕获 emit 的 update-dirs，模拟「广播回显」：setProps({ dirs: <emit 的值> })。
 *  - 不能用 wrapper.vm 访问内部 ref（setup 未 expose），改用 DOM span 文本顺序断言。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/loadpaths-dnd.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { SkillDirConfig } from '@xyz-agent/shared'
import LoadPaths from '@/components/settings/LoadPaths.vue'

let wrapper: ReturnType<typeof mount> | null = null

/** 测试用目录：3 条全 enabled，forcedDirs=[] 让 DOM 只有可选目录的 span。 */
const DIRS: SkillDirConfig[] = [
  { path: '/path/a', enabled: true },
  { path: '/path/b', enabled: true },
  { path: '/path/c', enabled: true },
]

beforeEach(() => {
  wrapper = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

/**
 * 读取可选目录（font-mono span）的当前 DOM 文本顺序。
 * forcedDirs=[] 时所有 .font-mono span 都来自可选目录行。
 */
function optionalDirOrder(w: ReturnType<typeof mount>): string[] {
  return w.findAll('span.font-mono').map((s) => s.text().trim())
}

/**
 * 构造 trigger 选项对象，含 dataTransfer。
 * Vue Test Utils 的 .trigger(type, options) 会把 options 合并到事件上；
 * onDragStart/onDragOver 守卫读 e.dataTransfer，故必须把 DataTransfer 透传过去
 * （happy-dom 默认不挂 dataTransfer 到合成 drag 事件，否则 onDragStart 直接 return，
 *  dragIndex 永远是 null，拖拽完全不生效）。
 */
function dragOptions(): { dataTransfer: DataTransfer } {
  return { dataTransfer: new DataTransfer() }
}

describe('LoadPaths 拖拽排序 watch 守卫竞态（W2）', () => {
  it('U2: 拖拽 emit 后广播回来 enabled 顺序一致 → localDirs 顺序保持（不回弹）', async () => {
    wrapper = mount(LoadPaths, {
      props: { forcedDirs: [], dirs: DIRS, kind: 'skill' },
    })
    // 初始顺序 a,b,c
    expect(optionalDirOrder(wrapper)).toEqual(['/path/a', '/path/b', '/path/c'])

    const rows = wrapper.findAll('[draggable="true"]')
    expect(rows.length).toBe(3)

    // 把第 0 行（/path/a）拖到第 1 位
    await rows[0].trigger('dragstart', dragOptions())
    await rows[1].trigger('dragenter', dragOptions())
    await rows[1].trigger('dragover', dragOptions())
    await rows[1].trigger('drop', dragOptions())
    await rows[1].trigger('dragend', dragOptions())

    // 拖拽后 DOM 顺序应变成 b,a,c
    expect(optionalDirOrder(wrapper)).toEqual(['/path/b', '/path/a', '/path/c'])

    // 捕获 emit 的 update-dirs（应是 b,a,c 顺序）
    const updateEvents = wrapper.emitted('update-dirs')
    expect(updateEvents).toBeTruthy()
    const emittedDirs = (updateEvents![0] as [SkillDirConfig[]])[0]
    expect(emittedDirs.map((d) => d.path)).toEqual(['/path/b', '/path/a', '/path/c'])

    // 模拟广播回路：父组件把 emit 的值（顺序一致）作为新数组回灌。
    // awaitingBroadcast 守卫应识别「enabled 顺序一致」并跳过覆盖，localDirs 保持拖拽结果。
    await wrapper.setProps({ dirs: emittedDirs.map((d) => ({ ...d })) })
    expect(optionalDirOrder(wrapper)).toEqual(['/path/b', '/path/a', '/path/c'])
  })

  it('U2-reset: awaitingBroadcast 在抑制后必须复位——连续两次顺序一致的广播后，真实变更仍能同步', async () => {
    // 这条测试锁定「标志不卡住」属性：awaitingBroadcast 在第一次广播抑制后清成 false，
    // 之后若不再拖拽，任何外部变更（含顺序不同）都应正常同步进 localDirs。
    // 若实现把标志置位后忘记复位，第二次 setProps 会被错误跳过 → 测试失败。
    wrapper = mount(LoadPaths, {
      props: { forcedDirs: [], dirs: DIRS, kind: 'skill' },
    })
    const rows = wrapper.findAll('[draggable="true"]')
    await rows[0].trigger('dragstart', dragOptions())
    await rows[1].trigger('dragenter', dragOptions())
    await rows[1].trigger('dragover', dragOptions())
    await rows[1].trigger('drop', dragOptions())
    await rows[1].trigger('dragend', dragOptions())
    const emittedDirs = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]

    // 第一次广播：顺序一致 → 抑制，DOM 保持 b,a,c
    await wrapper.setProps({ dirs: emittedDirs.map((d) => ({ ...d })) })
    expect(optionalDirOrder(wrapper)).toEqual(['/path/b', '/path/a', '/path/c'])

    // 第二次广播：真实外部重排（顺序与 localDirs 不同）→ 必须同步
    await wrapper.setProps({
      dirs: [
        { path: '/path/c', enabled: true },
        { path: '/path/b', enabled: true },
        { path: '/path/a', enabled: true },
      ],
    })
    expect(optionalDirOrder(wrapper)).toEqual(['/path/c', '/path/b', '/path/a'])
  })

  it('U2-stale: 拖拽 emit 后广播回来一个不同顺序（乱序/外部并发）→ localDirs 同步广播值', async () => {
    // awaitingBroadcast 守卫只在 enabled 顺序一致时跳过；
    // 顺序不同（外部真实变更/网络乱序）时仍要同步，否则组件与 store 永久脱节。
    wrapper = mount(LoadPaths, {
      props: { forcedDirs: [], dirs: DIRS, kind: 'skill' },
    })
    const rows = wrapper.findAll('[draggable="true"]')
    await rows[0].trigger('dragstart', dragOptions())
    await rows[1].trigger('dragenter', dragOptions())
    await rows[1].trigger('dragover', dragOptions())
    await rows[1].trigger('drop', dragOptions())
    await rows[1].trigger('dragend', dragOptions())
    // 拖拽后 localDirs = b,a,c
    expect(optionalDirOrder(wrapper)).toEqual(['/path/b', '/path/a', '/path/c'])

    // 广播回来一个「顺序不同」的值（模拟外部并发改了顺序）→ 必须同步
    await wrapper.setProps({
      dirs: [
        { path: '/path/c', enabled: true },
        { path: '/path/b', enabled: true },
        { path: '/path/a', enabled: true },
      ],
    })
    expect(optionalDirOrder(wrapper)).toEqual(['/path/c', '/path/b', '/path/a'])
  })

  it('U3: 非拖拽状态下外部 dirs 真实变更（新增路径）→ localDirs 同步', async () => {
    wrapper = mount(LoadPaths, {
      props: { forcedDirs: [], dirs: DIRS, kind: 'skill' },
    })
    expect(optionalDirOrder(wrapper)).toEqual(['/path/a', '/path/b', '/path/c'])

    // 外部新增一条路径
    await wrapper.setProps({
      dirs: [
        { path: '/path/a', enabled: true },
        { path: '/path/b', enabled: true },
        { path: '/path/c', enabled: true },
        { path: '/path/d', enabled: true },
      ],
    })
    expect(optionalDirOrder(wrapper)).toEqual(['/path/a', '/path/b', '/path/c', '/path/d'])
  })
})
