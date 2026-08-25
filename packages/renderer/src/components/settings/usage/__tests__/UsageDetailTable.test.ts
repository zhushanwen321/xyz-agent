/**
 * UsageDetailTable 单测（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsageDetailTable.test.ts
 *
 * 覆盖（分组折叠交互 + 合计行，均为用户可见 DOM 断言）：
 *   - 前两组默认展开、第三组默认收起（模型行可见性）
 *   - 点击分组头 → 折叠（模型行消失）；再点 → 展开
 *   - 合计行渲染总 token 与总费用
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageDetailTable from '../UsageDetailTable.vue'
import { newMetrics, accumulate, type AggMetrics } from '../aggregate'

/** 构造单 provider 分组（含 1 个 model 行）。 */
function group(pid: string, input: number, model: string): {
  pid: string
  u: AggMetrics
  models: { model: string; u: AggMetrics }[]
} {
  const u = newMetrics()
  accumulate(u, { ...newMetrics(), input } as AggMetrics)
  return { pid, u, models: [{ model, u }] }
}

function mountTable(groups: ReturnType<typeof group>[], tot: AggMetrics) {
  return mount(UsageDetailTable, { props: { groups, tot } })
}

describe('UsageDetailTable 分组折叠', () => {
  const groups = [
    group('p1', 300, 'm1'),
    group('p2', 200, 'm2'),
    group('p3', 100, 'm3'),
  ]
  const tot = newMetrics()
  accumulate(tot, { ...newMetrics(), input: 600 } as AggMetrics)

  it('前两组默认展开、第三组默认收起', () => {
    const wrapper = mountTable(groups, tot)
    const text = wrapper.text()
    expect(text).toContain('m1')
    expect(text).toContain('m2')
    expect(text).not.toContain('m3')
    // 分组头显示 provider 名与模型计数
    expect(text).toContain('p1')
    expect(text).toContain('p3')
  })

  it('点击第一组分组头 → 折叠（m1 消失）；再点 → 展开', async () => {
    const wrapper = mountTable(groups, tot)
    const header1 = wrapper.findAll('div.cursor-pointer')[0]

    await header1.trigger('click')
    expect(wrapper.text()).not.toContain('m1')
    expect(wrapper.text()).toContain('m2') // 其他组不受影响

    await header1.trigger('click')
    expect(wrapper.text()).toContain('m1')
  })

  it('点击第三组分组头 → 展开（m3 出现）', async () => {
    const wrapper = mountTable(groups, tot)
    const header3 = wrapper.findAll('div.cursor-pointer')[2]

    await header3.trigger('click')
    expect(wrapper.text()).toContain('m3')
  })

  it('合计行渲染总 token（千分位）与总费用', () => {
    const t = newMetrics()
    accumulate(t, { ...newMetrics(), input: 1234, cost: 2.5 } as AggMetrics)
    const wrapper = mountTable([group('p1', 1234, 'm1')], t)
    const text = wrapper.text()
    expect(text).toContain('合计')
    expect(text).toContain('1,234')
    expect(text).toContain('$2.50')
  })
})
