/**
 * UsagePage 过滤/切换交互测试（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsagePage.filters.test.ts
 *
 * 与 UsagePage.test.ts（四态冒烟，stub 图表）互补：本文件全组件真实渲染，
 * 覆盖工具栏交互链路：
 *   - 图例过滤：点击 chip 关闭 provider（chip 消失）、「至少保留一个」保护、reset 恢复
 *   - isolate 单看：点击模型行 → chip 出现；clear / 关其 provider 联动清除
 *   - 指标切换 tokens↔cost（Y 轴刻度 $ 前缀）
 *   - 范围切换 30 天↔全部（窗口外 6 月数据出现）
 *
 * mock 策略：
 *   - vi.mock('@xyz-agent/core/transport/api/domains/usage')（同 UsagePage.test.ts）
 *   - ResizeObserver / clientWidth 全局补丁（UsageDailyChart 真实渲染需要）
 *   - vi.useFakeTimers 固定 2026-08-25：range>0 的日期窗口与 30 天断言确定性
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { UsageRow, UsageStatsResult } from '@xyz-agent/shared'

vi.mock('@xyz-agent/core/transport/api/domains/usage', () => ({
  getUsageStats: vi.fn(),
}))

import UsagePage from '@/components/settings/usage/UsagePage.vue'
import { getUsageStats } from '@xyz-agent/core/transport/api/domains/usage'

const mockedGetUsageStats = vi.mocked(getUsageStats)

/* ── DOM 环境补丁：ResizeObserver + clientWidth（图表真实渲染） ── */
const clientWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 600,
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
  if (clientWidthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDesc)
})

/** 构造单条用量行。 */
function makeRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 300,
    costUSD: 0.01,
    messages: 2,
    date: '2026-08-25',
    provider: 'anthropic',
    model: 'claude-x',
    project: 'demo',
    ...overrides,
  }
}

function makeResult(rows: UsageRow[], sessionCount = rows.length): UsageStatsResult {
  return { rows, sessionCount, skippedLines: 0, scannedAt: Date.now() }
}

/** 三 provider × 三 model 的当日数据（图例过滤 / isolate 联动用）。 */
function threeProviderRows(): UsageRow[] {
  return [
    makeRow({ provider: 'p1', model: 'm1', input: 300 }),
    makeRow({ provider: 'p2', model: 'm2', input: 200 }),
    makeRow({ provider: 'p3', model: 'm3', input: 100 }),
  ]
}

async function mountPage(rows: UsageRow[]) {
  mockedGetUsageStats.mockResolvedValue(makeResult(rows))
  const wrapper = mount(UsagePage)
  await flushPromises()
  return wrapper
}

describe('UsagePage 图例过滤交互', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('点击 legend chip 关闭 provider → chip 消失；「至少保留一个」保护生效', async () => {
    const wrapper = await mountPage(threeProviderRows())

    // 初始三个图例 chip 齐全
    for (const pid of ['p1', 'p2', 'p3']) {
      expect(wrapper.find(`[data-testid="usage-legend-${pid}"]`).exists()).toBe(true)
    }

    // 关闭 p1 → 其 chip 从图例消失
    await wrapper.find('[data-testid="usage-legend-p1"]').trigger('click')
    expect(wrapper.find('[data-testid="usage-legend-p1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="usage-legend-p2"]').exists()).toBe(true)

    // 关闭 p2 后 offProv=2 个 = 3-1 → 第三个 p3 关不掉（至少保留一个）
    await wrapper.find('[data-testid="usage-legend-p2"]').trigger('click')
    expect(wrapper.find('[data-testid="usage-legend-p2"]').exists()).toBe(false)
    await wrapper.find('[data-testid="usage-legend-p3"]').trigger('click')
    // p3 仍在图例中（保护分支 return，未加入 offProv）
    expect(wrapper.find('[data-testid="usage-legend-p3"]').exists()).toBe(true)
  })

  it('关闭 provider 后 reset 按钮出现，点击后图例全部恢复', async () => {
    const wrapper = await mountPage([
      makeRow({ provider: 'p1', model: 'm1' }),
      makeRow({ provider: 'p2', model: 'm2' }),
    ])

    // 无过滤时不显示重置
    expect(wrapper.find('[data-testid="usage-legend-reset"]').exists()).toBe(false)

    await wrapper.find('[data-testid="usage-legend-p1"]').trigger('click')
    expect(wrapper.find('[data-testid="usage-legend-p1"]').exists()).toBe(false)
    const reset = wrapper.find('[data-testid="usage-legend-reset"]')
    expect(reset.exists()).toBe(true)
    expect(reset.text()).toContain('重置')

    await reset.trigger('click')
    expect(wrapper.find('[data-testid="usage-legend-p1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-legend-reset"]').exists()).toBe(false)
  })
})

describe('UsagePage isolate 单看交互', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('点击模型行 → isolate chip 出现；点击 clear → 消失', async () => {
    const wrapper = await mountPage([
      makeRow({ provider: 'p1', model: 'm1' }),
      makeRow({ provider: 'p2', model: 'm2' }),
    ])

    // 点击模型谱第一行（真实 UsageModelRank 渲染，按值降序 m1 在前）
    await wrapper.find('[data-testid="usage-model-m1"]').trigger('click')
    const chip = wrapper.find('[data-testid="usage-isolate-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('m1')

    // 再点同一行 → isolate 取消（emit null）
    await wrapper.find('[data-testid="usage-model-m1"]').trigger('click')
    expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(false)

    // 重新 isolate 后通过 clear 按钮清除
    await wrapper.find('[data-testid="usage-model-m1"]').trigger('click')
    await wrapper.find('[data-testid="usage-isolate-clear"]').trigger('click')
    expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(false)
  })

  it('关闭 isolate 模型所属 provider → isolate 联动清除（chip 消失）', async () => {
    const wrapper = await mountPage([
      makeRow({ provider: 'p1', model: 'm1' }),
      makeRow({ provider: 'p2', model: 'm2' }),
    ])

    await wrapper.find('[data-testid="usage-model-m1"]').trigger('click')
    expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(true)

    // m1 属于 p1：关闭 p1 → isolate 同步清空
    await wrapper.find('[data-testid="usage-legend-p1"]').trigger('click')
    expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(false)
  })
})

describe('UsagePage 指标/范围切换', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('指标切到 cost → 每日图 Y 轴刻度带 $ 前缀', async () => {
    const wrapper = await mountPage([makeRow({ provider: 'p1', model: 'm1', costUSD: 8 })])

    // tokens 指标：刻度无 $ 前缀
    const textsBefore = wrapper.findAll('svg text').map((n) => n.text())
    expect(textsBefore.some((t) => t.startsWith('$'))).toBe(false)

    await wrapper.find('[data-testid="usage-metric-cost"]').trigger('click')
    const textsAfter = wrapper.findAll('svg text').map((n) => n.text())
    // niceMax(8)=10 → 顶部刻度 $10
    expect(textsAfter).toContain('$10')
  })

  it('范围切到全部 → 30 天窗口外的 6 月数据出现月份标签', async () => {
    const wrapper = await mountPage([
      makeRow({ provider: 'p1', model: 'm1', date: '2026-06-15' }),
      makeRow({ provider: 'p1', model: 'm1', date: '2026-08-24' }),
    ])

    // 默认 30 天窗口：6 月数据在窗外，无 6月 标签
    expect(wrapper.findAll('svg text').map((n) => n.text())).not.toContain('6月')

    // 点击「全部」范围按钮
    const rangeAll = wrapper
      .findAll('[data-testid="usage-range-toggle"] button')
      .find((b) => b.text() === '全部')
    expect(rangeAll).toBeDefined()
    await rangeAll!.trigger('click')

    // 全量日期轴：6月 标签出现
    expect(wrapper.findAll('svg text').map((n) => n.text())).toContain('6月')
  })
})
