/**
 * TurnRail 组件测试（TC-w3-1 到 TC-w3-8，w3 wave）。
 *
 * 覆盖 IF4 契约：
 * - 渲染：turns=[] 不渲染；否则每个 turn 一个 rail-node 含 dot+摘要+chev
 * - 交互：点节点文本区 emit('jump')；点 chev emit('toggle')（stopPropagation 隔离）
 * - 状态：sessionActive 时 chev 全禁用；activeTurnIndex 高亮 active 节点；dot 反映状态
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/TurnRail.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TurnRail from '../TurnRail.vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'

/**
 * 构造 rail 测试用 turn fixture。
 * 用 as MessageTurn 断言绕开完整 Message 字段需求（测试 fixture 允许，规范豁免）。
 */
function makeRailTurn(
  idx: number,
  opts: { userText?: string; failed?: boolean; userNull?: boolean } = {},
): MessageTurn {
  return {
    index: idx,
    user: opts.userNull
      ? null
      : ({
          id: `u${idx}`,
          role: 'user',
          content: opts.userText ?? `turn ${idx}`,
          status: 'done',
        } as Message),
    assistants: [
      {
        id: `a${idx}`,
        role: 'assistant',
        content: '...',
        status: 'done',
        toolCalls: opts.failed
          ? [
              {
                id: `t${idx}`,
                toolName: 'fail',
                input: {},
                status: 'error',
                startTime: 0,
              },
            ]
          : [],
      } as Message,
    ],
    isStreaming: false,
    hasFoldable: opts.failed ?? false,
  } as MessageTurn
}

/** 默认 mount props（3 turn 场景），测试用例可 override。 */
function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    turns: [makeRailTurn(0), makeRailTurn(1), makeRailTurn(2)],
    activeTurnIndex: 0,
    sessionActive: false,
    ...overrides,
  }
}

describe('TurnRail (IF4)', () => {
  it('TC-w3-1: turns 为空时不渲染 rail', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ turns: [] }) })
    expect(wrapper.find('[data-testid="turn-rail"]').exists()).toBe(false)
  })

  it('TC-w3-2: 3 turns → 渲染 3 个 rail-node，每个含 dot + 摘要 + toggle', () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    expect(nodes).toHaveLength(3)
    for (const node of nodes) {
      expect(node.find('[data-testid="rail-dot"]').exists()).toBe(true)
      expect(node.find('[data-testid="rail-toggle"]').exists()).toBe(true)
      // 摘要文本应非空（默认 fixture 用 "turn N"）
      expect(node.text().length).toBeGreaterThan(0)
    }
  })

  it('TC-w3-3: 点 rail-node[1] 文本区 → emit jump(1)，不 emit toggle', async () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    // 点节点本身（文本区，非 toggle）—— trigger click on the node div
    await nodes[1].trigger('click')
    expect(wrapper.emitted('jump')).toBeTruthy()
    expect(wrapper.emitted('jump')![0]).toEqual([1])
    expect(wrapper.emitted('toggle')).toBeFalsy()
  })

  it('TC-w3-4: 点 rail-node[1] 的 toggle → emit toggle(1)，不 emit jump（stopPropagation）', async () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    await toggles[1].trigger('click')
    expect(wrapper.emitted('toggle')).toBeTruthy()
    expect(wrapper.emitted('toggle')![0]).toEqual([1])
    // toggle click 用 .stop 阻断冒泡，不应触发 rail-node 的 jump
    expect(wrapper.emitted('jump')).toBeFalsy()
  })

  it('TC-w3-5: sessionActive=true → 所有 rail-toggle 禁用', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ sessionActive: true }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    expect(toggles).toHaveLength(3)
    for (const toggle of toggles) {
      // Button disabled 渲染为 button[disabled] 或 component 属性
      const button = toggle.element as HTMLElement
      // vue test-utils + Button.vue：disabled 属性会反映到 DOM
      expect(button.hasAttribute('disabled') || (button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('TC-w3-7: activeTurnIndex=1 → rail-node[1] 含 active 类，rail-node[0] 不含', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 1 }) })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    expect(nodes[1].classes()).toContain('active')
    expect(nodes[0].classes()).not.toContain('active')
  })

  it('TC-w3-8: dot 状态反映 turn（done=ok 绿 / failed=fail 红 / active=active 蓝）', () => {
    // turn0: done（无失败）→ ok；turn1: failed → fail；turn2: active（sessionActive + 当前激活）→ active
    const turns = [
      makeRailTurn(0, { failed: false }),
      makeRailTurn(1, { failed: true }),
      makeRailTurn(2, { failed: false }),
    ]
    const wrapper = mount(TurnRail, {
      props: defaultProps({ turns, activeTurnIndex: 2, sessionActive: true }),
    })
    const dots = wrapper.findAll('[data-testid="rail-dot"]')
    // done turn → ok 类
    expect(dots[0].classes()).toContain('ok')
    expect(dots[0].classes()).toContain('bg-success')
    // failed turn → fail 类
    expect(dots[1].classes()).toContain('fail')
    expect(dots[1].classes()).toContain('bg-danger')
    // active turn → active 类
    expect(dots[2].classes()).toContain('active')
    expect(dots[2].classes()).toContain('bg-accent')
  })

  it('TC-w3-9: toggle 默认 opacity-0（hover 浮出）；非 active 节点非 hover 时隐藏', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 0 }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    expect(toggles).toHaveLength(3)
    // idx=1 非 active：toggle 含 opacity-0 class（默认隐藏，hover 才浮出）
    expect(toggles[1].classes()).toContain('opacity-0')
  })

  it('TC-w3-10: active 节点的 toggle 常驻可见（!opacity-100，非 hover 也能看到）', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 1 }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    // idx=1 是 active：toggle 含 !opacity-100（常驻可见，用户决策）
    expect(toggles[1].classes()).toContain('!opacity-100')
    // idx=0 非 active：仍是 opacity-0
    expect(toggles[0].classes()).toContain('opacity-0')
  })

  it('TC-w3-11: expandedTurns 含 turn index 1 时，idx=1 的 toggle data-expanded=true，其余 false', () => {
    const wrapper = mount(TurnRail, {
      props: defaultProps({ expandedTurns: new Set([1]) }),
    })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    // turns fixture：makeRailTurn(0/1/2) → turn.index = 0/1/2
    // expandedTurns={1} → idx=1 展开态（ChevronUp），idx=0/2 折叠态（ChevronDown）
    expect(toggles[0].attributes('data-expanded')).toBe('false')
    expect(toggles[1].attributes('data-expanded')).toBe('true')
    expect(toggles[2].attributes('data-expanded')).toBe('false')
  })

  it('TC-w3-12: 未传 expandedTurns 时，所有 toggle data-expanded=false（默认折叠态）', () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    for (const toggle of toggles) {
      expect(toggle.attributes('data-expanded')).toBe('false')
    }
  })
})
