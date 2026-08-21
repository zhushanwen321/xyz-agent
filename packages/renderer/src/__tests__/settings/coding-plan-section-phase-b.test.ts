/**
 * CodingPlanSection Phase B 测试（B-3 泛化：oauth 凭证态 + used/limit 双轨 + 失败态折叠旧数据）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/settings/coding-plan-section-phase-b.test.ts
 *
 * 三视角：
 *  - 观察者（首屏冒烟）：oauth 就绪/缺失凭证态渲染 gate
 *  - 使用者（黑盒）：「查看上次成功数据」展开交互（失败态下旧值 + 数据截至标注）
 *  - 构建者（白盒）：authKinds/oauthReady/testFailReason props → DOM 分支
 *
 * 组件纯展示（状态在 useQuotaConfigure），直接 mount 传 props，无 transport/pinia 依赖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'
import { CodingPlanSection } from '@xyz-agent/ui/features/settings'

/** 三窗口 fixture：5h 带绝对量（requests）、周仅 pct、月 ∞（pct=null 隐藏） */
const ROW_WITH_ABS: NormalizedQuotaRow = {
  label: 'Kimi Coding Plan',
  wins: [
    { pct: 24, used: 1204, limit: 5000, unit: 'requests', resetSec: 9005 },
    { pct: 41, used: null, limit: null, resetSec: null },
    { pct: null, resetSec: null },
  ],
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** 最小 props（纯展示组件，状态全由父注入） */
function mountSection(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(CodingPlanSection, {
    props: {
      enabled: true,
      cookieInput: '',
      apiKeyInput: '',
      testStatus: 'idle',
      testErrorMsg: '',
      quotaRow: null,
      lastFetchAt: null,
      isCookieAuth: false,
      configuring: false,
      configureErrorMsg: '',
      apiKeySet: false,
      cookieSet: false,
      ...props,
    },
    attachTo: document.body,
  })
}

describe('B-3 oauth 凭证态（按 fetcher.auth 渲染）', () => {
  it('含 oauth 能力且已登录 → 「凭证已就绪（OAuth 登录）」绿色态（首屏冒烟）', async () => {
    wrapper = mountSection({ authKinds: ['api-key', 'oauth'], oauthReady: true })
    await flushPromises()

    const ready = wrapper.find('[data-testid="quota-oauth-ready"]')
    expect(ready.exists()).toBe(true)
    expect(ready.text()).toContain('凭证已就绪（OAuth 登录）')
    // 已就绪时不渲染缺失提示
    expect(wrapper.find('[data-testid="quota-oauth-missing"]').exists()).toBe(false)
  })

  it('含 oauth 能力未登录且无 key → 「请先完成 OAuth 登录」+ 指向凭证区的提示', async () => {
    wrapper = mountSection({ authKinds: ['api-key', 'oauth'], oauthReady: false, apiKeySet: false })
    await flushPromises()

    const missing = wrapper.find('[data-testid="quota-oauth-missing"]')
    expect(missing.exists()).toBe(true)
    expect(missing.text()).toContain('请先完成 OAuth 登录')
    const hint = wrapper.find('[data-testid="quota-oauth-missing-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('凭据')
  })

  it('无 oauth 能力（api-key 类）→ 维持现有 apiKeySet 状态行 + 回退顺序说明', async () => {
    wrapper = mountSection({ authKinds: ['api-key'], apiKeySet: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-oauth-ready"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-oauth-missing"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('API Key 已配置')
    // 回退顺序说明文案
    expect(wrapper.text()).toContain('将依次使用：专属 Key → Provider 凭证')
    expect(wrapper.find('[data-testid="quota-apikey-input"]').exists()).toBe(true)
  })
})

describe('B-3 额度显示双轨（used/limit + pct）', () => {
  it('成功态窗口行显示「已用 N / M 单位 · pct%」（千分位）', async () => {
    wrapper = mountSection({
      testStatus: 'success',
      quotaRow: ROW_WITH_ABS,
      lastFetchAt: Date.now() - 60_000,
    })
    await flushPromises()

    const windows = wrapper.find('[data-testid="quota-result-windows"]')
    expect(windows.exists()).toBe(true)
    const text = windows.text()
    expect(text).toContain('已用 1,204 / 5,000')
    expect(text).toContain('次')
    expect(text).toContain('24%')
    // 无绝对量的窗口维持 pct 单轨
    expect(text).toContain('41%')
  })

  it('无绝对量数据（旧 fetcher 输出）→ 维持 pct 单轨不显示「已用」', async () => {
    wrapper = mountSection({
      testStatus: 'success',
      quotaRow: {
        label: 'Zhipu Plan',
        wins: [
          { pct: 55, resetSec: 100 },
          { pct: null, resetSec: null },
          { pct: null, resetSec: null },
        ],
      },
    })
    await flushPromises()

    const windows = wrapper.find('[data-testid="quota-result-windows"]')
    expect(windows.exists()).toBe(true)
    expect(windows.text()).toContain('55%')
    expect(windows.text()).not.toContain('已用')
  })
})

describe('B-3 失败态（A2-4 reason 透传）+ 「查看上次成功数据」折叠', () => {
  it('reason=unauthorized → 失败条显示恢复指引文案；初始旧数据不可见，展开后显示旧值 + 「数据截至」', async () => {
    const lastFetchAt = Date.now() - 3_600_000
    wrapper = mountSection({
      testStatus: 'error',
      testFailReason: 'unauthorized',
      testErrorMsg: '',
      quotaRow: ROW_WITH_ABS, // 旧缓存保留在内存（useQuotaConfigure 失败不清）
      lastFetchAt,
    })
    await flushPromises()

    // 失败条：unauthorized 专属恢复指引
    const errorBox = wrapper.find('[data-testid="quota-error"]')
    expect(errorBox.exists()).toBe(true)
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain('凭证可能过期')
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain('重试')
    // 成功态数据面板整体替换（不可见）
    expect(wrapper.find('[data-testid="quota-result"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quota-last-success"]').exists()).toBe(false)

    // 展开「查看上次成功数据」→ 旧值 + 数据截至标注
    await wrapper.find('[data-testid="quota-toggle-last-success"]').trigger('click')
    await flushPromises()
    const stale = wrapper.find('[data-testid="quota-last-success"]')
    expect(stale.exists()).toBe(true)
    expect(stale.text()).toContain('已用 1,204 / 5,000')
    expect(stale.text()).toContain('数据截至')
  })

  it('reason=network → 失败条显示网络文案（与 unauthorized 可区分）', async () => {
    wrapper = mountSection({ testStatus: 'error', testFailReason: 'network', testErrorMsg: '' })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain('网络异常')
    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).not.toContain('凭证可能过期')
  })

  it('无 reason（配置错误等）→ 回退 testErrorMsg 文案；无旧数据时不渲染展开入口', async () => {
    wrapper = mountSection({ testStatus: 'error', testFailReason: null, testErrorMsg: 'boom' })
    await flushPromises()

    expect(wrapper.find('[data-testid="quota-error-msg"]').text()).toContain('boom')
    expect(wrapper.find('[data-testid="quota-toggle-last-success"]').exists()).toBe(false)
  })
})
