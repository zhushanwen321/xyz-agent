/**
 * UsageModelRank 单测（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsageModelRank.test.ts
 *
 * 覆盖（排名渲染 + isolate 单看交互）：
 *   - 按 metric 值降序排名（01/02 序号 + provider/model 文本）
 *   - 点击行 → emit update:isolate(该 model)；isolate 态再点同行 → emit null
 *   - isolate 行高亮 accent 背景
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageModelRank from '../UsageModelRank.vue'
import { newMetrics, accumulate, type AggMetrics } from '../aggregate'

function metrics(input: number, cost = 0): AggMetrics {
  const u = newMetrics()
  accumulate(u, { ...newMetrics(), input, cost } as AggMetrics)
  return u
}

function mountRank(perModel: Record<string, AggMetrics>, isolate: string | null = null) {
  return mount(UsageModelRank, {
    props: {
      perModel,
      metric: 'tokens' as const,
      isolate,
      modelProviderMap: { big: 'p1', small: 'p2' },
    },
  })
}

describe('UsageModelRank 排名渲染', () => {
  it('按 token 降序渲染 01/02 序号与 provider/model 文本', () => {
    const wrapper = mountRank({ small: metrics(100), big: metrics(900) })
    const text = wrapper.text()
    expect(text).toContain('01')
    expect(text).toContain('02')
    // 排名靠前的 big 模型整行在前
    expect(text.indexOf('big')).toBeLessThan(text.indexOf('small'))
    expect(text).toContain('p1/big')
    expect(text).toContain('p2/small')
  })
})

describe('UsageModelRank isolate 单看交互', () => {
  it('点击行 → emit update:isolate(该 model)', async () => {
    const wrapper = mountRank({ big: metrics(900) })
    await wrapper.find('[data-testid="usage-model-big"]').trigger('click')
    expect(wrapper.emitted('update:isolate')).toEqual([['big']])
  })

  it('isolate 态再点同一行 → emit update:isolate(null)，行高亮 accent', async () => {
    const wrapper = mountRank({ big: metrics(900) }, 'big')
    const row = wrapper.find('[data-testid="usage-model-big"]')
    // 选中行 accent 高亮
    expect(row.classes()).toContain('bg-[var(--accent-soft)]')

    await row.trigger('click')
    expect(wrapper.emitted('update:isolate')).toEqual([[null]])
  })
})
